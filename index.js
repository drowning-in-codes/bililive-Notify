const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const axios = require('axios');
const qrcode = require('qrcode');

let mainWindow;
let loginWindow;
let followListWindow;
let tray = null;
let isQuitting = false;
let closePromptVisible = false;
let cookiePath = path.join(app.getPath('userData'), 'cookies.json');
let monitorListPath = path.join(app.getPath('userData'), 'monitor-list.json');
let appSettingsPath = path.join(app.getPath('userData'), 'app-settings.json');
let apiCachePath = path.join(app.getPath('userData'), 'api-cache.json');
const isTestEnv = process.env.NODE_ENV === 'test';

const CACHE_TTL = {
    myInfo: 30 * 60 * 1000,
    followGroups: 10 * 60 * 1000,
    liveFollowing: 60 * 1000,
    searchUsers: 10 * 60 * 1000,
    userProfile: 24 * 60 * 60 * 1000
};

const DEFAULT_NOTIFY_POLL_INTERVAL_SEC = 60;
const MIN_NOTIFY_POLL_INTERVAL_SEC = 10;
const MAX_NOTIFY_POLL_INTERVAL_SEC = 3600;
let prevCpuTimes = null;

function snapshotCpuTimes() {
    const cpus = os.cpus() || [];
    return cpus.map((cpu) => {
        const times = cpu.times || {};
        const idle = Number(times.idle || 0);
        const total = Number(times.user || 0)
            + Number(times.nice || 0)
            + Number(times.sys || 0)
            + Number(times.irq || 0)
            + idle;
        return { idle, total };
    });
}

function getCpuUsagePercent() {
    const current = snapshotCpuTimes();
    if (!current.length) {
        return 0;
    }

    if (!Array.isArray(prevCpuTimes) || prevCpuTimes.length !== current.length) {
        prevCpuTimes = current;
        return 0;
    }

    let totalDelta = 0;
    let idleDelta = 0;
    for (let i = 0; i < current.length; i += 1) {
        const prev = prevCpuTimes[i];
        const cur = current[i];
        totalDelta += Math.max(0, cur.total - prev.total);
        idleDelta += Math.max(0, cur.idle - prev.idle);
    }

    prevCpuTimes = current;
    if (totalDelta <= 0) {
        return 0;
    }

    const usedRatio = 1 - (idleDelta / totalDelta);
    return Math.max(0, Math.min(100, usedRatio * 100));
}

function loadAppSettings() {
    if (!fs.existsSync(appSettingsPath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(appSettingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
        return {};
    } catch (error) {
        console.error('读取应用设置失败:', error);
        return {};
    }
}

function saveAppSettings(settings) {
    fs.writeFileSync(appSettingsPath, JSON.stringify(settings, null, 2));
}

function loadApiCache() {
    if (!fs.existsSync(apiCachePath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(apiCachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
        return {};
    } catch (error) {
        console.error('读取API缓存失败:', error);
        return {};
    }
}

function saveApiCache(cache) {
    fs.writeFileSync(apiCachePath, JSON.stringify(cache, null, 2));
}

function getCacheKey(cookieHeader, suffix) {
    const digest = crypto.createHash('sha1').update(String(cookieHeader || '')).digest('hex');
    return `${digest}:${suffix}`;
}

function getCachedItem(key) {
    const cache = loadApiCache();
    const item = cache[key];
    if (!item || typeof item !== 'object') {
        return null;
    }

    if (typeof item.expiresAt !== 'number' || item.expiresAt <= Date.now()) {
        delete cache[key];
        saveApiCache(cache);
        return null;
    }

    return item.data ?? null;
}

function setCachedItem(key, data, ttlMs) {
    const cache = loadApiCache();
    cache[key] = {
        data,
        expiresAt: Date.now() + ttlMs
    };
    saveApiCache(cache);
}

function removeCachedItem(key) {
    const cache = loadApiCache();
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
        delete cache[key];
        saveApiCache(cache);
    }
}

async function cachedFetch(key, ttlMs, fetcher) {
    const cached = getCachedItem(key);
    if (cached !== null && cached !== undefined) {
        return cached;
    }

    const data = await fetcher();
    setCachedItem(key, data, ttlMs);
    return data;
}

function getCloseActionPreference() {
    const settings = loadAppSettings();
    const value = settings?.closeAction;
    if (value === 'tray' || value === 'exit') {
        return value;
    }
    return null;
}

function setCloseActionPreference(action) {
    if (action !== 'tray' && action !== 'exit') {
        return;
    }

    const settings = loadAppSettings();
    settings.closeAction = action;
    saveAppSettings(settings);
}

function normalizeNotifyPollIntervalSec(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return DEFAULT_NOTIFY_POLL_INTERVAL_SEC;
    }

    const rounded = Math.round(num);
    if (rounded < MIN_NOTIFY_POLL_INTERVAL_SEC) {
        return MIN_NOTIFY_POLL_INTERVAL_SEC;
    }
    if (rounded > MAX_NOTIFY_POLL_INTERVAL_SEC) {
        return MAX_NOTIFY_POLL_INTERVAL_SEC;
    }
    return rounded;
}

function getNotifySettings() {
    const settings = loadAppSettings();
    return {
        pollIntervalSec: normalizeNotifyPollIntervalSec(settings?.notify?.pollIntervalSec)
    };
}

function setNotifySettings(input = {}) {
    const settings = loadAppSettings();
    const nextNotify = {
        ...(settings.notify || {}),
        pollIntervalSec: normalizeNotifyPollIntervalSec(input.pollIntervalSec)
    };
    settings.notify = nextNotify;
    saveAppSettings(settings);

    return {
        pollIntervalSec: nextNotify.pollIntervalSec
    };
}

function getUiSettings() {
    const settings = loadAppSettings();
    return {
        systemMetricsVisible: settings?.ui?.systemMetricsVisible !== false
    };
}

function setUiSettings(input = {}) {
    const settings = loadAppSettings();
    settings.ui = {
        ...(settings.ui || {}),
        systemMetricsVisible: input.systemMetricsVisible !== false
    };
    saveAppSettings(settings);

    return {
        systemMetricsVisible: settings.ui.systemMetricsVisible
    };
}

function createTrayIcon() {
    const trayIconPath = path.join(__dirname, 'public', 'tray.ico');
    const fileIcon = nativeImage.createFromPath(trayIconPath);
    if (!fileIcon.isEmpty()) {
        return fileIcon;
    }

    const svg = `
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="7" fill="#00A1D6"/>
      <path d="M5 5.5h2.8c1.4 0 2.2.8 2.2 2s-.8 2-2.2 2H6.4V12H5V5.5zm1.4 2.8h1.2c.7 0 1.1-.3 1.1-.8s-.4-.8-1.1-.8H6.4v1.6z" fill="#fff"/>
    </svg>`;

    return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow();
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    if (!mainWindow.isVisible()) {
        mainWindow.show();
    }

    mainWindow.focus();
}

function ensureTray() {
    if (tray) {
        return;
    }

    tray = new Tray(createTrayIcon());
    tray.setToolTip('B站直播监听');
    tray.setContextMenu(
        Menu.buildFromTemplate([
            {
                label: '显示主窗口',
                click: () => {
                    showMainWindow();
                }
            },
            {
                label: '退出',
                click: () => {
                    isQuitting = true;
                    app.quit();
                }
            }
        ])
    );

    tray.on('double-click', () => {
        showMainWindow();
    });
}

function hideMainWindowToTray() {
    ensureTray();
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
    }
}

function promptCloseAction() {
    if (!mainWindow || mainWindow.isDestroyed() || closePromptVisible) {
        return;
    }

    closePromptVisible = true;
    dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: '关闭窗口',
        message: '关闭主窗口时要执行什么？',
        detail: '可选择缩小到右下角托盘，或直接关闭应用。',
        buttons: ['缩小到托盘', '直接关闭'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        checkboxLabel: '记住我的选择（下次不再提示）',
        checkboxChecked: false
    }).then(({ response, checkboxChecked }) => {
        closePromptVisible = false;

        const action = response === 1 ? 'exit' : 'tray';
        if (checkboxChecked) {
            setCloseActionPreference(action);
        }

        if (action === 'tray') {
            hideMainWindowToTray();
            return;
        }

        isQuitting = true;
        app.quit();
    }).catch((error) => {
        closePromptVisible = false;
        console.error('关闭确认弹窗失败:', error);
    });
}

function handleMainWindowClose(event) {
    if (isQuitting) {
        return;
    }

    const preference = getCloseActionPreference();
    if (preference === 'tray') {
        event.preventDefault();
        hideMainWindowToTray();
        return;
    }

    if (preference === 'exit') {
        isQuitting = true;
        return;
    }

    event.preventDefault();
    promptCloseAction();
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        minWidth: 800,
        minHeight: 800,
        icon: path.join(__dirname, 'icon.ico'),
        // frame: false,
        resizable: true,
        titleBarStyle: 'hidden',
        // expose window controls in Windows/Linux
        ...(process.platform !== 'darwin' ? { titleBarOverlay: true } : {}),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile('index.html');

    if (isTestEnv) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    mainWindow.on('close', handleMainWindowClose);

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
}

function createLoginWindow() {
    loginWindow = new BrowserWindow({
        width: 450,
        height: 650,
        minWidth: 450,
        minHeight: 650,
        icon: path.join(__dirname, 'icon.ico'),
        // frame: false,
        titleBarStyle: 'hidden',
        // expose window controls in Windows/Linux
        ...(process.platform !== 'darwin' ? { titleBarOverlay: true } : {}),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        resizable: false
    });

    loginWindow.loadFile('login.html');

    if (isTestEnv) {
        loginWindow.webContents.openDevTools({ mode: 'detach' });
    }

    loginWindow.on('closed', function () {
        loginWindow = null;
    });
}

function createFollowListWindow() {
    if (followListWindow && !followListWindow.isDestroyed()) {
        followListWindow.focus();
        return;
    }

    followListWindow = new BrowserWindow({
        width: 960,
        height: 760,
        minWidth: 760,
        minHeight: 620,
        titleBarStyle: 'hidden',
        ...(process.platform !== 'darwin' ? { titleBarOverlay: true } : {}),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    followListWindow.loadFile('follow-list.html');

    if (isTestEnv) {
        followListWindow.webContents.openDevTools({ mode: 'detach' });
    }

    followListWindow.on('closed', function () {
        followListWindow = null;
    });
}

function saveCookies(cookies) {
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
}

function loadCookies() {
    if (fs.existsSync(cookiePath)) {
        try {
            return JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
        } catch (error) {
            console.error('读取cookie失败:', error);
            return null;
        }
    }
    return null;
}

function loadMonitorStore() {
    if (!fs.existsSync(monitorListPath)) {
        return {};
    }

    try {
        const raw = fs.readFileSync(monitorListPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
        return {};
    } catch (error) {
        console.error('读取监听列表失败:', error);
        return {};
    }
}

function saveMonitorStore(store) {
    fs.writeFileSync(monitorListPath, JSON.stringify(store, null, 2));
}

function checkLoginStatus() {
    const cookies = loadCookies();
    if (cookies) {
        // 检查cookies是否有效
        return true;
    }
    return false;
}

function getCookieHeader() {
    const cookies = loadCookies();
    if (!cookies) {
        return '';
    }

    if (Array.isArray(cookies)) {
        return cookies
            .map((item) => String(item).split(';')[0].trim())
            .filter(Boolean)
            .join('; ');
    }

    if (typeof cookies === 'string') {
        return cookies
            .split(';')
            .map((item) => item.trim())
            .filter(Boolean)
            .join('; ');
    }

    return '';
}

function getCsrfToken() {
    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return '';
    }

    const match = cookieHeader.match(/(?:^|;\s*)bili_jct=([^;]+)/);
    return match ? match[1] : '';
}

function isFollowed(attribute) {
    return attribute === 2 || attribute === 6;
}

function normalizeAvatarUrl(url) {
    const value = String(url || '').trim();
    if (!value) {
        return '';
    }

    if (value.startsWith('//')) {
        return `https:${value}`;
    }

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    return value;
}

function normalizeLevel(levelInfo) {
    if (typeof levelInfo === 'number') {
        return levelInfo;
    }

    if (levelInfo && typeof levelInfo === 'object') {
        const value = levelInfo.current_level;
        if (typeof value === 'number') {
            return value;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : '-';
    }

    const parsed = Number(levelInfo);
    return Number.isFinite(parsed) ? parsed : '-';
}

async function getUserProfileByMid(mid, headers = {}) {
    const targetMid = Number(mid || 0);
    if (!targetMid) {
        throw new Error('无效的用户MID');
    }

    const cacheKey = getCacheKey(headers.Cookie, `user-profile:${targetMid}`);
    return cachedFetch(cacheKey, CACHE_TTL.userProfile, async () => {
        const response = await axios.get('https://api.bilibili.com/x/web-interface/card', {
            headers: {
                ...headers,
                Referer: 'https://www.bilibili.com'
            },
            params: { mid: targetMid }
        });

        if (response.data.code !== 0) {
            throw new Error(response.data.message || `获取用户 ${targetMid} 信息失败`);
        }

        const data = response.data.data || {};
        const card = data.card || {};

        return {
            mid: targetMid,
            name: card.name || '-',
            avatar: normalizeAvatarUrl(card.face),
            level: normalizeLevel(data.level_info || card.level_info)
        };
    });
}

async function enrichMembersWithProfiles(members, headers) {
    const list = Array.isArray(members) ? members : [];
    const uniqueMids = [...new Set(list.map((item) => Number(item?.mid || 0)).filter(Boolean))];
    const profileMap = new Map();

    await Promise.all(uniqueMids.map(async (mid) => {
        try {
            const profile = await getUserProfileByMid(mid, headers);
            profileMap.set(mid, profile);
        } catch (error) {
            profileMap.set(mid, {
                mid,
                name: '-',
                avatar: '',
                level: '-'
            });
        }
    }));

    return list.map((member) => {
        const mid = Number(member?.mid || 0);
        const profile = profileMap.get(mid) || {};
        return {
            ...member,
            name: member.name || profile.name || '-',
            avatar: normalizeAvatarUrl(member.avatar || profile.avatar),
            level: member.level ?? profile.level ?? '-'
        };
    });
}

async function getCurrentUserId(headers) {
    const navResponse = await axios.get('https://api.bilibili.com/x/web-interface/nav', {
        headers
    });

    if (navResponse.data.code !== 0) {
        throw new Error(navResponse.data.message || '获取当前用户失败');
    }

    const mid = Number(navResponse.data?.data?.mid || 0);
    if (!mid) {
        throw new Error('当前用户MID无效');
    }

    return mid;
}

function normalizeFollowMember(member) {
    return {
        mid: member.mid,
        name: member.uname || '-',
        avatar: normalizeAvatarUrl(member.face),
        liveStatus: member.live?.live_status === 1 ? 'live' : 'offline',
        liveUrl: member.live?.jump_url || ''
    };
}

async function getGroupMembers(tagid, count, headers) {
    const pageSize = 50;
    const pageCount = Math.max(1, Math.ceil((count || 0) / pageSize));
    const members = [];

    for (let pn = 1; pn <= pageCount; pn++) {
        const response = await axios.get('https://api.bilibili.com/x/relation/tag', {
            headers,
            params: {
                tagid,
                ps: pageSize,
                pn,
                order_type: ''
            }
        });

        if (response.data.code !== 0) {
            throw new Error(response.data.message || `获取分组 ${tagid} 失败`);
        }

        const pageMembers = Array.isArray(response.data.data) ? response.data.data : [];
        members.push(...pageMembers.map(normalizeFollowMember));

        if (pageMembers.length < pageSize) {
            break;
        }
    }

    return members;
}

app.on('ready', function () {
    if (checkLoginStatus()) {
        createMainWindow();
    } else {
        createLoginWindow();
    }
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        if (checkLoginStatus()) {
            createMainWindow();
        } else {
            createLoginWindow();
        }
    }
});

// 登录相关IPC处理
ipcMain.handle('generate-qr-code', async () => {
    try {
        const response = await axios.get('https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
        if (response.data.code === 0) {
            const qrCodeUrl = response.data.data.url;
            const qrcodeKey = response.data.data.qrcode_key;

            // 生成二维码
            const qrCodeDataUrl = await qrcode.toDataURL(qrCodeUrl);

            return { success: true, qrCodeDataUrl, qrcodeKey };
        } else {
            return { success: false, message: '生成二维码失败' };
        }
    } catch (error) {
        console.error('生成二维码失败:', error);
        return { success: false, message: '网络错误' };
    }
});

ipcMain.handle('poll-qr-login', async (event, qrcodeKey) => {
    try {
        const response = await axios.get('https://passport.bilibili.com/x/passport-login/web/qrcode/poll', {
            params: { qrcode_key: qrcodeKey },
            withCredentials: true
        });

        if (response.data.code === 0) {
            const data = response.data.data;

            if (data.code === 0) {
                // 登录成功，获取cookie
                const cookies = response.headers['set-cookie'] || [];
                saveCookies(cookies);
                return { success: true, status: 'success' };
            } else if (data.code === 86090) {
                return { success: true, status: 'scanned' };
            } else if (data.code === 86101) {
                return { success: true, status: 'waiting' };
            } else if (data.code === 86038) {
                return { success: true, status: 'expired' };
            }
        }
        return { success: false, message: '轮询失败' };
    } catch (error) {
        console.error('轮询失败:', error);
        return { success: false, message: '网络错误' };
    }
});

ipcMain.handle('login-with-sessdata', async (event, sessdata) => {
    try {
        // 验证SESSDATA是否有效
        const response = await axios.get('https://api.bilibili.com/x/web-interface/nav', {
            headers: {
                Cookie: `SESSDATA=${sessdata}`
            }
        });

        if (response.data.code === 0) {
            // SESSDATA有效，保存cookie
            saveCookies([`SESSDATA=${sessdata}`]);
            return { success: true };
        } else {
            return { success: false, message: 'SESSDATA无效' };
        }
    } catch (error) {
        console.error('验证SESSDATA失败:', error);
        return { success: false, message: '网络错误' };
    }
});

ipcMain.handle('get-login-status', () => {
    return checkLoginStatus();
});

ipcMain.handle('get-notify-settings', () => {
    return {
        success: true,
        data: getNotifySettings()
    };
});

ipcMain.handle('set-notify-settings', (event, settings) => {
    try {
        return {
            success: true,
            data: setNotifySettings(settings || {})
        };
    } catch (error) {
        console.error('保存通知设置失败:', error);
        return {
            success: false,
            message: '保存通知设置失败'
        };
    }
});

ipcMain.handle('get-my-info', async () => {
    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return { success: false, message: '未登录或Cookie无效' };
    }

    try {
        const cacheKey = getCacheKey(cookieHeader, 'my-info');
        const data = await cachedFetch(cacheKey, CACHE_TTL.myInfo, async () => {
            const headers = {
                Cookie: cookieHeader,
                Referer: 'https://www.bilibili.com'
            };

            const [accountResponse, navResponse] = await Promise.all([
                axios.get('https://api.bilibili.com/x/member/web/account', { headers }),
                axios.get('https://api.bilibili.com/x/web-interface/nav', { headers })
            ]);

            if (accountResponse.data.code !== 0) {
                throw new Error(accountResponse.data.message || '获取用户信息失败');
            }

            if (navResponse.data.code !== 0) {
                throw new Error(navResponse.data.message || '获取硬币信息失败');
            }

            const accountData = accountResponse.data.data || {};
            const navData = navResponse.data.data || {};
            const isVip =
                Number(navData.vipStatus || navData.vip_status || accountData?.vip?.status || 0) === 1 ||
                Number(navData.vipType || navData.vip_type || accountData?.vip?.type || 0) > 0;

            return {
                nickname: accountData.uname || navData.uname || '-',
                level: navData.level_info?.current_level || accountData.rank || '-',
                coins: typeof navData.money === 'number' ? navData.money : '-',
                sex: accountData.sex || navData.sex || '-',
                avatar: normalizeAvatarUrl(navData.face),
                isVip
            };
        });

        return { success: true, data };
    } catch (error) {
        console.error('获取用户信息失败:', error);
        return { success: false, message: '网络错误，获取用户信息失败' };
    }
});

ipcMain.on('login-success', () => {
    if (loginWindow) {
        loginWindow.close();
    }
    createMainWindow();
});

// 窗口控制IPC处理
ipcMain.on('minimize-window', () => {
    if (mainWindow) {
        mainWindow.minimize();
    }
});

ipcMain.on('maximize-window', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});

ipcMain.on('close-window', () => {
    if (mainWindow) {
        mainWindow.close();
    }
});

ipcMain.on('close-login-window', () => {
    if (loginWindow) {
        loginWindow.close();
    }
});

ipcMain.handle('get-follow-groups', async () => {
    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return { success: false, message: '未登录或Cookie无效' };
    }

    try {
        const cacheKey = getCacheKey(cookieHeader, 'follow-groups');
        const data = await cachedFetch(cacheKey, CACHE_TTL.followGroups, async () => {
            const headers = {
                Cookie: cookieHeader,
                Referer: 'https://www.bilibili.com'
            };

            const tagsResponse = await axios.get('https://api.bilibili.com/x/relation/tags', { headers });
            if (tagsResponse.data.code !== 0) {
                throw new Error(tagsResponse.data.message || '获取关注分组失败');
            }

            const tags = Array.isArray(tagsResponse.data.data) ? tagsResponse.data.data : [];
            const specialTag = tags.find((tag) => Number(tag.tagid) === -10) || {
                tagid: -10,
                name: '特别关注',
                count: 0
            };
            const otherTags = tags.filter((tag) => Number(tag.tagid) !== -10);

            const [specialMembersRaw, otherGroupsRaw] = await Promise.all([
                getGroupMembers(Number(specialTag.tagid), Number(specialTag.count || 0), headers),
                Promise.all(
                    otherTags.map(async (tag) => {
                        const members = await getGroupMembers(Number(tag.tagid), Number(tag.count || 0), headers);
                        return {
                            tagid: Number(tag.tagid),
                            name: tag.name || `分组${tag.tagid}`,
                            count: members.length,
                            members
                        };
                    })
                )
            ]);

            const specialMembers = await enrichMembersWithProfiles(specialMembersRaw, headers);
            const otherGroups = await Promise.all(
                otherGroupsRaw.map(async (group) => ({
                    ...group,
                    members: await enrichMembersWithProfiles(group.members, headers)
                }))
            );

            return {
                special: {
                    tagid: Number(specialTag.tagid),
                    name: specialTag.name || '特别关注',
                    count: specialMembers.length,
                    members: specialMembers
                },
                otherGroups
            };
        });

        return { success: true, data };
    } catch (error) {
        console.error('获取关注分组失败:', error);
        return { success: false, message: '网络错误，获取关注分组失败' };
    }
});

ipcMain.handle('search-users-by-name', async (event, keyword) => {
    const kw = String(keyword || '').trim();
    if (!kw) {
        return { success: false, message: '请输入用户名' };
    }

    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return { success: false, message: '未登录或Cookie无效' };
    }

    try {
        const cacheKey = getCacheKey(cookieHeader, `search-users:${kw.toLowerCase()}`);
        const data = await cachedFetch(cacheKey, CACHE_TTL.searchUsers, async () => {
            const headers = {
                Cookie: cookieHeader,
                Referer: 'https://www.bilibili.com',
                'User-Agent': 'Mozilla/5.0'
            };

            const searchResponse = await axios.get('https://api.bilibili.com/x/web-interface/search/type', {
                headers,
                params: {
                    search_type: 'bili_user',
                    keyword: kw,
                    page: 1,
                    page_size: 10
                }
            });

            if (searchResponse.data.code !== 0) {
                throw new Error(searchResponse.data.message || '搜索用户失败');
            }

            const userList = Array.isArray(searchResponse.data?.data?.result) ? searchResponse.data.data.result : [];
            const normalized = userList.map((item) => {
                const name = String(item.uname || '').replace(/<[^>]+>/g, '') || '-';
                return {
                    mid: Number(item.mid),
                    name,
                    avatar: normalizeAvatarUrl(item.upic),
                    level: item.level ?? '-'
                };
            });

            const usersWithRelation = await Promise.all(
                normalized.map(async (user) => {
                    try {
                        const relationResponse = await axios.get('https://api.bilibili.com/x/relation', {
                            headers,
                            params: { fid: user.mid }
                        });
                        const attribute = relationResponse.data?.data?.attribute;
                        return {
                            ...user,
                            followed: isFollowed(attribute)
                        };
                    } catch (error) {
                        return {
                            ...user,
                            followed: false
                        };
                    }
                })
            );

            return usersWithRelation;
        });

        return { success: true, data };
    } catch (error) {
        console.error('搜索用户失败:', error);
        return { success: false, message: '网络错误，搜索用户失败' };
    }
});

ipcMain.handle('follow-user', async (event, fid) => {
    const targetMid = Number(fid);
    if (!targetMid) {
        return { success: false, message: '无效的mid' };
    }

    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return { success: false, message: '未登录或Cookie无效' };
    }

    const csrf = getCsrfToken();
    if (!csrf) {
        return { success: false, message: '缺少CSRF令牌，请重新登录后重试' };
    }

    try {
        const body = new URLSearchParams({
            fid: String(targetMid),
            act: '1',
            re_src: '11',
            csrf
        });

        const response = await axios.post('https://api.bilibili.com/x/relation/modify', body.toString(), {
            headers: {
                Cookie: cookieHeader,
                Referer: 'https://www.bilibili.com',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (response.data.code !== 0) {
            return { success: false, message: response.data.message || '关注失败' };
        }

        const cache = loadApiCache();
        const keysToClear = Object.keys(cache).filter((key) => key.includes(getCacheKey(cookieHeader, '').split(':')[0]));
        keysToClear.forEach((key) => {
            delete cache[key];
        });
        if (keysToClear.length > 0) {
            saveApiCache(cache);
        }

        return { success: true };
    } catch (error) {
        console.error('关注用户失败:', error);
        return { success: false, message: '网络错误，关注用户失败' };
    }
});

ipcMain.handle('get-live-following', async () => {
    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return { success: false, message: '未登录或Cookie无效' };
    }

    try {
        const cacheKey = getCacheKey(cookieHeader, 'live-following');
        const data = await cachedFetch(cacheKey, CACHE_TTL.liveFollowing, async () => {
            const response = await axios.get('https://api.live.bilibili.com/xlive/web-ucenter/v1/xfetter/GetWebList', {
                headers: {
                    Cookie: cookieHeader,
                    Referer: 'https://live.bilibili.com',
                    'User-Agent': 'Mozilla/5.0'
                },
                params: {
                    hit_ab: true
                }
            });

            if (response.data.code !== 0) {
                throw new Error(response.data.message || response.data.msg || '获取直播列表失败');
            }

            const sourceList = Array.isArray(response.data?.data?.rooms)
                ? response.data.data.rooms
                : Array.isArray(response.data?.data?.list)
                    ? response.data.data.list
                    : [];

            const livingUsers = sourceList
                .filter((item) => Number(item.live_status) === 1)
                .map((item) => ({
                    mid: Number(item.uid || 0),
                    roomId: Number(item.room_id || item.roomid || 0),
                    name: item.uname || '-',
                    avatar: normalizeAvatarUrl(item.face),
                    title: item.title || '直播中',
                    areaName: item.area_name || item.area_v2_name || '',
                    online: Number(item.online || 0),
                    liveStatus: 'live'
                }));

            const enriched = await enrichMembersWithProfiles(livingUsers, {
                Cookie: cookieHeader
            });

            return {
                count: enriched.length,
                list: enriched
            };
        });

        return { success: true, data };
    } catch (error) {
        console.error('获取直播列表失败:', error);
        return { success: false, message: '网络错误，获取直播列表失败' };
    }
});

ipcMain.on('open-follow-list-window', () => {
    createFollowListWindow();
});

ipcMain.handle('get-monitor-list', async () => {
    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return { success: false, message: '未登录或Cookie无效' };
    }

    try {
        const headers = {
            Cookie: cookieHeader,
            Referer: 'https://www.bilibili.com'
        };
        const currentMid = await getCurrentUserId(headers);
        const store = loadMonitorStore();
        const key = String(currentMid);
        const list = Array.isArray(store[key]) ? store[key] : [];
        const enrichedList = await enrichMembersWithProfiles(list, headers);
        store[key] = enrichedList;
        saveMonitorStore(store);
        return { success: true, data: enrichedList };
    } catch (error) {
        console.error('获取监听列表失败:', error);
        return { success: false, message: '获取监听列表失败' };
    }
});

ipcMain.handle('add-monitor-user', async (event, user) => {
    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return { success: false, message: '未登录或Cookie无效' };
    }

    const targetMid = Number(user?.mid || 0);
    if (!targetMid) {
        return { success: false, message: '无效的用户MID' };
    }

    try {
        const headers = {
            Cookie: cookieHeader,
            Referer: 'https://www.bilibili.com'
        };
        const currentMid = await getCurrentUserId(headers);

        const store = loadMonitorStore();
        const key = String(currentMid);
        const currentList = Array.isArray(store[key]) ? store[key] : [];

        if (currentList.some((item) => Number(item.mid) === targetMid)) {
            return { success: true, data: currentList };
        }

        const nextList = [
            ...currentList,
            {
                mid: targetMid,
                name: user?.name || '-',
                avatar: normalizeAvatarUrl(user?.avatar),
                level: user?.level ?? '-'
            }
        ];

        store[key] = nextList;
        saveMonitorStore(store);
        return { success: true, data: nextList };
    } catch (error) {
        console.error('添加监听用户失败:', error);
        return { success: false, message: '添加监听失败' };
    }
});

ipcMain.handle('remove-monitor-user', async (event, mid) => {
    const cookieHeader = getCookieHeader();
    if (!cookieHeader) {
        return { success: false, message: '未登录或Cookie无效' };
    }

    const targetMid = Number(mid || 0);
    if (!targetMid) {
        return { success: false, message: '无效的用户MID' };
    }

    try {
        const headers = {
            Cookie: cookieHeader,
            Referer: 'https://www.bilibili.com'
        };
        const currentMid = await getCurrentUserId(headers);

        const store = loadMonitorStore();
        const key = String(currentMid);
        const currentList = Array.isArray(store[key]) ? store[key] : [];
        const nextList = currentList.filter((item) => Number(item.mid) !== targetMid);

        store[key] = nextList;
        saveMonitorStore(store);
        return { success: true, data: nextList };
    } catch (error) {
        console.error('移除监听用户失败:', error);
        return { success: false, message: '移除监听失败' };
    }
});

app.on('before-quit', function () {
    isQuitting = true;
});

ipcMain.handle('get-system-metrics', () => {
    try {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = Math.max(0, totalMem - freeMem);
        const memoryUsagePercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

        return {
            success: true,
            data: {
                cpuUsagePercent: Number(getCpuUsagePercent().toFixed(1)),
                memoryUsagePercent: Number(memoryUsagePercent.toFixed(1)),
                memoryUsedGb: Number((usedMem / 1024 / 1024 / 1024).toFixed(2)),
                memoryTotalGb: Number((totalMem / 1024 / 1024 / 1024).toFixed(2))
            }
        };
    } catch (error) {
        console.error('获取系统负载失败:', error);
        return {
            success: false,
            message: '获取系统负载失败'
        };
    }
});

ipcMain.handle('get-ui-settings', () => {
    return {
        success: true,
        data: getUiSettings()
    };
});

ipcMain.handle('set-ui-settings', (event, settings) => {
    try {
        return {
            success: true,
            data: setUiSettings(settings || {})
        };
    } catch (error) {
        console.error('保存界面设置失败:', error);
        return {
            success: false,
            message: '保存界面设置失败'
        };
    }
});
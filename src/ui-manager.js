import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import multer from 'multer';
import crypto from 'crypto';
import { getRequestBody } from './common.js';
import { getAllProviderModels, getProviderModels } from './provider-models.js';
import { CONFIG } from './config-manager.js';
import { serviceInstances, getServiceAdapter } from './adapter.js';
import { initApiService } from './service-manager.js';
import { handleKiroOAuth } from './oauth-handlers.js';
import {
    generateUUID,
    normalizePath,
    getFileName,
    pathsEqual,
    isPathUsed,
    detectProviderFromPath,
    isValidOAuthCredentials,
    createProviderConfig,
    addToUsedPaths,
    formatSystemPath,
    findDuplicateUserId
} from './provider-utils.js';
import { formatKiroUsage } from './usage-service.js';

// Token存储到本地文件中
const TOKEN_STORE_FILE = 'token-store.json';

// 用量缓存文件路径
const USAGE_CACHE_FILE = 'usage-cache.json';

/**
 * 生成不缓存的响应头
 * @param {Object} additionalHeaders - 额外的响应头
 * @returns {Object} 包含禁用缓存的响应头
 */
function getNoCacheHeaders(additionalHeaders = {}) {
    return {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        ...additionalHeaders
    };
}

/**
 * 解析错误消息，转换为友好的中文提示
 * @param {string} errorMessage - 原始错误消息
 * @returns {object} { status: '封禁'|'过期'|'额度用尽'|'限流'|'未知错误', message: '友好提示' }
 */
function parseErrorMessage(errorMessage) {
    if (!errorMessage) return { status: '正常', message: '' };

    const msg = errorMessage.toLowerCase();

    // 403 - 封禁/禁止访问
    if (msg.includes('403') || msg.includes('forbidden') || msg.includes('suspended') || msg.includes('locked')) {
        return { status: '封禁', message: '账号已被封禁，无法使用', statusType: 'banned' };
    }

    // 402 - 额度用尽
    if (msg.includes('402') || msg.includes('payment') || msg.includes('quota') || msg.includes('limit exceeded')) {
        return { status: '额度用尽', message: '账号额度已用完', statusType: 'quota_exceeded' };
    }

    // 401 - Token 无效/过期
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid token') || msg.includes('expired')) {
        return { status: '过期', message: 'Token 已失效，需要重新授权', statusType: 'expired' };
    }

    // 429 - 限流
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
        return { status: '限流', message: '请求过于频繁，稍后自动恢复', statusType: 'rate_limit' };
    }

    // 500/502/503 - 服务器错误
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('server error')) {
        return { status: '服务异常', message: '服务器暂时不可用', statusType: 'server_error' };
    }

    // 网络错误
    if (msg.includes('timeout') || msg.includes('network') || msg.includes('econnrefused')) {
        return { status: '网络错误', message: '网络连接失败', statusType: 'network_error' };
    }

    // 默认
    return { status: '异常', message: errorMessage, statusType: 'unknown' };
}

// Kiro OAuth 状态存储（内存 + 文件持久化）
const kiroOAuthStates = new Map(); // state -> {code_verifier, machineid, timestamp, accountNumber}
const kiroOAuthCompletedStates = new Map(); // state -> {accountNumber, completedAt} 已完成的授权，保留5分钟供前端查询
const KIRO_OAUTH_STATE_FILE = 'kiro-oauth-states.json'; // 持久化文件

// 加载持久化的OAuth状态
async function loadOAuthStates() {
    try {
        if (existsSync(KIRO_OAUTH_STATE_FILE)) {
            const content = await fs.readFile(KIRO_OAUTH_STATE_FILE, 'utf8');
            const data = JSON.parse(content);

            // 清理过期的state（超过30分钟）
            const now = Date.now();
            const validStates = Object.entries(data).filter(([state, stateData]) => {
                const age = now - stateData.timestamp;
                return age < 30 * 60 * 1000; // 30分钟
            });

            // 加载到内存
            for (const [state, stateData] of validStates) {
                kiroOAuthStates.set(state, stateData);
            }

            console.log(`[Kiro OAuth] Loaded ${validStates.length} valid states from file`);
        }
    } catch (error) {
        console.warn('[Kiro OAuth] Failed to load OAuth states from file:', error.message);
    }
}

// 保存OAuth状态到文件
async function saveOAuthStates() {
    try {
        const statesObject = Object.fromEntries(kiroOAuthStates.entries());
        await fs.writeFile(KIRO_OAUTH_STATE_FILE, JSON.stringify(statesObject, null, 2));
    } catch (error) {
        console.error('[Kiro OAuth] Failed to save OAuth states to file:', error.message);
    }
}

// 启动时加载OAuth状态
loadOAuthStates().catch(err => {
    console.warn('[Kiro OAuth] Error during initial state loading:', err.message);
});

// Kiro OAuth 配置
const KIRO_OAUTH_CONFIG = {
    REDIRECT_URI: 'kiro://kiro.kiroAgent/authenticate-success',
    REDIRECT_URI_WEB: null,  // 动态生成，基于实际监听端口
    IDE_VERSION: '0.7.45',  // 更新到最新版本
    TOKEN_ENDPOINT: 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token',
    LOGIN_ENDPOINT: 'https://prod.us-east-1.auth.desktop.kiro.dev/login'
};

/**
 * 生成 OAuth 结果页面 HTML
 */
function generateOAuthResultPage(success, message, details = null) {
    const iconColor = success ? '#10b981' : '#ef4444';
    const icon = success ? '✓' : '✗';
    const title = success ? '授权成功' : '授权失败';

    let detailsHtml = '';
    if (details) {
        detailsHtml = `
            <div style="background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; text-align: left; max-width: 400px; margin: 0 auto 32px;">
                ${details.provider ? `<div style="color: #9ca3af; margin-bottom: 8px;">登录方式: <span style="color: #3b82f6; font-weight: 600;">${details.provider}</span></div>` : ''}
                ${details.accountNumber ? `<div style="color: #9ca3af; margin-bottom: 8px;">账号编号: <span style="color: #10b981; font-weight: 600;">#${details.accountNumber}</span></div>` : ''}
                ${details.tokenFile ? `<div style="color: #9ca3af; margin-bottom: 8px;">Token 文件: <code style="color: #f59e0b; background: rgba(245,158,11,0.1); padding: 2px 6px; border-radius: 4px;">${details.tokenFile}</code></div>` : ''}
                <div style="color: #9ca3af;">状态: <span style="color: #10b981;">已保存</span></div>
            </div>
        `;
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kiro OAuth - ${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            min-height: 100vh;
            background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #fff;
        }
        .container {
            text-align: center;
            padding: 40px;
            animation: fadeIn 0.5s ease-out;
        }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, ${iconColor} 0%, ${iconColor}cc 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 24px;
            box-shadow: 0 0 40px ${iconColor}66;
        }
        .icon span { font-size: 40px; }
        h1 { font-size: 32px; margin-bottom: 12px; }
        .message { color: #9ca3af; font-size: 18px; margin-bottom: 32px; max-width: 500px; }
        .btn {
            background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
            color: #fff;
            border: none;
            border-radius: 8px;
            padding: 14px 32px;
            font-size: 16px;
            cursor: pointer;
            font-weight: 500;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 20px rgba(59, 130, 246, 0.4);
        }
        .hint { color: #6b7280; font-size: 14px; margin-top: 16px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="icon"><span>${icon}</span></div>
        <h1>${title}</h1>
        <p class="message">${message}</p>
        ${detailsHtml}
        <button class="btn" onclick="window.close()">关闭此页面</button>
        <p class="hint">此页面可以安全关闭</p>
    </div>
</body>
</html>`;
}

/**
 * 读取用量缓存文件
 * @returns {Promise<Object|null>} 缓存的用量数据，如果不存在或读取失败则返回 null
 */
async function readUsageCache() {
    try {
        if (existsSync(USAGE_CACHE_FILE)) {
            const content = await fs.readFile(USAGE_CACHE_FILE, 'utf8');
            return JSON.parse(content);
        }
        return null;
    } catch (error) {
        console.warn('[Usage Cache] Failed to read usage cache:', error.message);
        return null;
    }
}

/**
 * 写入用量缓存文件
 * @param {Object} usageData - 用量数据
 */
async function writeUsageCache(usageData) {
    try {
        await fs.writeFile(USAGE_CACHE_FILE, JSON.stringify(usageData, null, 2), 'utf8');
        console.log('[Usage Cache] Usage data cached to', USAGE_CACHE_FILE);
    } catch (error) {
        console.error('[Usage Cache] Failed to write usage cache:', error.message);
    }
}

/**
 * 读取特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object|null>} 缓存的用量数据
 */
async function readProviderUsageCache(providerType) {
    const cache = await readUsageCache();
    if (cache && cache.providers && cache.providers[providerType]) {
        return {
            ...cache.providers[providerType],
            cachedAt: cache.timestamp,
            fromCache: true
        };
    }
    return null;
}

/**
 * 更新特定提供商类型的用量缓存
 * @param {string} providerType - 提供商类型
 * @param {Object} usageData - 用量数据
 */
async function updateProviderUsageCache(providerType, usageData) {
    let cache = await readUsageCache();
    if (!cache) {
        cache = {
            timestamp: new Date().toISOString(),
            providers: {}
        };
    }
    cache.providers[providerType] = usageData;
    cache.timestamp = new Date().toISOString();
    await writeUsageCache(cache);
}

/**
 * 读取token存储文件
 */
async function readTokenStore() {
    try {
        if (existsSync(TOKEN_STORE_FILE)) {
            const content = await fs.readFile(TOKEN_STORE_FILE, 'utf8');
            return JSON.parse(content);
        } else {
            // 如果文件不存在，创建一个默认的token store
            await writeTokenStore({ tokens: {} });
            return { tokens: {} };
        }
    } catch (error) {
        console.error('读取token存储文件失败:', error);
        return { tokens: {} };
    }
}

/**
 * 写入token存储文件
 */
async function writeTokenStore(tokenStore) {
    try {
        await fs.writeFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), 'utf8');
    } catch (error) {
        console.error('写入token存储文件失败:', error);
    }
}

/**
 * 生成简单的token
 */
function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

/**
 * 生成token过期时间
 */
function getExpiryTime() {
    const now = Date.now();
    const expiry = 60 * 60 * 1000; // 1小时
    return now + expiry;
}

/**
 * 验证简单token
 */
async function verifyToken(token) {
    const tokenStore = await readTokenStore();
    const tokenInfo = tokenStore.tokens[token];
    if (!tokenInfo) {
        return null;
    }
    
    // 检查是否过期
    if (Date.now() > tokenInfo.expiryTime) {
        await deleteToken(token);
        return null;
    }
    
    return tokenInfo;
}

/**
 * 保存token到本地文件
 */
async function saveToken(token, tokenInfo) {
    const tokenStore = await readTokenStore();
    tokenStore.tokens[token] = tokenInfo;
    await writeTokenStore(tokenStore);
}

/**
 * 删除token
 */
async function deleteToken(token) {
    const tokenStore = await readTokenStore();
    if (tokenStore.tokens[token]) {
        delete tokenStore.tokens[token];
        await writeTokenStore(tokenStore);
    }
}

/**
 * 清理过期的token
 */
async function cleanupExpiredTokens() {
    const tokenStore = await readTokenStore();
    const now = Date.now();
    let hasChanges = false;
    
    for (const token in tokenStore.tokens) {
        if (now > tokenStore.tokens[token].expiryTime) {
            delete tokenStore.tokens[token];
            hasChanges = true;
        }
    }
    
    if (hasChanges) {
        await writeTokenStore(tokenStore);
    }
}

/**
 * 读取密码文件内容
 */
async function readPasswordFile() {
    try {
        const password = await fs.readFile('./pwd', 'utf8');
        return password.trim();
    } catch (error) {
        console.error('读取密码文件失败:', error);
        return null;
    }
}

/**
 * 验证登录凭据
 */
async function validateCredentials(password) {
    const storedPassword = await readPasswordFile();
    return storedPassword && password === storedPassword;
}

/**
 * 解析请求体JSON
 */
function parseRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                if (!body.trim()) {
                    resolve({});
                } else {
                    resolve(JSON.parse(body));
                }
            } catch (error) {
                reject(new Error('无效的JSON格式'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * 检查token验证
 */
async function checkAuth(req) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }

    const token = authHeader.substring(7);
    const tokenInfo = await verifyToken(token);
    
    return tokenInfo !== null;
}

/**
 * 处理登录请求
 */
async function handleLoginRequest(req, res) {
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: '仅支持POST请求' }));
        return true;
    }

    try {
        const requestData = await parseRequestBody(req);
        const { password } = requestData;
        
        if (!password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '密码不能为空' }));
            return true;
        }

        const isValid = await validateCredentials(password);
        
        if (isValid) {
            // 生成简单token
            const token = generateToken();
            const expiryTime = getExpiryTime();
            
            // 存储token信息到本地文件
            await saveToken(token, {
                username: 'admin',
                loginTime: Date.now(),
                expiryTime
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: '登录成功',
                token,
                expiresIn: '1小时'
            }));
        } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: '密码错误，请重试'
            }));
        }
    } catch (error) {
        console.error('登录处理错误:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: false,
            message: error.message || '服务器错误'
        }));
    }
    return true;
}

// 定时清理过期token
setInterval(cleanupExpiredTokens, 5 * 60 * 1000); // 每5分钟清理一次

// 配置multer中间件
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            // multer在destination回调时req.body还未解析，先使用默认路径
            // 实际的provider会在文件上传完成后从req.body中获取
            const uploadPath = path.join(process.cwd(), 'configs', 'temp');
            await fs.mkdir(uploadPath, { recursive: true });
            cb(null, uploadPath);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${timestamp}_${sanitizedName}`);
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['.json', '.txt', '.key', '.pem', '.p12', '.pfx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('不支持的文件类型'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB限制
    }
});

/**
 * Serve static files for the UI
 * @param {string} path - The request path
 * @param {http.ServerResponse} res - The HTTP response object
 */
export async function serveStaticFiles(pathParam, res) {
    // 处理不同类型的路径
    let relativePath;
    if (pathParam === '/' || pathParam === '/index.html') {
        relativePath = 'index.html';
    } else if (pathParam === '/favicon.ico') {
        relativePath = 'favicon.ico';
    } else if (pathParam.startsWith('/_next/') || pathParam.startsWith('/dashboard') || pathParam.startsWith('/login') || pathParam.startsWith('/app/')) {
        // Next.js 静态资源直接使用路径（去掉开头的 /）
        relativePath = pathParam.substring(1);
    } else if (pathParam.startsWith('/')) {
        // 其他以 / 开头的路径，去掉开头的 /
        relativePath = pathParam.substring(1);
    } else {
        // 其他路径移除 /static/ 前缀
        relativePath = pathParam.replace('/static/', '');
    }

    let filePath = path.join(process.cwd(), 'static', relativePath);

    // 首先尝试添加 .html 扩展名（优先于目录处理）
    const ext = path.extname(filePath);
    if (!ext && !filePath.endsWith('/')) {
        const htmlPath = filePath + '.html';
        if (existsSync(htmlPath)) {
            try {
                const stats = statSync(htmlPath);
                if (!stats.isDirectory()) {
                    filePath = htmlPath;
                }
            } catch (e) {
                // 忽略错误
            }
        }
    }

    // 如果文件不存在，检查是否是目录并尝试添加 index.html
    if (!existsSync(filePath) || (existsSync(filePath) && statSync(filePath).isDirectory())) {
        const currentPath = path.join(process.cwd(), 'static', relativePath);
        if (existsSync(currentPath)) {
            try {
                const stats = statSync(currentPath);
                if (stats.isDirectory()) {
                    const indexPath = path.join(currentPath, 'index.html');
                    if (existsSync(indexPath)) {
                        filePath = indexPath;
                    }
                }
            } catch (e) {
                // 忽略错误
            }
        }
    }

    if (existsSync(filePath)) {
        try {
            const stats = statSync(filePath);
            if (stats.isDirectory()) {
                return false; // 仍然是目录，返回 false
            }
        } catch (e) {
            return false;
        }

        const fileExt = path.extname(filePath);
        const contentType = {
            '.html': 'text/html',
            '.css': 'text/css',
            '.js': 'application/javascript',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
            '.json': 'application/json',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
            '.ttf': 'font/ttf'
        }[fileExt] || 'text/plain';

        // 为HTML文件添加允许Next.js运行的CSP头（完全禁用CSP限制）
        const headers = { 'Content-Type': contentType };
        if (fileExt === '.html') {
            // 使用最宽松的CSP策略
            headers['Content-Security-Policy'] = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;";
        }

        res.writeHead(200, headers);
        res.end(readFileSync(filePath));
        return true;
    }
    return false;
}

/**
 * Handle UI management API requests
 * @param {string} method - The HTTP method
 * @param {string} path - The request path
 * @param {http.IncomingMessage} req - The HTTP request object
 * @param {http.ServerResponse} res - The HTTP response object
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} providerPoolManager - The provider pool manager instance
 * @returns {Promise<boolean>} - True if the request was handled by UI API
 */
/**
 * 重载配置文件
 * 动态导入config-manager并重新初始化配置
 * @returns {Promise<Object>} 返回重载后的配置对象
 */
async function reloadConfig(providerPoolManager) {
    try {
        // Import config manager dynamically
        const { initializeConfig } = await import('./config-manager.js');
        
        // Reload main config
        const newConfig = await initializeConfig(process.argv.slice(2), 'config.json');
        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = newConfig.providerPools;
            providerPoolManager.initializeProviderStatus();
        }
        
        // Update global CONFIG
        Object.assign(CONFIG, newConfig);
        console.log('[UI API] Configuration reloaded:');

        // Update initApiService - 清空并重新初始化服务实例
        Object.keys(serviceInstances).forEach(key => delete serviceInstances[key]);
        initApiService(CONFIG);
        
        console.log('[UI API] Configuration reloaded successfully');
        
        return newConfig;
    } catch (error) {
        console.error('[UI API] Failed to reload configuration:', error);
        throw error;
    }
}

export async function handleUIApiRequests(method, pathParam, req, res, currentConfig, providerPoolManager) {
    // 处理登录接口
    if (method === 'POST' && pathParam === '/api/login') {
        const handled = await handleLoginRequest(req, res);
        if (handled) return true;
    }

    // 健康检查接口（用于前端token验证）
    if (method === 'GET' && pathParam === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
        return true;
    }

    // Kiro OAuth 网页回调（直接浏览器接收，无需 AntiHook）
    if (method === 'GET' && pathParam === '/kiro/oauth/web-callback') {
        try {
            const urlObj = new URL(req.url, `http://${req.headers.host}`);
            const code = urlObj.searchParams.get('code');
            const state = urlObj.searchParams.get('state');

            console.log(`[Kiro OAuth Web] Received callback: code=${code?.substring(0, 10)}..., state=${state?.substring(0, 10)}...`);

            if (!code || !state) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateOAuthResultPage(false, '缺少必要参数 (code 或 state)'));
                return true;
            }

            // 查找对应的 state
            const stateData = kiroOAuthStates.get(state);
            if (!stateData) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateOAuthResultPage(false, 'State 无效或已过期，请重新生成授权链接'));
                return true;
            }

            // 检查是否过期（30分钟）
            if (Date.now() - stateData.timestamp > 30 * 60 * 1000) {
                kiroOAuthStates.delete(state);
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateOAuthResultPage(false, '授权已过期（超过30分钟），请重新生成授权链接'));
                return true;
            }

            // 使用存储的 redirect_uri（确保与生成时完全一致）
            const redirectUri = stateData.redirectUri;

            // 交换 code 获取 token
            console.log('[Kiro OAuth Web] Exchanging code for token...');
            const tokenResponse = await fetch(KIRO_OAUTH_CONFIG.TOKEN_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': `Kiro/${KIRO_OAUTH_CONFIG.IDE_VERSION}`,
                    'x-machineid': stateData.machineid
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: redirectUri,
                    code_verifier: stateData.code_verifier
                }).toString()
            });

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error('[Kiro OAuth Web] Token exchange failed:', errorText);
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(generateOAuthResultPage(false, `Token 交换失败: ${tokenResponse.status} - ${errorText}`));
                return true;
            }

            const tokenData = await tokenResponse.json();
            console.log('[Kiro OAuth Web] Token exchange successful!');

            // 保存 token 到文件
            const accountNumber = stateData.accountNumber || 1;
            const tokenFileName = `kiro-auth-token-${accountNumber}.json`;
            const tokenFilePath = path.join(process.cwd(), 'configs', 'kiro', tokenFileName);

            // 确保目录存在
            const tokenDir = path.dirname(tokenFilePath);
            if (!fs.existsSync(tokenDir)) {
                fs.mkdirSync(tokenDir, { recursive: true });
            }

            // 构建完整的 token 数据
            const fullTokenData = {
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresAt: Date.now() + (tokenData.expires_in * 1000),
                machineid: stateData.machineid,
                provider: stateData.provider,
                createdAt: new Date().toISOString(),
                createdBy: 'web-oauth'
            };

            fs.writeFileSync(tokenFilePath, JSON.stringify(fullTokenData, null, 2));
            console.log(`[Kiro OAuth Web] Token saved to: ${tokenFilePath}`);

            // 保存完成状态供前端查询（5分钟后自动清理）
            kiroOAuthCompletedStates.set(state, {
                accountNumber: accountNumber,
                completedAt: Date.now()
            });
            setTimeout(() => kiroOAuthCompletedStates.delete(state), 5 * 60 * 1000);

            // 清理使用过的 state
            kiroOAuthStates.delete(state);
            saveOAuthStates().catch(err => {
                console.error('[Kiro OAuth] Failed to persist after cleanup:', err.message);
            });

            // 通知 provider pool manager 重新加载
            if (providerPoolManager) {
                try {
                    await providerPoolManager.reloadPools();
                    console.log('[Kiro OAuth Web] Provider pools reloaded');
                } catch (e) {
                    console.warn('[Kiro OAuth Web] Failed to reload pools:', e.message);
                }
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateOAuthResultPage(true, `账号 #${accountNumber} 授权成功！`, {
                accountNumber,
                tokenFile: tokenFileName,
                provider: stateData.provider
            }));
            return true;
        } catch (error) {
            console.error('[Kiro OAuth Web] Callback handling error:', error);
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(generateOAuthResultPage(false, `处理失败: ${error.message}`));
            return true;
        }
    }

    // Handle UI management API requests (需要token验证，除了登录接口、健康检查、Events接口、OAuth相关和清理重复接口)
    if (pathParam.startsWith('/api/') && pathParam !== '/api/login' && pathParam !== '/api/health' && pathParam !== '/api/events' && pathParam !== '/api/kiro/oauth/callback' && pathParam !== '/api/kiro/oauth/generate-url' && pathParam !== '/api/kiro/oauth/manual-import' && pathParam !== '/api/kiro/oauth/aws-sso/start' && pathParam !== '/api/providers/cleanup-duplicates' && pathParam !== '/api/providers') {
        // 检查token验证
        const isAuth = await checkAuth(req);
        if (!isAuth) {
            res.writeHead(401, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
            });
            res.end(JSON.stringify({
                error: {
                    message: '未授权访问，请先登录',
                    code: 'UNAUTHORIZED'
                }
            }));
            return true;
        }
    }

    // 文件上传API
    if (method === 'POST' && pathParam === '/api/upload-oauth-credentials') {
        const uploadMiddleware = upload.single('file');
        
        uploadMiddleware(req, res, async (err) => {
            if (err) {
                console.error('文件上传错误:', err.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: err.message || '文件上传失败'
                    }
                }));
                return;
            }

            try {
                if (!req.file) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: {
                            message: '没有文件被上传'
                        }
                    }));
                    return;
                }

                // multer执行完成后，表单字段已解析到req.body中
                const provider = req.body.provider || 'common';
                const tempFilePath = req.file.path;
                
                // 根据实际的provider移动文件到正确的目录
                let targetDir = path.join(process.cwd(), 'configs', provider);
                
                // 如果是kiro类型的凭证，需要再包裹一层文件夹
                if (provider === 'kiro') {
                    // 使用时间戳作为子文件夹名称，确保每个上传的文件都有独立的目录
                    const timestamp = Date.now();
                    const originalNameWithoutExt = path.parse(req.file.originalname).name;
                    const subFolder = `${timestamp}_${originalNameWithoutExt}`;
                    targetDir = path.join(targetDir, subFolder);
                }
                
                await fs.mkdir(targetDir, { recursive: true });
                
                const targetFilePath = path.join(targetDir, req.file.filename);
                await fs.rename(tempFilePath, targetFilePath);
                
                const relativePath = path.relative(process.cwd(), targetFilePath);

                // 广播更新事件
                broadcastEvent('config_update', {
                    action: 'add',
                    filePath: relativePath,
                    provider: provider,
                    timestamp: new Date().toISOString()
                });

                console.log(`[UI API] OAuth凭据文件已上传: ${targetFilePath} (提供商: ${provider})`);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: '文件上传成功',
                    filePath: relativePath,
                    originalName: req.file.originalname,
                    provider: provider
                }));

            } catch (error) {
                console.error('文件上传处理错误:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: '文件上传处理失败: ' + error.message
                    }
                }));
            }
        });
        return true;
    }

    // Update admin password
    if (method === 'POST' && pathParam === '/api/admin-password') {
        try {
            const body = await getRequestBody(req);
            const { password } = body;

            if (!password || password.trim() === '') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: '密码不能为空'
                    }
                }));
                return true;
            }

            // 写入密码到 pwd 文件
            const pwdFilePath = path.join(process.cwd(), 'pwd');
            await fs.writeFile(pwdFilePath, password.trim(), 'utf8');
            
            console.log('[UI API] Admin password updated successfully');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: '后台登录密码已更新'
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to update admin password:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: '更新密码失败: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get configuration
    if (method === 'GET' && pathParam === '/api/config') {
        let systemPrompt = '';

        if (currentConfig.SYSTEM_PROMPT_FILE_PATH && existsSync(currentConfig.SYSTEM_PROMPT_FILE_PATH)) {
            try {
                systemPrompt = readFileSync(currentConfig.SYSTEM_PROMPT_FILE_PATH, 'utf-8');
            } catch (e) {
                console.warn('[UI API] Failed to read system prompt file:', e.message);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...currentConfig,
            systemPrompt
        }));
        return true;
    }

    // Update configuration
    if (method === 'POST' && pathParam === '/api/config') {
        try {
            const body = await getRequestBody(req);
            const newConfig = body;

            // Update config values in memory
            if (newConfig.REQUIRED_API_KEY !== undefined) currentConfig.REQUIRED_API_KEY = newConfig.REQUIRED_API_KEY;
            if (newConfig.HOST !== undefined) currentConfig.HOST = newConfig.HOST;
            if (newConfig.SERVER_PORT !== undefined) currentConfig.SERVER_PORT = newConfig.SERVER_PORT;
            if (newConfig.MODEL_PROVIDER !== undefined) currentConfig.MODEL_PROVIDER = newConfig.MODEL_PROVIDER;
            if (newConfig.PROJECT_ID !== undefined) currentConfig.PROJECT_ID = newConfig.PROJECT_ID;
            if (newConfig.OPENAI_API_KEY !== undefined) currentConfig.OPENAI_API_KEY = newConfig.OPENAI_API_KEY;
            if (newConfig.OPENAI_BASE_URL !== undefined) currentConfig.OPENAI_BASE_URL = newConfig.OPENAI_BASE_URL;
            if (newConfig.CLAUDE_API_KEY !== undefined) currentConfig.CLAUDE_API_KEY = newConfig.CLAUDE_API_KEY;
            if (newConfig.CLAUDE_BASE_URL !== undefined) currentConfig.CLAUDE_BASE_URL = newConfig.CLAUDE_BASE_URL;
            if (newConfig.GEMINI_OAUTH_CREDS_BASE64 !== undefined) currentConfig.GEMINI_OAUTH_CREDS_BASE64 = newConfig.GEMINI_OAUTH_CREDS_BASE64;
            if (newConfig.GEMINI_OAUTH_CREDS_FILE_PATH !== undefined) currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH = newConfig.GEMINI_OAUTH_CREDS_FILE_PATH;
            if (newConfig.KIRO_OAUTH_CREDS_BASE64 !== undefined) currentConfig.KIRO_OAUTH_CREDS_BASE64 = newConfig.KIRO_OAUTH_CREDS_BASE64;
            if (newConfig.KIRO_OAUTH_CREDS_FILE_PATH !== undefined) currentConfig.KIRO_OAUTH_CREDS_FILE_PATH = newConfig.KIRO_OAUTH_CREDS_FILE_PATH;
            if (newConfig.QWEN_OAUTH_CREDS_FILE_PATH !== undefined) currentConfig.QWEN_OAUTH_CREDS_FILE_PATH = newConfig.QWEN_OAUTH_CREDS_FILE_PATH;
            if (newConfig.SYSTEM_PROMPT_FILE_PATH !== undefined) currentConfig.SYSTEM_PROMPT_FILE_PATH = newConfig.SYSTEM_PROMPT_FILE_PATH;
            if (newConfig.SYSTEM_PROMPT_MODE !== undefined) currentConfig.SYSTEM_PROMPT_MODE = newConfig.SYSTEM_PROMPT_MODE;
            if (newConfig.PROMPT_LOG_BASE_NAME !== undefined) currentConfig.PROMPT_LOG_BASE_NAME = newConfig.PROMPT_LOG_BASE_NAME;
            if (newConfig.PROMPT_LOG_MODE !== undefined) currentConfig.PROMPT_LOG_MODE = newConfig.PROMPT_LOG_MODE;
            if (newConfig.REQUEST_MAX_RETRIES !== undefined) currentConfig.REQUEST_MAX_RETRIES = newConfig.REQUEST_MAX_RETRIES;
            if (newConfig.REQUEST_BASE_DELAY !== undefined) currentConfig.REQUEST_BASE_DELAY = newConfig.REQUEST_BASE_DELAY;
            if (newConfig.CRON_NEAR_MINUTES !== undefined) currentConfig.CRON_NEAR_MINUTES = newConfig.CRON_NEAR_MINUTES;
            if (newConfig.CRON_REFRESH_TOKEN !== undefined) currentConfig.CRON_REFRESH_TOKEN = newConfig.CRON_REFRESH_TOKEN;
            if (newConfig.PROVIDER_POOLS_FILE_PATH !== undefined) currentConfig.PROVIDER_POOLS_FILE_PATH = newConfig.PROVIDER_POOLS_FILE_PATH;
            if (newConfig.MAX_ERROR_COUNT !== undefined) currentConfig.MAX_ERROR_COUNT = newConfig.MAX_ERROR_COUNT;
            if (newConfig.ENABLE_THINKING_BY_DEFAULT !== undefined) currentConfig.ENABLE_THINKING_BY_DEFAULT = newConfig.ENABLE_THINKING_BY_DEFAULT;

            // Handle system prompt update
            if (newConfig.systemPrompt !== undefined) {
                const promptPath = currentConfig.SYSTEM_PROMPT_FILE_PATH || 'input_system_prompt.txt';
                try {
                    const relativePath = path.relative(process.cwd(), promptPath);
                    writeFileSync(promptPath, newConfig.systemPrompt, 'utf-8');

                    // 广播更新事件
                    broadcastEvent('config_update', {
                        action: 'update',
                        filePath: relativePath,
                        type: 'system_prompt',
                        timestamp: new Date().toISOString()
                    });
                    
                    console.log('[UI API] System prompt updated');
                } catch (e) {
                    console.warn('[UI API] Failed to write system prompt:', e.message);
                }
            }

            // Update config.json file
            try {
                const configPath = 'config.json';
                
                // Create a clean config object for saving (exclude runtime-only properties)
                const configToSave = {
                    REQUIRED_API_KEY: currentConfig.REQUIRED_API_KEY,
                    SERVER_PORT: currentConfig.SERVER_PORT,
                    HOST: currentConfig.HOST,
                    MODEL_PROVIDER: currentConfig.MODEL_PROVIDER,
                    OPENAI_API_KEY: currentConfig.OPENAI_API_KEY,
                    OPENAI_BASE_URL: currentConfig.OPENAI_BASE_URL,
                    CLAUDE_API_KEY: currentConfig.CLAUDE_API_KEY,
                    CLAUDE_BASE_URL: currentConfig.CLAUDE_BASE_URL,
                    PROJECT_ID: currentConfig.PROJECT_ID,
                    GEMINI_OAUTH_CREDS_BASE64: currentConfig.GEMINI_OAUTH_CREDS_BASE64,
                    GEMINI_OAUTH_CREDS_FILE_PATH: currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH,
                    KIRO_OAUTH_CREDS_BASE64: currentConfig.KIRO_OAUTH_CREDS_BASE64,
                    KIRO_OAUTH_CREDS_FILE_PATH: currentConfig.KIRO_OAUTH_CREDS_FILE_PATH,
                    QWEN_OAUTH_CREDS_FILE_PATH: currentConfig.QWEN_OAUTH_CREDS_FILE_PATH,
                    SYSTEM_PROMPT_FILE_PATH: currentConfig.SYSTEM_PROMPT_FILE_PATH,
                    SYSTEM_PROMPT_MODE: currentConfig.SYSTEM_PROMPT_MODE,
                    PROMPT_LOG_BASE_NAME: currentConfig.PROMPT_LOG_BASE_NAME,
                    PROMPT_LOG_MODE: currentConfig.PROMPT_LOG_MODE,
                    REQUEST_MAX_RETRIES: currentConfig.REQUEST_MAX_RETRIES,
                    REQUEST_BASE_DELAY: currentConfig.REQUEST_BASE_DELAY,
                    CRON_NEAR_MINUTES: currentConfig.CRON_NEAR_MINUTES,
                    CRON_REFRESH_TOKEN: currentConfig.CRON_REFRESH_TOKEN,
                    PROVIDER_POOLS_FILE_PATH: currentConfig.PROVIDER_POOLS_FILE_PATH,
                    MAX_ERROR_COUNT: currentConfig.MAX_ERROR_COUNT,
                    ENABLE_THINKING_BY_DEFAULT: currentConfig.ENABLE_THINKING_BY_DEFAULT
                };

                writeFileSync(configPath, JSON.stringify(configToSave, null, 2), 'utf-8');
                console.log('[UI API] Configuration saved to config.json');
                
                // 广播更新事件
                broadcastEvent('config_update', {
                    action: 'update',
                    filePath: 'config.json',
                    type: 'main_config',
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('[UI API] Failed to save configuration to file:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: 'Failed to save configuration to file: ' + error.message,
                        partial: true  // Indicate that memory config was updated but not saved
                    }
                }));
                return true;
            }

            // Update the global CONFIG object to reflect changes immediately
            Object.assign(CONFIG, currentConfig);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Configuration updated successfully',
                details: 'Configuration has been updated in both memory and config.json file'
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Get system information
    if (method === 'GET' && pathParam === '/api/system') {
        const memUsage = process.memoryUsage();
        res.writeHead(200, getNoCacheHeaders());
        res.end(JSON.stringify({
            nodeVersion: process.version,
            serverTime: new Date().toLocaleString(),
            memoryUsage: `${Math.round(memUsage.rss / 1024 / 1024)} MB / ${Math.round(memUsage.rss * 1.5 / 1024 / 1024)} MB`,
            uptime: process.uptime()
        }));
        return true;
    }

    // Get provider pools summary
    if (method === 'GET' && pathParam === '/api/providers') {
        let providerPools = {};
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';

        // 先加载原有的 provider pools
        try {
            if (providerPoolManager && providerPoolManager.providerPools) {
                providerPools = providerPoolManager.providerPools;
            } else if (filePath && existsSync(filePath)) {
                const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
                providerPools = poolsData;
            }
        } catch (error) {
            console.warn('[UI API] Failed to load provider pools:', error.message);
        }

        // 确保每个 provider type 都是数组，并且不包含以 _ 开头的内部字段
        const cleanedPools = {};
        for (const key in providerPools) {
            if (!key.startsWith('_')) {
                cleanedPools[key] = Array.isArray(providerPools[key]) ? providerPools[key] : [];
            }
        }
        providerPools = cleanedPools;

        // 尝试添加账号池统计信息（不影响原有数据）
        try {
            const { getRedisManager } = await import('./redis-manager.js');
            const redis = getRedisManager();
            const redisStats = await redis.getStats();

            // 直接从 providerPools 计算统计数据
            let healthyCount = 0;
            let checkingCount = 0;
            let bannedCount = 0;
            let totalUsageCount = 0;
            let totalErrorCount = 0;

            for (const [providerType, accounts] of Object.entries(providerPools)) {
                if (Array.isArray(accounts)) {
                    for (const account of accounts) {
                        totalUsageCount += account.usageCount || 0;
                        totalErrorCount += account.errorCount || 0;

                        // 解析错误消息，添加友好提示
                        if (account.lastErrorMessage) {
                            account.errorStatus = parseErrorMessage(account.lastErrorMessage);
                        } else {
                            account.errorStatus = { status: '正常', message: '', statusType: 'ok' };
                        }

                        // 判断池类型
                        if (account.isDisabled) {
                            account.poolType = 'disabled';
                            bannedCount++;
                        } else if (!account.isHealthy) {
                            account.poolType = 'banned';
                            bannedCount++;
                        } else if (account.errorCount > 0 && account.isHealthy) {
                            account.poolType = 'checking';
                            checkingCount++;
                        } else {
                            account.poolType = 'healthy';
                            healthyCount++;
                        }
                    }
                }
            }

            const totalCount = healthyCount + checkingCount + bannedCount;

            // 添加账号池统计信息（不破坏原有结构）
            providerPools._accountPoolStats = {
                healthy: healthyCount,
                checking: checkingCount,
                banned: bannedCount,
                total: totalCount,
                totalUsageCount,
                totalErrorCount,
                cacheHitRate: redisStats?.cacheStats?.hitRate || '0%'
            };

            console.log(`[UI API] Pool stats: healthy=${healthyCount}, checking=${checkingCount}, banned=${bannedCount}, total=${totalCount}`);
        } catch (error) {
            console.warn('[UI API] Failed to add account pool stats:', error.message, error.stack);
            // 不影响原有功能，继续返回
        }

        // 最终验证：确保所有非 _ 开头的字段都是数组
        for (const key in providerPools) {
            if (!key.startsWith('_') && !Array.isArray(providerPools[key])) {
                console.warn(`[UI API] Warning: ${key} is not an array, converting to empty array`);
                providerPools[key] = [];
            }
        }

        res.writeHead(200, getNoCacheHeaders());
        res.end(JSON.stringify(providerPools));
        return true;
    }

    // Get specific provider type details
    const providerTypeMatch = pathParam.match(/^\/api\/providers\/([^\/]+)$/);
    if (method === 'GET' && providerTypeMatch) {
        const providerType = decodeURIComponent(providerTypeMatch[1]);
        let providerPools = {};
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
        try {
            if (providerPoolManager && providerPoolManager.providerPools) {
                providerPools = providerPoolManager.providerPools;
            } else if (filePath && existsSync(filePath)) {
                const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
                providerPools = poolsData;
            }
        } catch (error) {
            console.warn('[UI API] Failed to load provider pools:', error.message);
        }

        const providers = providerPools[providerType] || [];
        res.writeHead(200, getNoCacheHeaders());
        res.end(JSON.stringify({
            providerType,
            providers,
            totalCount: providers.length,
            healthyCount: providers.filter(p => p.isHealthy).length
        }));
        return true;
    }

    // Get available models for all providers or specific provider type
    if (method === 'GET' && pathParam === '/api/provider-models') {
        const allModels = getAllProviderModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(allModels));
        return true;
    }

    // Get available models for a specific provider type
    const providerModelsMatch = pathParam.match(/^\/api\/provider-models\/([^\/]+)$/);
    if (method === 'GET' && providerModelsMatch) {
        const providerType = decodeURIComponent(providerModelsMatch[1]);
        const models = getProviderModels(providerType);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            providerType,
            models
        }));
        return true;
    }

    // Add new provider configuration
    if (method === 'POST' && pathParam === '/api/providers') {
        try {
            const body = await getRequestBody(req);
            const { providerType, providerConfig } = body;

            if (!providerType || !providerConfig) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'providerType and providerConfig are required' } }));
                return true;
            }

            // Generate UUID if not provided
            if (!providerConfig.uuid) {
                providerConfig.uuid = generateUUID();
            }

            // Set default values
            providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
            providerConfig.lastUsed = providerConfig.lastUsed || null;
            providerConfig.usageCount = providerConfig.usageCount || 0;
            providerConfig.errorCount = providerConfig.errorCount || 0;
            providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;

            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};
            
            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    console.warn('[UI API] Failed to read existing provider pools:', readError.message);
                }
            }

            // Add new provider to the appropriate type
            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }
            providerPools[providerType].push(providerConfig);

            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Added new provider to ${providerType}: ${providerConfig.uuid}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'add',
                filePath: filePath,
                providerType,
                providerConfig,
                timestamp: new Date().toISOString()
            });

            // 广播提供商更新事件
            broadcastEvent('provider_update', {
                action: 'add',
                providerType,
                providerConfig,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Provider added successfully',
                provider: providerConfig,
                providerType
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Update specific provider configuration
    const updateProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)$/);
    if (method === 'PUT' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];

        try {
            const body = await getRequestBody(req);
            const { providerConfig } = body;

            if (!providerConfig) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'providerConfig is required' } }));
                return true;
            }

            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};
            
            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            // Find and update the provider
            const providers = providerPools[providerType] || [];
            const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
            
            if (providerIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            // Update provider while preserving certain fields
            const existingProvider = providers[providerIndex];
            const updatedProvider = {
                ...existingProvider,
                ...providerConfig,
                uuid: providerUuid, // Ensure UUID doesn't change
                lastUsed: existingProvider.lastUsed, // Preserve usage stats
                usageCount: existingProvider.usageCount,
                errorCount: existingProvider.errorCount,
                lastErrorTime: existingProvider.lastErrorTime
            };

            providerPools[providerType][providerIndex] = updatedProvider;

            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Updated provider ${providerUuid} in ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'update',
                filePath: filePath,
                providerType,
                providerConfig: updatedProvider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Provider updated successfully',
                provider: updatedProvider
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Delete specific provider configuration
    if (method === 'DELETE' && updateProviderMatch) {
        const providerType = decodeURIComponent(updateProviderMatch[1]);
        const providerUuid = updateProviderMatch[2];

        try {
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};
            
            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            // Find and remove the provider
            const providers = providerPools[providerType] || [];
            const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
            
            if (providerIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            const deletedProvider = providers[providerIndex];
            providers.splice(providerIndex, 1);

            // 尝试删除对应的token文件（仅当该文件不被其他provider使用时）
            const tokenFilePath = deletedProvider.KIRO_OAUTH_CREDS_FILE_PATH ||
                                  deletedProvider.GEMINI_OAUTH_CREDS_FILE_PATH ||
                                  deletedProvider.QWEN_OAUTH_CREDS_FILE_PATH ||
                                  deletedProvider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;

            if (tokenFilePath) {
                // 检查是否还有其他provider使用同一个token文件
                const isFileUsedByOthers = Object.values(providerPools).flat().some(p => {
                    if (p.uuid === providerUuid) return false; // 跳过当前要删除的provider
                    return (p.KIRO_OAUTH_CREDS_FILE_PATH === tokenFilePath ||
                            p.GEMINI_OAUTH_CREDS_FILE_PATH === tokenFilePath ||
                            p.QWEN_OAUTH_CREDS_FILE_PATH === tokenFilePath ||
                            p.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH === tokenFilePath);
                });

                if (!isFileUsedByOthers) {
                    // 没有其他provider使用此文件，可以安全删除
                    try {
                        const fullTokenPath = path.join(process.cwd(), tokenFilePath);
                        if (existsSync(fullTokenPath)) {
                            await fs.unlink(fullTokenPath);
                            console.log(`[UI API] Deleted token file: ${tokenFilePath}`);
                        }
                    } catch (deleteError) {
                        console.warn(`[UI API] Failed to delete token file ${tokenFilePath}:`, deleteError.message);
                        // 不阻止provider配置的删除
                    }
                } else {
                    console.log(`[UI API] Token file ${tokenFilePath} is still used by other providers, keeping it`);
                }
            }

            // Remove the entire provider type if no providers left
            if (providers.length === 0) {
                delete providerPools[providerType];
            }

            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Deleted provider ${providerUuid} from ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'delete',
                filePath: filePath,
                providerType,
                providerConfig: deletedProvider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Provider deleted successfully',
                deletedProvider
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Batch delete providers by UUIDs
    if (method === 'POST' && pathParam === '/api/providers/batch-delete') {
        try {
            const body = await getRequestBody(req);
            const { providerType, uuids, deleteByStatus } = body;

            if (!providerType) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'providerType is required' } }));
                return true;
            }

            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};

            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            const providers = providerPools[providerType] || [];
            let toDelete = [];

            // 如果指定了 deleteByStatus，按状态筛选要删除的账号
            if (deleteByStatus && Array.isArray(deleteByStatus)) {
                for (const provider of providers) {
                    const errorStatus = parseErrorMessage(provider.lastErrorMessage);
                    // 检查是否匹配任一指定状态
                    if (deleteByStatus.includes(errorStatus.statusType) ||
                        (deleteByStatus.includes('banned') && (!provider.isHealthy || provider.isDisabled)) ||
                        (deleteByStatus.includes('disabled') && provider.isDisabled)) {
                        toDelete.push(provider.uuid);
                    }
                }
            } else if (uuids && Array.isArray(uuids)) {
                toDelete = uuids;
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Either uuids array or deleteByStatus array is required' } }));
                return true;
            }

            const deleteResults = {
                success: [],
                failed: [],
                tokenFilesDeleted: []
            };

            // 遍历要删除的UUID
            for (const uuid of toDelete) {
                const providerIndex = providers.findIndex(p => p.uuid === uuid);
                if (providerIndex === -1) {
                    deleteResults.failed.push({ uuid, reason: 'Provider not found' });
                    continue;
                }

                const deletedProvider = providers[providerIndex];

                // 尝试删除对应的token文件
                const tokenFilePath = deletedProvider.KIRO_OAUTH_CREDS_FILE_PATH ||
                                      deletedProvider.GEMINI_OAUTH_CREDS_FILE_PATH ||
                                      deletedProvider.QWEN_OAUTH_CREDS_FILE_PATH ||
                                      deletedProvider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;

                if (tokenFilePath) {
                    // 检查是否还有其他provider使用同一个token文件
                    const isFileUsedByOthers = providers.some((p, idx) => {
                        if (idx === providerIndex) return false;
                        if (toDelete.includes(p.uuid)) return false; // 也会被删除的不算
                        return (p.KIRO_OAUTH_CREDS_FILE_PATH === tokenFilePath ||
                                p.GEMINI_OAUTH_CREDS_FILE_PATH === tokenFilePath ||
                                p.QWEN_OAUTH_CREDS_FILE_PATH === tokenFilePath ||
                                p.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH === tokenFilePath);
                    });

                    if (!isFileUsedByOthers) {
                        try {
                            const fullTokenPath = path.join(process.cwd(), tokenFilePath);
                            if (existsSync(fullTokenPath)) {
                                await fs.unlink(fullTokenPath);
                                deleteResults.tokenFilesDeleted.push(tokenFilePath);
                                console.log(`[Batch Delete] Deleted token file: ${tokenFilePath}`);
                            }
                        } catch (deleteError) {
                            console.warn(`[Batch Delete] Failed to delete token file ${tokenFilePath}:`, deleteError.message);
                        }
                    }
                }

                // 从数组中移除
                providers.splice(providerIndex, 1);
                deleteResults.success.push({
                    uuid,
                    email: deletedProvider.cachedEmail || 'unknown',
                    tokenFile: tokenFilePath
                });
            }

            // 更新 providers 数组（重新获取索引后的）
            if (providers.length === 0) {
                delete providerPools[providerType];
            } else {
                providerPools[providerType] = providers;
            }

            // 保存到文件
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[Batch Delete] Deleted ${deleteResults.success.length} providers from ${providerType}`);

            // 更新 provider pool manager
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // 广播更新事件
            broadcastEvent('provider_update', {
                action: 'batch_delete',
                providerType,
                deletedCount: deleteResults.success.length,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `成功删除 ${deleteResults.success.length} 个账号，失败 ${deleteResults.failed.length} 个`,
                results: deleteResults
            }));
            return true;
        } catch (error) {
            console.error('[Batch Delete] Error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Disable/Enable specific provider configuration
    const disableEnableProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/(disable|enable)$/);
    if (disableEnableProviderMatch) {
        const providerType = decodeURIComponent(disableEnableProviderMatch[1]);
        const providerUuid = disableEnableProviderMatch[2];
        const action = disableEnableProviderMatch[3];

        try {
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};
            
            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            // Find and update the provider
            const providers = providerPools[providerType] || [];
            const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
            
            if (providerIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            // Update isDisabled field
            const provider = providers[providerIndex];
            provider.isDisabled = action === 'disable';
            
            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] ${action === 'disable' ? 'Disabled' : 'Enabled'} provider ${providerUuid} in ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                
                // Call the appropriate method
                if (action === 'disable') {
                    providerPoolManager.disableProvider(providerType, provider);
                } else {
                    providerPoolManager.enableProvider(providerType, provider);
                }
            }

            // 广播更新事件
            broadcastEvent('config_update', {
                action: action,
                filePath: filePath,
                providerType,
                providerConfig: provider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `Provider ${action}d successfully`,
                provider: provider
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Reset all providers health status for a specific provider type
    const resetHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/reset-health$/);
    if (method === 'POST' && resetHealthMatch) {
        const providerType = decodeURIComponent(resetHealthMatch[1]);

        try {
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};
            
            // Load existing pools
            if (existsSync(filePath)) {
                try {
                    const fileContent = readFileSync(filePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                    return true;
                }
            }

            // Reset health status for all providers of this type
            const providers = providerPools[providerType] || [];
            
            if (providers.length === 0) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
                return true;
            }

            let resetCount = 0;
            providers.forEach(provider => {
                if (!provider.isHealthy) {
                    provider.isHealthy = true;
                    provider.errorCount = 0;
                    provider.lastErrorTime = null;
                    resetCount++;
                }
            });

            // Save to file
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Reset health status for ${resetCount} providers in ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'reset_health',
                filePath: filePath,
                providerType,
                resetCount,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `成功重置 ${resetCount} 个节点的健康状态`,
                resetCount,
                totalCount: providers.length
            }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Toggle specific provider status (enable/disable)
    const toggleProviderMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/toggle$/);
    if (method === 'POST' && toggleProviderMatch) {
        const providerType = decodeURIComponent(toggleProviderMatch[1]);
        const providerUuid = toggleProviderMatch[2];

        try {
            const body = await parseRequestBody(req);
            const isDisabled = body.isDisabled;

            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};

            if (existsSync(filePath)) {
                const fileContent = readFileSync(filePath, 'utf8');
                providerPools = JSON.parse(fileContent);
            }

            const providers = providerPools[providerType] || [];
            const providerIndex = providers.findIndex(p => p.uuid === providerUuid);

            if (providerIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            const provider = providers[providerIndex];
            provider.isDisabled = isDisabled;

            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Toggled provider ${providerUuid}: isDisabled=${isDisabled}`);

            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                if (isDisabled) {
                    providerPoolManager.disableProvider(providerType, provider);
                } else {
                    providerPoolManager.enableProvider(providerType, provider);
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, isDisabled }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Single provider health check
    const singleHealthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/health-check$/);
    if (method === 'POST' && singleHealthCheckMatch) {
        const providerType = decodeURIComponent(singleHealthCheckMatch[1]);
        const providerUuid = singleHealthCheckMatch[2];

        try {
            if (!providerPoolManager) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
                return true;
            }

            const providers = providerPoolManager.providerStatus[providerType] || [];
            const providerStatus = providers.find(p => p.config.uuid === providerUuid);

            if (!providerStatus) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            const providerConfig = providerStatus.config;
            console.log(`[UI API] Starting single health check for provider ${providerUuid}`);

            const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);

            if (healthResult === null) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, isHealthy: false, message: '健康检测不支持此提供商类型' }));
                return true;
            }

            if (healthResult.success) {
                providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
            } else {
                providerPoolManager.markProviderUnhealthy(providerType, providerConfig, healthResult.error);
            }

            // Save to file
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            const providerPools = {};
            for (const pType in providerPoolManager.providerStatus) {
                providerPools[pType] = providerPoolManager.providerStatus[pType].map(ps => ps.config);
            }
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: healthResult.success,
                isHealthy: healthResult.success,
                modelName: healthResult.modelName,
                error: healthResult.error
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Single health check error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Single provider reset health
    const singleResetHealthMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/reset-health$/);
    if (method === 'POST' && singleResetHealthMatch) {
        const providerType = decodeURIComponent(singleResetHealthMatch[1]);
        const providerUuid = singleResetHealthMatch[2];

        try {
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            let providerPools = {};

            if (existsSync(filePath)) {
                const fileContent = readFileSync(filePath, 'utf8');
                providerPools = JSON.parse(fileContent);
            }

            const providers = providerPools[providerType] || [];
            const providerIndex = providers.findIndex(p => p.uuid === providerUuid);

            if (providerIndex === -1) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            const provider = providers[providerIndex];
            provider.isHealthy = true;
            provider.errorCount = 0;
            provider.lastErrorTime = null;
            provider.lastErrorMessage = null;

            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Reset health for provider ${providerUuid}`);

            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: '健康状态已重置' }));
            return true;
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Single provider test
    const singleTestMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/([^\/]+)\/test$/);
    if (method === 'POST' && singleTestMatch) {
        const providerType = decodeURIComponent(singleTestMatch[1]);
        const providerUuid = singleTestMatch[2];

        try {
            if (!providerPoolManager) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
                return true;
            }

            const providers = providerPoolManager.providerStatus[providerType] || [];
            const providerStatus = providers.find(p => p.config.uuid === providerUuid);

            if (!providerStatus) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
                return true;
            }

            const providerConfig = providerStatus.config;
            console.log(`[UI API] Testing provider ${providerUuid}`);

            // Use health check to test the provider
            const testResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);

            if (testResult === null) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: '测试不支持此提供商类型' }));
                return true;
            }

            if (testResult.success) {
                providerPoolManager.markProviderHealthy(providerType, providerConfig, false, testResult.modelName);

                // Save to file
                const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
                const providerPools = {};
                for (const pType in providerPoolManager.providerStatus) {
                    providerPools[pType] = providerPoolManager.providerStatus[pType].map(ps => ps.config);
                }
                writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: testResult.success,
                message: testResult.success ? `测试成功，模型: ${testResult.modelName}` : testResult.error,
                modelName: testResult.modelName,
                error: testResult.error
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Provider test error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Perform health check for all providers of a specific type
    const healthCheckMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/health-check$/);
    if (method === 'POST' && healthCheckMatch) {
        const providerType = decodeURIComponent(healthCheckMatch[1]);

        try {
            if (!providerPoolManager) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
                return true;
            }

            // 解析请求体获取可选的池类型筛选参数
            let poolFilter = null; // 'healthy', 'checking', 'banned', or null for all
            try {
                const bodyStr = await collectRequestBody(req);
                if (bodyStr) {
                    const body = JSON.parse(bodyStr);
                    poolFilter = body.pool || null;
                }
            } catch (e) {
                // 没有请求体或解析失败，使用默认值（检查全部）
            }

            let providers = providerPoolManager.providerStatus[providerType] || [];

            // 如果指定了池类型筛选，则过滤账号
            if (poolFilter) {
                providers = providers.filter(ps => {
                    const config = ps.config;
                    if (poolFilter === 'banned') {
                        // 异常池：禁用或不健康的账号
                        return config.isDisabled || !config.isHealthy;
                    } else if (poolFilter === 'checking') {
                        // 检查池：健康但有错误记录的账号
                        return config.isHealthy && !config.isDisabled && config.errorCount > 0;
                    } else if (poolFilter === 'healthy') {
                        // 健康池：健康且无错误的账号
                        return config.isHealthy && !config.isDisabled && (!config.errorCount || config.errorCount === 0);
                    }
                    return true;
                });
            }

            if (providers.length === 0) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: poolFilter ? `${poolFilter === 'banned' ? '异常池' : poolFilter === 'checking' ? '检查池' : '健康池'}中没有账号` : 'No providers found for this type' } }));
                return true;
            }

            const poolName = poolFilter === 'banned' ? '异常池' : poolFilter === 'checking' ? '检查池' : poolFilter === 'healthy' ? '健康池' : '全部';
            console.log(`[UI API] Starting health check for ${providers.length} providers in ${providerType} (${poolName})`);

            // 执行健康检测（强制检查，忽略 checkHealth 配置）
            const results = [];
            for (const providerStatus of providers) {
                const providerConfig = providerStatus.config;
                try {
                    // 传递 forceCheck = true 强制执行健康检查，忽略 checkHealth 配置
                    const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);
                    
                    if (healthResult === null) {
                        results.push({
                            uuid: providerConfig.uuid,
                            success: null,
                            message: '健康检测不支持此提供商类型'
                        });
                        continue;
                    }
                    
                    if (healthResult.success) {
                        providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
                        results.push({
                            uuid: providerConfig.uuid,
                            success: true,
                            modelName: healthResult.modelName,
                            message: '健康'
                        });
                    } else {
                        providerPoolManager.markProviderUnhealthy(providerType, providerConfig, healthResult.errorMessage);
                        providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                        if (healthResult.modelName) {
                            providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                        }
                        results.push({
                            uuid: providerConfig.uuid,
                            success: false,
                            modelName: healthResult.modelName,
                            message: healthResult.errorMessage || '检测失败'
                        });
                    }
                } catch (error) {
                    providerPoolManager.markProviderUnhealthy(providerType, providerConfig, error.message);
                    results.push({
                        uuid: providerConfig.uuid,
                        success: false,
                        message: error.message
                    });
                }
            }

            // 保存更新后的状态到文件
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            
            // 从 providerStatus 构建 providerPools 对象并保存
            const providerPools = {};
            for (const pType in providerPoolManager.providerStatus) {
                providerPools[pType] = providerPoolManager.providerStatus[pType].map(ps => ps.config);
            }
            writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf8');

            const successCount = results.filter(r => r.success === true).length;
            const failCount = results.filter(r => r.success === false).length;

            console.log(`[UI API] Health check completed for ${providerType}: ${successCount} healthy, ${failCount} unhealthy`);

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'health_check',
                filePath: filePath,
                providerType,
                results,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `健康检测完成: ${successCount} 个健康, ${failCount} 个异常`,
                successCount,
                failCount,
                totalCount: providers.length,
                results
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Health check error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: error.message } }));
            return true;
        }
    }

    // Generate OAuth authorization URL for providers
    const generateAuthUrlMatch = pathParam.match(/^\/api\/providers\/([^\/]+)\/generate-auth-url$/);
    if (method === 'POST' && generateAuthUrlMatch) {
        const providerType = decodeURIComponent(generateAuthUrlMatch[1]);

        try {
            let authUrl = '';
            let authInfo = {};

            // 只支持 Kiro OAuth
            if (providerType === 'claude-kiro-oauth') {
                const result = await handleKiroOAuth(currentConfig, providerPoolManager);
                authUrl = result.authUrl;
                authInfo = result.authInfo;
            } else {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: `不支持的提供商类型: ${providerType}`
                    }
                }));
                return true;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                authUrl: authUrl,
                authInfo: authInfo
            }));
            return true;

        } catch (error) {
            console.error(`[UI API] Failed to generate auth URL for ${providerType}:`, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `生成授权链接失败: ${error.message}`
                }
            }));
            return true;
        }
    }

    // Get logs
    if (method === 'GET' && pathParam === '/api/logs') {
        res.writeHead(200, getNoCacheHeaders());
        res.end(JSON.stringify(global.logBuffer || []));
        return true;
    }

    // Clear logs
    if (method === 'DELETE' && pathParam === '/api/logs') {
        global.logBuffer = [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: '日志已清空' }));
        return true;
    }

    // Server-Sent Events for real-time updates
    if (method === 'GET' && pathParam === '/api/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Send initial comment to flush the connection and trigger browser's onopen event
        // This is critical - SSE spec requires initial data to trigger EventSource.onopen
        res.write(':\n\n');

        // Store the response object for broadcasting
        if (!global.eventClients) {
            global.eventClients = [];
        }
        global.eventClients.push(res);

        // Keep connection alive
        const keepAlive = setInterval(() => {
            res.write(':\n\n');
        }, 30000);

        req.on('close', () => {
            clearInterval(keepAlive);
            global.eventClients = global.eventClients.filter(r => r !== res);
        });

        return true;
    }

    // Get upload configuration files list
    if (method === 'GET' && pathParam === '/api/upload-configs') {
        try {
            const configFiles = await scanConfigFiles(currentConfig, providerPoolManager);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(configFiles));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to scan config files:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to scan config files: ' + error.message
                }
            }));
            return true;
        }
    }

    // View specific configuration file
    const viewConfigMatch = pathParam.match(/^\/api\/upload-configs\/view\/(.+)$/);
    if (method === 'GET' && viewConfigMatch) {
        try {
            const filePath = decodeURIComponent(viewConfigMatch[1]);
            const fullPath = path.join(process.cwd(), filePath);
            
            // 安全检查：确保文件路径在允许的目录内
            const allowedDirs = ['configs'];
            const relativePath = path.relative(process.cwd(), fullPath);
            const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
            
            if (!isAllowed) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: '访问被拒绝：只能查看configs目录下的文件'
                    }
                }));
                return true;
            }
            
            if (!existsSync(fullPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: '文件不存在'
                    }
                }));
                return true;
            }
            
            const content = await fs.readFile(fullPath, 'utf8');
            const stats = await fs.stat(fullPath);
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                path: relativePath,
                content: content,
                size: stats.size,
                modified: stats.mtime.toISOString(),
                name: path.basename(fullPath)
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to view config file:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to view config file: ' + error.message
                }
            }));
            return true;
        }
    }

    // Delete specific configuration file
    const deleteConfigMatch = pathParam.match(/^\/api\/upload-configs\/delete\/(.+)$/);
    if (method === 'DELETE' && deleteConfigMatch) {
        try {
            const filePath = decodeURIComponent(deleteConfigMatch[1]);
            const fullPath = path.join(process.cwd(), filePath);
            
            // 安全检查：确保文件路径在允许的目录内
            const allowedDirs = ['configs'];
            const relativePath = path.relative(process.cwd(), fullPath);
            const isAllowed = allowedDirs.some(dir => relativePath.startsWith(dir + path.sep) || relativePath === dir);
            
            if (!isAllowed) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: '访问被拒绝：只能删除configs目录下的文件'
                    }
                }));
                return true;
            }
            
            if (!existsSync(fullPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: '文件不存在'
                    }
                }));
                return true;
            }
            
            
            await fs.unlink(fullPath);
            
            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'delete',
                filePath: relativePath,
                timestamp: new Date().toISOString()
            });
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: '文件删除成功',
                filePath: relativePath
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to delete config file:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: 'Failed to delete config file: ' + error.message
                }
            }));
            return true;
        }
    }

    // Quick link config to corresponding provider based on directory
    if (method === 'POST' && pathParam === '/api/quick-link-provider') {
        try {
            const body = await getRequestBody(req);
            const { filePath } = body;

            if (!filePath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'filePath is required' } }));
                return true;
            }

            const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
            
            // 根据文件路径自动识别提供商类型
            const providerMapping = detectProviderFromPath(normalizedPath);
            
            if (!providerMapping) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: {
                        message: '无法识别配置文件对应的提供商类型，请确保文件位于 configs/kiro/、configs/gemini/、configs/qwen/ 或 configs/antigravity/ 目录下'
                    }
                }));
                return true;
            }

            const { providerType, credPathKey, defaultCheckModel, displayName } = providerMapping;
            const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            
            // Load existing pools
            let providerPools = {};
            if (existsSync(poolsFilePath)) {
                try {
                    const fileContent = readFileSync(poolsFilePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                } catch (readError) {
                    console.warn('[UI API] Failed to read existing provider pools:', readError.message);
                }
            }

            // Ensure provider type array exists
            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }

            // Check if already linked - 使用标准化路径进行比较
            const normalizedForComparison = filePath.replace(/\\/g, '/');
            const isAlreadyLinked = providerPools[providerType].some(p => {
                const existingPath = p[credPathKey];
                if (!existingPath) return false;
                const normalizedExistingPath = existingPath.replace(/\\/g, '/');
                return normalizedExistingPath === normalizedForComparison ||
                       normalizedExistingPath === './' + normalizedForComparison ||
                       './' + normalizedExistingPath === normalizedForComparison;
            });

            if (isAlreadyLinked) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: '该配置文件已关联' } }));
                return true;
            }

            // Create new provider config based on provider type
            const newProvider = createProviderConfig({
                credPathKey,
                credPath: formatSystemPath(filePath),
                defaultCheckModel,
                needsProjectId: providerMapping.needsProjectId
            });

            providerPools[providerType].push(newProvider);

            // Save to file
            writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf8');
            console.log(`[UI API] Quick linked config: ${filePath} -> ${providerType}`);

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // Broadcast update event
            broadcastEvent('config_update', {
                action: 'quick_link',
                filePath: poolsFilePath,
                providerType,
                newProvider,
                timestamp: new Date().toISOString()
            });

            broadcastEvent('provider_update', {
                action: 'add',
                providerType,
                providerConfig: newProvider,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: `配置已成功关联到 ${displayName}`,
                provider: newProvider,
                providerType: providerType
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Quick link failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: '关联失败: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get usage limits for all providers
    if (method === 'GET' && pathParam === '/api/usage') {
        try {
            // 解析查询参数，检查是否需要强制刷新
            const url = new URL(req.url, `http://${req.headers.host}`);
            const refresh = url.searchParams.get('refresh') === 'true';
            
            let usageResults;
            
            if (!refresh) {
                // 优先读取缓存
                const cachedData = await readUsageCache();
                if (cachedData) {
                    console.log('[Usage API] Returning cached usage data');
                    usageResults = { ...cachedData, fromCache: true };
                }
            }
            
            if (!usageResults) {
                // 缓存不存在或需要刷新，重新查询
                console.log('[Usage API] Fetching fresh usage data');
                usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager);
                // 写入缓存
                await writeUsageCache(usageResults);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(usageResults));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to get usage:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: '获取用量信息失败: ' + error.message
                }
            }));
            return true;
        }
    }

    // Get usage limits for a specific provider type
    const usageProviderMatch = pathParam.match(/^\/api\/usage\/([^\/]+)$/);
    if (method === 'GET' && usageProviderMatch) {
        const providerType = decodeURIComponent(usageProviderMatch[1]);
        try {
            // 解析查询参数，检查是否需要强制刷新
            const url = new URL(req.url, `http://${req.headers.host}`);
            const refresh = url.searchParams.get('refresh') === 'true';
            
            let usageResults;
            
            if (!refresh) {
                // 优先读取缓存
                const cachedData = await readProviderUsageCache(providerType);
                if (cachedData) {
                    console.log(`[Usage API] Returning cached usage data for ${providerType}`);
                    usageResults = cachedData;
                }
            }
            
            if (!usageResults) {
                // 缓存不存在或需要刷新，重新查询
                console.log(`[Usage API] Fetching fresh usage data for ${providerType}`);
                usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
                // 更新缓存
                await updateProviderUsageCache(providerType, usageResults);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(usageResults));
            return true;
        } catch (error) {
            console.error(`[UI API] Failed to get usage for ${providerType}:`, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `获取 ${providerType} 用量信息失败: ` + error.message
                }
            }));
            return true;
        }
    }

    // Get usage for a specific account (single account refresh)
    const usageAccountMatch = pathParam.match(/^\/api\/usage\/([^\/]+)\/([^\/]+)$/);
    if (method === 'GET' && usageAccountMatch) {
        const providerType = decodeURIComponent(usageAccountMatch[1]);
        const uuid = decodeURIComponent(usageAccountMatch[2]);
        try {
            // 解析查询参数，检查是否需要强制刷新
            const url = new URL(req.url, `http://${req.headers.host}`);
            const refresh = url.searchParams.get('refresh') === 'true';

            console.log(`[Usage API] Fetching usage data for ${providerType}/${uuid} (refresh: ${refresh})`);

            // 获取该提供商的所有账号用量
            let usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);

            // 找到指定的账号
            const accountUsage = usageResults?.instances?.find(i => i.uuid === uuid);

            if (accountUsage) {
                // 更新整个提供商的缓存
                await updateProviderUsageCache(providerType, usageResults);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    account: accountUsage,
                    timestamp: new Date().toISOString()
                }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: { message: `未找到账号 ${uuid}` }
                }));
            }
            return true;
        } catch (error) {
            console.error(`[UI API] Failed to get usage for ${providerType}/${uuid}:`, error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: `获取账号用量失败: ` + error.message
                }
            }));
            return true;
        }
    }

    // 清理重复的 token（相同 userId）
    if (method === 'POST' && pathParam === '/api/providers/cleanup-duplicates') {
        try {
            const body = await parseRequestBody(req);
            const { providerType = 'claude-kiro-oauth', dryRun = true } = body;

            // 获取提供商池
            let providers = [];
            if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
                providers = providerPoolManager.providerPools[providerType];
            } else if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
                providers = currentConfig.providerPools[providerType];
            }

            // 按 userId 分组
            const userIdGroups = {};
            const noUserIdProviders = [];

            for (const provider of providers) {
                if (provider.cachedUserId) {
                    if (!userIdGroups[provider.cachedUserId]) {
                        userIdGroups[provider.cachedUserId] = [];
                    }
                    userIdGroups[provider.cachedUserId].push(provider);
                } else {
                    noUserIdProviders.push(provider);
                }
            }

            // 找出重复的（同一 userId 有多个 token）
            const duplicates = [];
            const toKeep = [];
            const toRemove = [];

            for (const [userId, group] of Object.entries(userIdGroups)) {
                if (group.length > 1) {
                    // 保留第一个，标记其他为重复
                    toKeep.push(group[0]);
                    for (let i = 1; i < group.length; i++) {
                        duplicates.push({
                            uuid: group[i].uuid,
                            path: group[i].KIRO_OAUTH_CREDS_FILE_PATH,
                            email: group[i].cachedEmail,
                            userId: userId,
                            duplicateOf: group[0].KIRO_OAUTH_CREDS_FILE_PATH
                        });
                        toRemove.push(group[i]);
                    }
                } else {
                    toKeep.push(group[0]);
                }
            }

            // 如果不是 dry run，执行删除
            if (!dryRun && toRemove.length > 0) {
                const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
                const removeUuids = new Set(toRemove.map(p => p.uuid));

                // 过滤掉重复的 provider
                const filteredProviders = providers.filter(p => !removeUuids.has(p.uuid));

                // 更新 provider pool
                if (providerPoolManager && providerPoolManager.providerPools) {
                    providerPoolManager.providerPools[providerType] = filteredProviders;
                }
                if (currentConfig.providerPools) {
                    currentConfig.providerPools[providerType] = filteredProviders;
                }

                // 保存到文件
                let currentPools = {};
                if (existsSync(filePath)) {
                    currentPools = JSON.parse(readFileSync(filePath, 'utf8'));
                }
                currentPools[providerType] = filteredProviders;
                writeFileSync(filePath, JSON.stringify(currentPools, null, 2), 'utf8');

                console.log(`[Cleanup] Removed ${toRemove.length} duplicate providers`);
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                dryRun,
                providerType,
                summary: {
                    total: providers.length,
                    unique: toKeep.length + noUserIdProviders.length,
                    duplicates: duplicates.length,
                    noUserId: noUserIdProviders.length
                },
                duplicates,
                message: dryRun
                    ? `发现 ${duplicates.length} 个重复 token，设置 dryRun=false 执行清理`
                    : `已清理 ${duplicates.length} 个重复 token`
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to cleanup duplicates:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: '清理重复 token 失败: ' + error.message
                }
            }));
            return true;
        }
    }

    // Kiro OAuth: 检查 state 是否已完成授权
    if (method === 'GET' && pathParam === '/api/kiro/oauth/check-state') {
        try {
            const urlObj = new URL(req.url, `http://${req.headers.host}`);
            const state = urlObj.searchParams.get('state');

            if (!state) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Missing state parameter' }));
                return true;
            }

            // 检查 state 是否还存在（存在说明未完成，不存在说明已被消费/完成）
            const stateData = kiroOAuthStates.get(state);

            if (stateData) {
                // state 还在，说明授权未完成
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ completed: false }));
            } else {
                // state 已被消费，说明授权已完成
                // 尝试从完成记录中获取账号信息
                const completedInfo = kiroOAuthCompletedStates?.get(state) || {};
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    completed: true,
                    accountNumber: completedInfo.accountNumber
                }));
            }
            return true;
        } catch (error) {
            console.error('[Kiro OAuth] Check state error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
            return true;
        }
    }

    // Kiro OAuth: 生成OAuth URL
    if (method === 'POST' && pathParam === '/api/kiro/oauth/generate-url') {
        try {
            const body = await parseRequestBody(req);
            const { provider = 'Github', accountNumber = 1, webMode = false } = body;

            // 验证provider
            if (!['Google', 'Github'].includes(provider)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'provider must be Google or Github'
                }));
                return true;
            }

            // 生成随机machineid（32字节hex）
            const machineid = crypto.randomBytes(32).toString('hex').toLowerCase();

            // 生成PKCE参数
            const codeVerifier = crypto.randomBytes(32).toString('base64url');
            const codeChallenge = crypto.createHash('sha256')
                .update(codeVerifier)
                .digest()
                .toString('base64url');
            const state = crypto.randomUUID();

            // 确定 redirect_uri
            let redirectUri = KIRO_OAUTH_CONFIG.REDIRECT_URI;
            if (webMode) {
                // 网页模式：使用请求的 Host 或配置的外部地址
                const host = req.headers.host || `127.0.0.1:${CONFIG.port || 23456}`;
                // 检查是否配置了外部访问地址
                const externalUrl = CONFIG.externalUrl;
                if (externalUrl) {
                    // 使用配置的外部地址
                    redirectUri = `${externalUrl.replace(/\/$/, '')}/kiro/oauth/web-callback`;
                } else {
                    // 使用请求的 Host（保持协议一致）
                    const protocol = req.headers['x-forwarded-proto'] || 'http';
                    redirectUri = `${protocol}://${host}/kiro/oauth/web-callback`;
                }
                console.log(`[Kiro OAuth] Web mode redirect_uri: ${redirectUri}`);
            }

            // 存储OAuth状态（30分钟过期，增加容错时间）
            kiroOAuthStates.set(state, {
                code_verifier: codeVerifier,
                machineid: machineid,
                timestamp: Date.now(),
                accountNumber: accountNumber,
                provider: provider,
                webMode: webMode,
                redirectUri: redirectUri  // 保存 redirect_uri 确保回调时一致
            });

            // 持久化到文件（异步，不阻塞响应）
            saveOAuthStates().catch(err => {
                console.error('[Kiro OAuth] Failed to persist state:', err.message);
            });

            // 清理过期的state（超过30分钟）
            setTimeout(() => {
                const stateData = kiroOAuthStates.get(state);
                if (stateData && Date.now() - stateData.timestamp > 30 * 60 * 1000) {
                    kiroOAuthStates.delete(state);
                    console.log(`[Kiro OAuth] Cleaned up expired state: ${state}`);
                    // 清理后也保存到文件
                    saveOAuthStates().catch(err => {
                        console.error('[Kiro OAuth] Failed to persist after cleanup:', err.message);
                    });
                }
            }, 30 * 60 * 1000);

            console.log(`[Kiro OAuth] State stored (memory + file), total states: ${kiroOAuthStates.size}`);
            console.log(`[Kiro OAuth] State will expire at: ${new Date(Date.now() + 30 * 60 * 1000).toISOString()}`);
            console.log(`[Kiro OAuth] Using ${webMode ? 'WEB' : 'KIRO://'} mode, redirect_uri: ${redirectUri}`);

            // 构建OAuth URL
            const params = new URLSearchParams({
                idp: provider,
                redirect_uri: redirectUri,
                code_challenge: codeChallenge,
                code_challenge_method: 'S256',
                state: state
            });

            const authUrl = `${KIRO_OAUTH_CONFIG.LOGIN_ENDPOINT}?${params.toString()}`;

            console.log(`[Kiro OAuth] Generated OAuth URL for ${provider}, state=${state}, machineid=${machineid.substring(0, 8)}..., accountNumber=${accountNumber}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                auth_url: authUrl,
                state: state,
                expires_in: 1800,  // 30分钟过期时间
                webMode: webMode
            }));
            return true;
        } catch (error) {
            console.error('[Kiro OAuth] Failed to generate OAuth URL:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
            return true;
        }
    }

    // Kiro OAuth callback handler (for AntiHook)
    if (method === 'POST' && pathParam === '/api/kiro/oauth/callback') {
        try {
            const body = await parseRequestBody(req);
            const callbackUrl = body.callback_url;

            if (!callbackUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Missing callback_url parameter'
                }));
                return true;
            }

            console.log('[Kiro OAuth] Received callback from AntiHook:', callbackUrl);

            // 解析callback URL中的参数
            const url = new URL(callbackUrl);
            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Missing authorization code in callback URL'
                }));
                return true;
            }

            // 从内存中获取OAuth状态
            const oauthState = kiroOAuthStates.get(state);
            if (!oauthState) {
                console.error('[Kiro OAuth] Invalid or expired state:', state);
                console.error('[Kiro OAuth] Available states:', Array.from(kiroOAuthStates.keys()));
                console.error('[Kiro OAuth] Total states in memory:', kiroOAuthStates.size);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Invalid or expired state parameter. 可能原因：1) 服务器已重启 2) state已过期(30分钟) 3) 请重新生成OAuth URL'
                }));
                return true;
            }

            console.log('[Kiro OAuth] Authorization code received, exchanging for tokens...');
            console.log(`[Kiro OAuth] Using machineid: ${oauthState.machineid.substring(0, 8)}...`);
            console.log(`[Kiro OAuth] Provider: ${oauthState.provider}`);
            console.log(`[Kiro OAuth] Code length: ${code.length}`);
            console.log(`[Kiro OAuth] Code preview: ${code.substring(0, 20)}...`);

            // 调用Kiro的token exchange API (使用PKCE和machineid)
            // 尝试发送JSON格式而不是form data
            const requestBody = {
                grant_type: 'authorization_code',
                code: code,
                code_verifier: oauthState.code_verifier,
                redirect_uri: KIRO_OAUTH_CONFIG.REDIRECT_URI
            };

            console.log('[Kiro OAuth] Token exchange request body:', JSON.stringify(requestBody, null, 2));
            console.log('[Kiro OAuth] Token endpoint:', KIRO_OAUTH_CONFIG.TOKEN_ENDPOINT);
            console.log('[Kiro OAuth] User-Agent:', `KiroIDE-${KIRO_OAUTH_CONFIG.IDE_VERSION}-${oauthState.machineid}`);

            const tokenResponse = await fetch(KIRO_OAUTH_CONFIG.TOKEN_ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'user-agent': `KiroIDE-${KIRO_OAUTH_CONFIG.IDE_VERSION}-${oauthState.machineid}`
                },
                body: JSON.stringify(requestBody)
            });

            console.log('[Kiro OAuth] Token response status:', tokenResponse.status);
            console.log('[Kiro OAuth] Token response headers:', JSON.stringify(Object.fromEntries(tokenResponse.headers.entries()), null, 2));

            if (!tokenResponse.ok) {
                const errorText = await tokenResponse.text();
                console.error('[Kiro OAuth] Token exchange failed:', errorText);
                console.error('[Kiro OAuth] Response status:', tokenResponse.status);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: 'Token exchange failed: ' + errorText
                }));
                return true;
            }

            const tokenData = await tokenResponse.json();
            console.log('[Kiro OAuth] Token exchange successful');
            console.log('[Kiro OAuth] Full token response:', JSON.stringify(tokenData, null, 2));
            console.log(`[Kiro OAuth] ProfileArn: ${tokenData.profileArn}`);

            // 保存token到文件（使用accountNumber命名，放在configs/kiro目录下）
            const accountNumber = oauthState.accountNumber || 1;

            // 保存完成状态供前端查询（5分钟后自动清理）
            kiroOAuthCompletedStates.set(state, {
                accountNumber: accountNumber,
                completedAt: Date.now()
            });
            setTimeout(() => kiroOAuthCompletedStates.delete(state), 5 * 60 * 1000);

            // 删除已使用的state
            kiroOAuthStates.delete(state);

            // 持久化删除操作
            saveOAuthStates().catch(err => {
                console.error('[Kiro OAuth] Failed to persist after state deletion:', err.message);
            });

            const kiroConfigDir = path.join(process.cwd(), 'configs', 'kiro');

            // 确保目录存在
            await fs.mkdir(kiroConfigDir, { recursive: true });

            const tokenFilePath = path.join(kiroConfigDir, `kiro-auth-token-${accountNumber}.json`);

            const credentialsData = {
                accessToken: tokenData.accessToken,
                refreshToken: tokenData.refreshToken,
                profileArn: tokenData.profileArn,
                expiresAt: tokenData.expiresAt || new Date(Date.now() + 3600000).toISOString(),
                authMethod: 'social',
                provider: oauthState.provider  // 使用用户选择的 provider，而不是 API 响应
            };

            await fs.writeFile(tokenFilePath, JSON.stringify(credentialsData, null, 2));
            console.log('[Kiro OAuth] Token saved to:', tokenFilePath);

            // 自动添加到 provider_pools.json
            let userId = null;
            let email = null;
            let isDuplicate = false;
            let duplicateProvider = null;

            try {
                const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
                let providerPools = {};

                // 读取现有池
                if (existsSync(poolsFilePath)) {
                    const fileContent = readFileSync(poolsFilePath, 'utf8');
                    providerPools = JSON.parse(fileContent);
                }

                // 确保 claude-kiro-oauth 数组存在
                if (!providerPools['claude-kiro-oauth']) {
                    providerPools['claude-kiro-oauth'] = [];
                }

                // 检查是否已存在相同路径的配置
                const relativePath = path.relative(process.cwd(), tokenFilePath);
                const normalizedPath = relativePath.replace(/\\/g, '/');
                const exists = providerPools['claude-kiro-oauth'].some(p => {
                    const existingPath = (p.KIRO_OAUTH_CREDS_FILE_PATH || '').replace(/\\/g, '/');
                    return existingPath === normalizedPath || existingPath === './' + normalizedPath;
                });

                if (!exists) {
                    // 在添加之前，检查是否为重复账号

                    try {
                        // 临时初始化服务获取 userId
                        console.log('[Kiro OAuth] Checking for duplicate account...');
                        const { KiroApiService } = await import('./claude/claude-kiro.js');
                        const tempConfig = {
                            KIRO_OAUTH_CREDS_FILE_PATH: tokenFilePath
                        };
                        const tempService = new KiroApiService(tempConfig);
                        await tempService.initialize();

                        // 获取用量信息
                        const usageData = await tempService.getUsageLimits();
                        if (usageData && usageData.userInfo) {
                            userId = usageData.userInfo.userId;
                            email = usageData.userInfo.email;
                            console.log(`[Kiro OAuth] Account info: ${email} (userId: ${userId})`);

                            // 检查是否已存在相同的 userId
                            duplicateProvider = findDuplicateUserId(providerPools['claude-kiro-oauth'], userId);
                            if (duplicateProvider) {
                                isDuplicate = true;
                                console.warn(`[Kiro OAuth] 检测到重复账号: ${email}`);
                                console.warn(`[Kiro OAuth] 已存在的 token: ${duplicateProvider.path}`);

                                // 删除刚保存的重复 token 文件
                                try {
                                    await fs.unlink(tokenFilePath);
                                    console.log(`[Kiro OAuth] 已删除重复的 token 文件: ${tokenFilePath}`);
                                } catch (unlinkError) {
                                    console.error(`[Kiro OAuth] 删除重复 token 文件失败:`, unlinkError.message);
                                }

                                // 抛出错误，阻止添加到 provider pool
                                throw new Error(`重复账号：该账号 (${email}) 已存在，已有 token: ${duplicateProvider.path}。请使用不同的账号授权，或者退出当前账号后重新授权。`);
                            }
                        }
                    } catch (checkError) {
                        // 如果是重复账号错误，向上抛出
                        if (checkError.message.includes('重复账号')) {
                            throw checkError;
                        }
                        console.warn('[Kiro OAuth] Failed to check duplicate account:', checkError.message);
                        // 其他检查失败不阻止添加，继续执行
                    }

                    // 创建新的提供商配置
                    const newProvider = {
                        uuid: generateUUID(),
                        KIRO_OAUTH_CREDS_FILE_PATH: normalizedPath,
                        isHealthy: true,
                        usageCount: 0,
                        errorCount: 0,
                        lastUsed: null,
                        lastErrorTime: null,
                        isDisabled: false,
                        lastHealthCheckTime: new Date().toISOString(),
                        lastHealthCheckModel: 'claude-haiku-4-5',
                        lastErrorMessage: null,
                        checkModelName: '',
                        checkHealth: true,
                        notSupportedModels: [],
                        cachedUserId: userId,
                        cachedEmail: email,
                        cachedAt: userId ? new Date().toISOString() : null,
                        isDuplicate: isDuplicate,
                        duplicateOf: duplicateProvider ? duplicateProvider.path : null
                    };

                    providerPools['claude-kiro-oauth'].push(newProvider);

                    // 保存到文件
                    writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf8');
                    console.log(`[Kiro OAuth] Auto-added to provider pool with UUID: ${newProvider.uuid}`);

                    // 更新 provider pool manager
                    if (providerPoolManager) {
                        providerPoolManager.providerPools = providerPools;
                        providerPoolManager.initializeProviderStatus();
                    }

                    // 广播提供商更新事件
                    broadcastEvent('provider_update', {
                        action: 'add',
                        providerType: 'claude-kiro-oauth',
                        providerConfig: newProvider,
                        timestamp: new Date().toISOString()
                    });
                } else {
                    console.log('[Kiro OAuth] Provider already exists in pool, skipping auto-add');
                }
            } catch (error) {
                console.error('[Kiro OAuth] Failed to auto-add to provider pool:', error.message);
                // 不阻止OAuth成功，继续执行
            }

            // 广播OAuth成功事件（前端会自动清除 Kiro session）
            broadcastEvent('oauth_success', {
                provider: 'claude-kiro-oauth',
                credPath: tokenFilePath,
                profileArn: tokenData.profileArn,
                email: email,
                isDuplicate: isDuplicate,
                duplicateOf: duplicateProvider ? duplicateProvider.path : null,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: isDuplicate
                    ? `OAuth 成功，但检测到重复账号 (${email})，已存在 token: ${duplicateProvider.path}`
                    : 'Kiro OAuth successful',
                tokenFile: tokenFilePath,
                profileArn: tokenData.profileArn,
                email: email,
                isDuplicate: isDuplicate,
                duplicateOf: duplicateProvider ? duplicateProvider.path : null,
                warning: isDuplicate ? `该账号 (${email}) 已存在于系统中，与 ${duplicateProvider.path} 共享配额` : null
            }));
            return true;
        } catch (error) {
            console.error('[Kiro OAuth] Callback processing failed:', error);

            // 检查是否是重复账号错误
            const isDuplicateError = error.message.includes('重复账号');
            const statusCode = isDuplicateError ? 409 : 500;  // 409 Conflict for duplicates

            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message,
                isDuplicate: isDuplicateError,
                errorType: isDuplicateError ? 'DUPLICATE_ACCOUNT' : 'OAUTH_ERROR'
            }));
            return true;
        }
    }

    // AWS SSO BuilderId 设备授权流程 (自动注册Client，无需用户输入)
    // Manual import of Kiro OAuth refreshToken
    if (method === 'POST' && pathParam === '/api/kiro/oauth/manual-import') {
        try {
            const body = await parseRequestBody(req);
            const { refreshToken, profileArn, accountNumber = 1 } = body;

            if (!refreshToken) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: '请提供 refreshToken'
                }));
                return true;
            }

            if (!refreshToken.startsWith('aorAAAAAG')) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: 'RefreshToken 格式不正确，应该以 aorAAAAAG 开头'
                }));
                return true;
            }

            console.log(`[Kiro Manual Import] Importing refreshToken for account ${accountNumber}`);

            // Test refresh by calling Kiro token refresh API
            const REFRESH_URL = 'https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token';
            const axios = (await import('axios')).default;

            try {
                const refreshResponse = await axios.post(REFRESH_URL, {
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: 30000
                });

                const { accessToken: newAccessToken, expiresAt, profileArn: fetchedProfileArn } = refreshResponse.data;
                const finalProfileArn = profileArn || fetchedProfileArn;

                console.log('[Kiro Manual Import] RefreshToken validated and refreshed successfully');
                console.log(`[Kiro Manual Import] ProfileArn: ${finalProfileArn}`);

                // Save token to configs/kiro directory
                const kiroConfigDir = path.join(process.cwd(), 'configs', 'kiro');
                await fs.mkdir(kiroConfigDir, { recursive: true });

                const tokenFilePath = path.join(kiroConfigDir, `kiro-auth-token-${accountNumber}.json`);
                const credentialsData = {
                    accessToken: newAccessToken,
                    refreshToken: refreshToken,
                    profileArn: finalProfileArn,
                    expiresAt: expiresAt || new Date(Date.now() + 3600000).toISOString(),
                    authMethod: 'manual-import',
                    provider: 'Manual'
                };

                await fs.writeFile(tokenFilePath, JSON.stringify(credentialsData, null, 2));
                console.log('[Kiro Manual Import] Token saved to:', tokenFilePath);

                // Check for duplicates and add to provider_pools.json
                let isDuplicate = false;
                let duplicateProvider = null;

                try {
                    const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
                    let providerPools = {};

                    if (existsSync(poolsFilePath)) {
                        const fileContent = readFileSync(poolsFilePath, 'utf8');
                        providerPools = JSON.parse(fileContent);
                    }

                    if (!providerPools['claude-kiro-oauth']) {
                        providerPools['claude-kiro-oauth'] = [];
                    }

                    // Check duplicate path
                    const relativePath = path.relative(process.cwd(), tokenFilePath);
                    const normalizedPath = relativePath.replace(/\\/g, '/');
                    const pathExists = providerPools['claude-kiro-oauth'].some(p => {
                        const existingPath = (p.KIRO_OAUTH_CREDS_FILE_PATH || '').replace(/\\/g, '/');
                        return existingPath === normalizedPath || existingPath === './' + normalizedPath;
                    });

                    // Check duplicate userId
                    const { userId } = await findDuplicateUserId(newAccessToken, finalProfileArn, providerPools['claude-kiro-oauth'], currentConfig);
                    if (userId) {
                        isDuplicate = true;
                        duplicateProvider = userId.existingProvider;
                        console.log(`[Kiro Manual Import] Duplicate account detected: ${userId.userId}`);

                        // Delete the token file
                        await fs.unlink(tokenFilePath);
                        console.log(`[Kiro Manual Import] Deleted duplicate token file: ${tokenFilePath}`);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            message: `检测到重复账号 (${userId.email || userId.userId})，已存在 token: ${duplicateProvider.KIRO_OAUTH_CREDS_FILE_PATH}`,
                            duplicate: true,
                            userId: userId.userId,
                            email: userId.email,
                            existingToken: duplicateProvider.KIRO_OAUTH_CREDS_FILE_PATH
                        }));
                        return true;
                    }

                    if (!pathExists) {
                        const newProvider = {
                            uuid: generateUUID(),
                            KIRO_OAUTH_CREDS_FILE_PATH: normalizedPath,
                            isHealthy: true,
                            usageCount: 0,
                            errorCount: 0,
                            lastUsed: null,
                            lastErrorTime: null,
                            isDisabled: false,
                            lastHealthCheckTime: new Date().toISOString(),
                            lastHealthCheckModel: 'claude-haiku-4-5',
                            lastErrorMessage: null,
                            checkModelName: '',
                            checkHealth: true,
                            notSupportedModels: []
                        };

                        providerPools['claude-kiro-oauth'].push(newProvider);
                        writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf8');
                        console.log(`[Kiro Manual Import] Added to provider pool with UUID: ${newProvider.uuid}`);

                        if (providerPoolManager) {
                            providerPoolManager.providerPools = providerPools;
                            providerPoolManager.initializeProviderStatus();
                        }

                        broadcastEvent('provider_update', {
                            action: 'add',
                            providerType: 'claude-kiro-oauth',
                            providerConfig: newProvider,
                            timestamp: new Date().toISOString()
                        });
                    }
                } catch (error) {
                    console.error('[Kiro Manual Import] Failed to add to provider pool:', error.message);
                }

                broadcastEvent('oauth_success', {
                    provider: 'claude-kiro-oauth-manual',
                    credPath: path.relative(process.cwd(), tokenFilePath),
                    timestamp: new Date().toISOString()
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'RefreshToken 导入成功',
                    tokenFile: tokenFilePath,
                    profileArn: finalProfileArn
                }));
                return true;
            } catch (refreshError) {
                console.error('[Kiro Manual Import] RefreshToken validation failed:', refreshError.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    message: `RefreshToken 无效或已过期: ${refreshError.message}`
                }));
                return true;
            }
        } catch (error) {
            console.error('[Kiro Manual Import] Error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                message: error.message
            }));
            return true;
        }
    }

    if (method === 'POST' && pathParam === '/api/kiro/oauth/aws-sso/start') {
        try {
            const body = await parseRequestBody(req);
            const { accountNumber = 1, startUrl } = body;

            const region = 'us-east-1';
            const finalStartUrl = startUrl || 'https://view.awsapps.com/start';

            // AWS SSO OIDC 的 scopes (从 Kiro 源码获取)
            const scopes = [
                'codewhisperer:completions',
                'codewhisperer:analysis',
                'codewhisperer:conversations',
                'codewhisperer:transformations',
                'codewhisperer:taskassist'
            ];

            console.log(`[AWS SSO] Starting automatic client registration...`);
            console.log(`[AWS SSO] Region: ${region}, Start URL: ${finalStartUrl}`);

            // Step 1: 自动注册 Client (调用 AWS SSO OIDC RegisterClient API)
            const registerClientUrl = `https://oidc.${region}.amazonaws.com/client/register`;

            // 随机化 Client 配置，降低批量注册特征
            const randomSuffix = Math.random().toString(36).substring(2, 8);
            const randomPort = 10000 + Math.floor(Math.random() * 50000);
            const clientNames = ['Kiro IDE', 'Kiro', 'Kiro Editor', 'Kiro Dev', 'AWS Kiro'];
            const randomClientName = clientNames[Math.floor(Math.random() * clientNames.length)];

            const registerClientBody = {
                clientName: `${randomClientName}-${randomSuffix}`,
                clientType: 'public',
                scopes: scopes,
                grantTypes: ['authorization_code', 'refresh_token'],
                redirectUris: [`http://127.0.0.1:${randomPort}/oauth/callback`],
                issuerUrl: finalStartUrl
            };

            const axios = (await import('axios')).default;
            const registerResponse = await axios.post(registerClientUrl, registerClientBody, {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            const { clientId, clientSecret, clientSecretExpiresAt } = registerResponse.data;

            if (!clientId || !clientSecret) {
                throw new Error('Failed to register client: missing clientId or clientSecret in response');
            }

            console.log(`[AWS SSO] Client registered successfully!`);
            console.log(`[AWS SSO] Client ID: ${clientId.substring(0, 10)}...`);
            console.log(`[AWS SSO] Client expires at: ${new Date(clientSecretExpiresAt * 1000).toISOString()}`);

            // 动态导入 KiroApiService
            const { KiroApiService } = await import('./claude/claude-kiro.js');

            // 创建临时实例用于设备授权
            const kiroService = new KiroApiService(currentConfig);
            kiroService.clientId = clientId;
            kiroService.clientSecret = clientSecret;
            kiroService.region = region;
            kiroService.authMethod = 'IdC';
            await kiroService.initialize(true); // skipAuthCheck=true 因为设备授权前没有现有凭据

            console.log(`[AWS SSO] Starting device authorization for account ${accountNumber}`);
            console.log(`[AWS SSO] Start URL: ${finalStartUrl}`);

            // 启动设备授权
            const deviceAuthInfo = await kiroService.startDeviceAuthorization(finalStartUrl);

            console.log(`[AWS SSO] Device authorization started`);
            console.log(`[AWS SSO] User Code: ${deviceAuthInfo.userCode}`);
            console.log(`[AWS SSO] Verification URI: ${deviceAuthInfo.verificationUriComplete}`);

            // 启动后台轮询（不等待完成）
            kiroService.pollDeviceToken(
                deviceAuthInfo.deviceCode,
                deviceAuthInfo.interval,
                deviceAuthInfo.expiresIn
            ).then(tokenResult => {
                // 轮询成功，保存token到configs/kiro目录
                const kiroConfigDir = path.join(process.cwd(), 'configs', 'kiro');

                // 确保目录存在
                fs.mkdir(kiroConfigDir, { recursive: true }).then(() => {
                    const tokenFilePath = path.join(kiroConfigDir, `kiro-auth-token-${accountNumber}.json`);
                    const credentialsData = {
                        accessToken: tokenResult.accessToken,
                        refreshToken: tokenResult.refreshToken,
                        expiresAt: tokenResult.expiresAt,
                        clientId: clientId,
                        clientSecret: clientSecret,
                        authMethod: 'IdC',
                        provider: 'BuilderId',
                        region: 'us-east-1'
                    };

                    fs.writeFile(tokenFilePath, JSON.stringify(credentialsData, null, 2))
                        .then(async () => {
                            console.log(`[AWS SSO] Token saved to: ${tokenFilePath}`);

                            // 自动添加到 provider_pools.json
                            try {
                                const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
                                let providerPools = {};

                                // 读取现有池
                                if (existsSync(poolsFilePath)) {
                                    const fileContent = readFileSync(poolsFilePath, 'utf8');
                                    providerPools = JSON.parse(fileContent);
                                }

                                // 确保 claude-kiro-oauth 数组存在
                                if (!providerPools['claude-kiro-oauth']) {
                                    providerPools['claude-kiro-oauth'] = [];
                                }

                                // 检查是否已存在相同路径的配置
                                const relativePath = path.relative(process.cwd(), tokenFilePath);
                                const normalizedPath = relativePath.replace(/\\/g, '/');
                                const exists = providerPools['claude-kiro-oauth'].some(p => {
                                    const existingPath = (p.KIRO_OAUTH_CREDS_FILE_PATH || '').replace(/\\/g, '/');
                                    return existingPath === normalizedPath || existingPath === './' + normalizedPath;
                                });

                                if (!exists) {
                                    // 创建新的提供商配置
                                    const newProvider = {
                                        uuid: generateUUID(),
                                        KIRO_OAUTH_CREDS_FILE_PATH: normalizedPath,
                                        isHealthy: true,
                                        usageCount: 0,
                                        errorCount: 0,
                                        lastUsed: null,
                                        lastErrorTime: null,
                                        isDisabled: false,
                                        lastHealthCheckTime: new Date().toISOString(),
                                        lastHealthCheckModel: 'claude-haiku-4-5',
                                        lastErrorMessage: null,
                                        checkModelName: '',
                                        checkHealth: true,
                                        notSupportedModels: []
                                    };

                                    providerPools['claude-kiro-oauth'].push(newProvider);

                                    // 保存到文件
                                    writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf8');
                                    console.log(`[AWS SSO] Auto-added to provider pool with UUID: ${newProvider.uuid}`);

                                    // 更新 provider pool manager
                                    if (providerPoolManager) {
                                        providerPoolManager.providerPools = providerPools;
                                        providerPoolManager.initializeProviderStatus();
                                    }

                                    // 广播提供商更新事件
                                    broadcastEvent('provider_update', {
                                        action: 'add',
                                        providerType: 'claude-kiro-oauth',
                                        providerConfig: newProvider,
                                        timestamp: new Date().toISOString()
                                    });
                                } else {
                                    // 已存在的账号，重置健康状态（因为 token 已刷新）
                                    const existingProvider = providerPools['claude-kiro-oauth'].find(p => {
                                        const existingPath = (p.KIRO_OAUTH_CREDS_FILE_PATH || '').replace(/\\/g, '/');
                                        return existingPath === normalizedPath || existingPath === './' + normalizedPath;
                                    });
                                    if (existingProvider) {
                                        existingProvider.isHealthy = true;
                                        existingProvider.errorCount = 0;
                                        existingProvider.lastErrorTime = null;
                                        existingProvider.lastErrorMessage = null;
                                        existingProvider.lastHealthCheckTime = new Date().toISOString();

                                        // 保存到文件
                                        writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf8');
                                        console.log(`[AWS SSO] Reset health status for existing provider: ${existingProvider.uuid}`);

                                        // 更新 provider pool manager
                                        if (providerPoolManager) {
                                            providerPoolManager.providerPools = providerPools;
                                            providerPoolManager.initializeProviderStatus();
                                        }

                                        // 广播提供商更新事件
                                        broadcastEvent('provider_update', {
                                            action: 'update',
                                            providerType: 'claude-kiro-oauth',
                                            providerConfig: existingProvider,
                                            timestamp: new Date().toISOString()
                                        });
                                    }
                                }
                            } catch (error) {
                                console.error('[AWS SSO] Failed to auto-add to provider pool:', error.message);
                                // 不阻止OAuth成功，继续执行
                            }

                            // 广播OAuth成功事件
                            broadcastEvent('oauth_success', {
                                provider: 'claude-kiro-oauth-builderid',
                                credPath: path.relative(process.cwd(), tokenFilePath),
                                timestamp: new Date().toISOString()
                            });
                        })
                        .catch(err => {
                            console.error(`[AWS SSO] Failed to save token:`, err);
                        });
                }).catch(err => {
                    console.error(`[AWS SSO] Failed to create directory:`, err);
                });
            }).catch(error => {
                console.error('[AWS SSO] Background polling failed:', error.message);
                // 广播OAuth失败事件
                broadcastEvent('oauth_error', {
                    provider: 'claude-kiro-oauth-builderid',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            });

            // 立即返回设备授权信息
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                deviceCode: deviceAuthInfo.deviceCode,
                userCode: deviceAuthInfo.userCode,
                verificationUri: deviceAuthInfo.verificationUri,
                verificationUriComplete: deviceAuthInfo.verificationUriComplete,
                expiresIn: deviceAuthInfo.expiresIn,
                interval: deviceAuthInfo.interval,
                message: 'Please open the verification URL in your browser and enter the user code to authorize.',
                instructions: `访问 ${deviceAuthInfo.verificationUriComplete} 并授权。系统会自动轮询获取token。`
            }));
            return true;
        } catch (error) {
            console.error('[AWS SSO] Failed to start device authorization:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                error: error.message
            }));
            return true;
        }
    }

    // Reload configuration files
    if (method === 'POST' && pathParam === '/api/reload-config') {
        try {
            // 调用重载配置函数
            const newConfig = await reloadConfig(providerPoolManager);

            // 广播更新事件
            broadcastEvent('config_update', {
                action: 'reload',
                filePath: 'config.json',
                providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: '配置文件重新加载成功',
                details: {
                    configReloaded: true,
                    configPath: 'config.json',
                    providerPoolsPath: newConfig.PROVIDER_POOLS_FILE_PATH || null
                }
            }));
            return true;
        } catch (error) {
            console.error('[UI API] Failed to reload config files:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: {
                    message: '重新加载配置文件失败: ' + error.message
                }
            }));
            return true;
        }
    }

    return false;
}

/**
 * Initialize UI management features
 */
export function initializeUIManagement() {
    // Initialize log broadcasting for UI
    if (!global.eventClients) {
        global.eventClients = [];
    }
    if (!global.logBuffer) {
        global.logBuffer = [];
    }

    // Override console.log to broadcast logs
    const originalLog = console.log;
    console.log = function(...args) {
        originalLog.apply(console, args);
        const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: message
        };
        global.logBuffer.push(logEntry);
        if (global.logBuffer.length > 100) {
            global.logBuffer.shift();
        }
        broadcastEvent('log', logEntry);
    };

    // Override console.error to broadcast errors
    const originalError = console.error;
    console.error = function(...args) {
        originalError.apply(console, args);
        const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
        const logEntry = {
            timestamp: new Date().toISOString(),
            level: 'error',
            message: message
        };
        global.logBuffer.push(logEntry);
        if (global.logBuffer.length > 100) {
            global.logBuffer.shift();
        }
        broadcastEvent('log', logEntry);
    };
}

/**
 * Helper function to broadcast events to UI clients
 * @param {string} eventType - The type of event
 * @param {any} data - The data to broadcast
 */
export function broadcastEvent(eventType, data) {
    if (global.eventClients && global.eventClients.length > 0) {
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        global.eventClients.forEach(client => {
            client.write(`event: ${eventType}\n`);
            client.write(`data: ${payload}\n\n`);
        });
    }
}

/**
 * Scan and analyze configuration files
 * @param {Object} currentConfig - The current configuration object
 * @param {Object} providerPoolManager - Provider pool manager instance
 * @returns {Promise<Array>} Array of configuration file objects
 */
async function scanConfigFiles(currentConfig, providerPoolManager) {
    const configFiles = [];
    
    // 只扫描configs目录
    const configsPath = path.join(process.cwd(), 'configs');
    
    if (!existsSync(configsPath)) {
        // console.log('[Config Scanner] configs directory not found, creating empty result');
        return configFiles;
    }

    const usedPaths = new Set(); // 存储已使用的路径，用于判断关联状态

    // 从配置中提取所有OAuth凭据文件路径 - 标准化路径格式
    addToUsedPaths(usedPaths, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH);
    addToUsedPaths(usedPaths, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH);
    addToUsedPaths(usedPaths, currentConfig.QWEN_OAUTH_CREDS_FILE_PATH);

    // 使用最新的提供商池数据
    let providerPools = currentConfig.providerPools;
    if (providerPoolManager && providerPoolManager.providerPools) {
        providerPools = providerPoolManager.providerPools;
    }

    // 检查提供商池文件中的所有OAuth凭据路径 - 标准化路径格式
    if (providerPools) {
        for (const [providerType, providers] of Object.entries(providerPools)) {
            for (const provider of providers) {
                addToUsedPaths(usedPaths, provider.GEMINI_OAUTH_CREDS_FILE_PATH);
                addToUsedPaths(usedPaths, provider.KIRO_OAUTH_CREDS_FILE_PATH);
                addToUsedPaths(usedPaths, provider.QWEN_OAUTH_CREDS_FILE_PATH);
                addToUsedPaths(usedPaths, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH);
            }
        }
    }

    try {
        // 扫描configs目录下的所有子目录和文件
        const configsFiles = await scanOAuthDirectory(configsPath, usedPaths, currentConfig);
        configFiles.push(...configsFiles);
    } catch (error) {
        console.warn(`[Config Scanner] Failed to scan configs directory:`, error.message);
    }

    return configFiles;
}

/**
 * Analyze OAuth configuration file and return metadata
 * @param {string} filePath - Full path to the file
 * @param {Set} usedPaths - Set of paths currently in use
 * @returns {Promise<Object|null>} OAuth file information object
 */
async function analyzeOAuthFile(filePath, usedPaths, currentConfig) {
    try {
        const stats = await fs.stat(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const filename = path.basename(filePath);
        const relativePath = path.relative(process.cwd(), filePath);
        
        // 读取文件内容进行分析
        let content = '';
        let type = 'oauth_credentials';
        let isValid = true;
        let errorMessage = '';
        let oauthProvider = 'unknown';
        let usageInfo = getFileUsageInfo(relativePath, filename, usedPaths, currentConfig);
        
        try {
            if (ext === '.json') {
                const rawContent = await fs.readFile(filePath, 'utf8');
                const jsonData = JSON.parse(rawContent);
                content = rawContent;
                
                // 识别OAuth提供商
                if (jsonData.apiKey || jsonData.api_key) {
                    type = 'api_key';
                } else if (jsonData.client_id || jsonData.client_secret) {
                    oauthProvider = 'oauth2';
                } else if (jsonData.access_token || jsonData.refresh_token) {
                    oauthProvider = 'token_based';
                } else if (jsonData.credentials) {
                    oauthProvider = 'service_account';
                }
                
                if (jsonData.base_url || jsonData.endpoint) {
                    if (jsonData.base_url.includes('openai.com')) {
                        oauthProvider = 'openai';
                    } else if (jsonData.base_url.includes('anthropic.com')) {
                        oauthProvider = 'claude';
                    } else if (jsonData.base_url.includes('googleapis.com')) {
                        oauthProvider = 'gemini';
                    }
                }
            } else {
                content = await fs.readFile(filePath, 'utf8');
                
                if (ext === '.key' || ext === '.pem') {
                    if (content.includes('-----BEGIN') && content.includes('PRIVATE KEY-----')) {
                        oauthProvider = 'private_key';
                    }
                } else if (ext === '.txt') {
                    if (content.includes('api_key') || content.includes('apikey')) {
                        oauthProvider = 'api_key';
                    }
                } else if (ext === '.oauth' || ext === '.creds') {
                    oauthProvider = 'oauth_credentials';
                }
            }
        } catch (readError) {
            isValid = false;
            errorMessage = `无法读取文件: ${readError.message}`;
        }
        
        return {
            name: filename,
            path: relativePath,
            size: stats.size,
            type: type,
            provider: oauthProvider,
            extension: ext,
            modified: stats.mtime.toISOString(),
            isValid: isValid,
            errorMessage: errorMessage,
            isUsed: isPathUsed(relativePath, filename, usedPaths),
            usageInfo: usageInfo, // 新增详细关联信息
            preview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
        };
    } catch (error) {
        console.warn(`[OAuth Analyzer] Failed to analyze file ${filePath}:`, error.message);
        return null;
    }
}

/**
 * Get detailed usage information for a file
 * @param {string} relativePath - Relative file path
 * @param {string} fileName - File name
 * @param {Set} usedPaths - Set of used paths
 * @param {Object} currentConfig - Current configuration
 * @returns {Object} Usage information object
 */
function getFileUsageInfo(relativePath, fileName, usedPaths, currentConfig) {
    const usageInfo = {
        isUsed: false,
        usageType: null,
        usageDetails: []
    };

    // 检查是否被使用
    const isUsed = isPathUsed(relativePath, fileName, usedPaths);
    if (!isUsed) {
        return usageInfo;
    }

    usageInfo.isUsed = true;

    // 检查主要配置中的使用情况
    if (currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH &&
        (pathsEqual(relativePath, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH) ||
         pathsEqual(relativePath, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
        usageInfo.usageType = 'main_config';
        usageInfo.usageDetails.push({
            type: '主要配置',
            location: 'Gemini OAuth凭据文件路径',
            configKey: 'GEMINI_OAUTH_CREDS_FILE_PATH'
        });
    }

    if (currentConfig.KIRO_OAUTH_CREDS_FILE_PATH &&
        (pathsEqual(relativePath, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH) ||
         pathsEqual(relativePath, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
        usageInfo.usageType = 'main_config';
        usageInfo.usageDetails.push({
            type: '主要配置',
            location: 'Kiro OAuth凭据文件路径',
            configKey: 'KIRO_OAUTH_CREDS_FILE_PATH'
        });
    }

    if (currentConfig.QWEN_OAUTH_CREDS_FILE_PATH &&
        (pathsEqual(relativePath, currentConfig.QWEN_OAUTH_CREDS_FILE_PATH) ||
         pathsEqual(relativePath, currentConfig.QWEN_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
        usageInfo.usageType = 'main_config';
        usageInfo.usageDetails.push({
            type: '主要配置',
            location: 'Qwen OAuth凭据文件路径',
            configKey: 'QWEN_OAUTH_CREDS_FILE_PATH'
        });
    }

    // 检查提供商池中的使用情况
    if (currentConfig.providerPools) {
        // 使用 flatMap 将双重循环优化为单层循环 O(n)
        const allProviders = Object.entries(currentConfig.providerPools).flatMap(
            ([providerType, providers]) =>
                providers.map((provider, index) => ({ provider, providerType, index }))
        );

        for (const { provider, providerType, index } of allProviders) {
            const providerUsages = [];

            if (provider.GEMINI_OAUTH_CREDS_FILE_PATH &&
                (pathsEqual(relativePath, provider.GEMINI_OAUTH_CREDS_FILE_PATH) ||
                 pathsEqual(relativePath, provider.GEMINI_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
                providerUsages.push({
                    type: '提供商池',
                    location: `Gemini OAuth凭据 (节点${index + 1})`,
                    providerType: providerType,
                    providerIndex: index,
                    configKey: 'GEMINI_OAUTH_CREDS_FILE_PATH'
                });
            }

            if (provider.KIRO_OAUTH_CREDS_FILE_PATH &&
                (pathsEqual(relativePath, provider.KIRO_OAUTH_CREDS_FILE_PATH) ||
                 pathsEqual(relativePath, provider.KIRO_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
                providerUsages.push({
                    type: '提供商池',
                    location: `Kiro OAuth凭据 (节点${index + 1})`,
                    providerType: providerType,
                    providerIndex: index,
                    configKey: 'KIRO_OAUTH_CREDS_FILE_PATH'
                });
            }

            if (provider.QWEN_OAUTH_CREDS_FILE_PATH &&
                (pathsEqual(relativePath, provider.QWEN_OAUTH_CREDS_FILE_PATH) ||
                 pathsEqual(relativePath, provider.QWEN_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
                providerUsages.push({
                    type: '提供商池',
                    location: `Qwen OAuth凭据 (节点${index + 1})`,
                    providerType: providerType,
                    providerIndex: index,
                    configKey: 'QWEN_OAUTH_CREDS_FILE_PATH'
                });
            }

            if (provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH &&
                (pathsEqual(relativePath, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH) ||
                 pathsEqual(relativePath, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH.replace(/\\/g, '/')))) {
                providerUsages.push({
                    type: '提供商池',
                    location: `Antigravity OAuth凭据 (节点${index + 1})`,
                    providerType: providerType,
                    providerIndex: index,
                    configKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH'
                });
            }
            
            if (providerUsages.length > 0) {
                usageInfo.usageType = 'provider_pool';
                usageInfo.usageDetails.push(...providerUsages);
            }
        }
    }

    // 如果有多个使用位置，标记为多种用途
    if (usageInfo.usageDetails.length > 1) {
        usageInfo.usageType = 'multiple';
    }

    return usageInfo;
}

/**
 * Scan OAuth directory for credential files
 * @param {string} dirPath - Directory path to scan
 * @param {Set} usedPaths - Set of used paths
 * @param {Object} currentConfig - Current configuration
 * @returns {Promise<Array>} Array of OAuth configuration file objects
 */
async function scanOAuthDirectory(dirPath, usedPaths, currentConfig) {
    const oauthFiles = [];
    
    try {
        const files = await fs.readdir(dirPath, { withFileTypes: true });
        
        for (const file of files) {
            const fullPath = path.join(dirPath, file.name);
            
            if (file.isFile()) {
                const ext = path.extname(file.name).toLowerCase();
                // 只关注OAuth相关的文件类型
                if (['.json', '.oauth', '.creds', '.key', '.pem', '.txt'].includes(ext)) {
                    const fileInfo = await analyzeOAuthFile(fullPath, usedPaths, currentConfig);
                    if (fileInfo) {
                        oauthFiles.push(fileInfo);
                    }
                }
            } else if (file.isDirectory()) {
                // 递归扫描子目录（限制深度）
                const relativePath = path.relative(process.cwd(), fullPath);
                // 最大深度4层，以支持 configs/kiro/{subfolder}/file.json 这样的结构
                if (relativePath.split(path.sep).length < 4) {
                    const subFiles = await scanOAuthDirectory(fullPath, usedPaths, currentConfig);
                    oauthFiles.push(...subFiles);
                }
            }
        }
    } catch (error) {
        console.warn(`[OAuth Scanner] Failed to scan directory ${dirPath}:`, error.message);
    }
    
    return oauthFiles;
}


// 注意：normalizePath, getFileName, pathsEqual, isPathUsed, detectProviderFromPath
// 已移至 provider-utils.js 公共模块

/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
async function getAllProvidersUsage(currentConfig, providerPoolManager) {
    const results = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    // 支持用量查询的提供商列表 - 只支持 Kiro
    const supportedProviders = ['claude-kiro-oauth'];

    // 并发获取所有提供商的用量数据
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
            return { providerType, data: providerUsage, success: true };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    instances: []
                },
                success: false
            };
        }
    });

    // 等待所有并发请求完成
    const usageResults = await Promise.all(usagePromises);

    // 将结果整合到 results.providers 中
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
    }

    return results;
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 提供商用量信息
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager) {
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // 获取提供商池中的所有实例
    let providers = [];
    if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
        providers = providerPoolManager.providerPools[providerType];
    } else if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
        providers = currentConfig.providerPools[providerType];
    }

    result.totalCount = providers.length;

    // 遍历所有提供商实例获取用量
    for (const provider of providers) {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];

        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            email: provider.cachedEmail || getProviderDisplayName(provider, providerType),
            userId: provider.cachedUserId || null,
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            usageCount: provider.usageCount || 0,
            errorCount: provider.errorCount || 0,
            success: false,
            limits: null,
            error: null
        };

        // 首先检查是否已禁用，已禁用的提供商跳过初始化
        if (provider.isDisabled) {
            instanceResult.error = '提供商已禁用';
            result.errorCount++;
        } else if (!adapter) {
            // 服务实例未初始化，尝试自动初始化
            try {
                console.log(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
                // 构建配置对象
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                console.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                instanceResult.error = `服务实例初始化失败: ${initError.message}`;
                result.errorCount++;
            }
        }
        
        // 如果适配器存在（包括刚初始化的），且没有错误，尝试获取用量
        if (adapter && !instanceResult.error) {
            try {
                const usage = await getAdapterUsage(adapter, providerType);
                instanceResult.success = true;

                // 提取用量数据到扁平结构
                if (usage) {
                    // 更新 email 和 userId
                    if (usage.user) {
                        instanceResult.email = usage.user.email || instanceResult.email;
                        instanceResult.userId = usage.user.userId || instanceResult.userId;
                    }
                    // 提取 limits 数据
                    if (usage.limits) {
                        instanceResult.limits = {
                            used: usage.limits.used,
                            remaining: usage.limits.remaining,
                            total: usage.limits.total,
                            percentUsed: usage.limits.percentUsed,
                            unit: usage.limits.unit || 'tokens'
                        };
                    }
                    // 提取订阅信息
                    if (usage.subscription) {
                        instanceResult.subscription = {
                            title: usage.subscription.title,
                            type: usage.subscription.type
                        };
                    }
                    // 提取用量明细（Credit, Free Trial 等）
                    if (usage.usageBreakdown && Array.isArray(usage.usageBreakdown)) {
                        instanceResult.usageBreakdown = usage.usageBreakdown.map(item => ({
                            displayName: item.displayName,
                            currentUsage: item.currentUsage,
                            usageLimit: item.usageLimit,
                            unit: item.unit,
                            freeTrial: item.freeTrial ? {
                                currentUsage: item.freeTrial.currentUsage,
                                usageLimit: item.freeTrial.usageLimit,
                                expiresAt: item.freeTrial.expiresAt
                            } : null
                        }));
                    }
                    // 下次重置时间
                    if (usage.nextDateReset) {
                        instanceResult.nextDateReset = usage.nextDateReset;
                    }
                    if (usage.daysUntilReset !== undefined) {
                        instanceResult.daysUntilReset = usage.daysUntilReset;
                    }
                }
                // 添加凭据文件路径
                if (provider.KIRO_OAUTH_CREDS_FILE_PATH) {
                    instanceResult.credentialsPath = provider.KIRO_OAUTH_CREDS_FILE_PATH;
                }
                result.successCount++;

                // 缓存 userId 和 email 到 provider pool，用于去重检测
                if (usage && usage.user) {
                    const needsUpdate = provider.cachedUserId !== usage.user.userId ||
                                       provider.cachedEmail !== usage.user.email;
                    if (needsUpdate) {
                        provider.cachedUserId = usage.user.userId;
                        provider.cachedEmail = usage.user.email;
                        provider.cachedAt = new Date().toISOString();

                        // 检查是否有重复的 userId
                        const duplicate = findDuplicateUserId(providers, usage.user.userId, provider.uuid);
                        if (duplicate) {
                            console.warn(`[Usage API] 检测到重复账号: ${usage.user.email} (userId: ${usage.user.userId})`);
                            console.warn(`[Usage API] 重复的 token: ${provider.KIRO_OAUTH_CREDS_FILE_PATH} 与 ${duplicate.path}`);
                            instanceResult.isDuplicate = true;
                            instanceResult.duplicateOf = duplicate.path;
                        }
                    }
                }
            } catch (error) {
                instanceResult.error = error.message;
                result.errorCount++;
            }
        }

        result.instances.push(instanceResult);
    }

    // 如果有 userId 缓存更新，保存到 provider_pools.json
    const hasUpdates = result.instances.some(inst => inst.usage?.user?.userId);
    if (hasUpdates && providerPoolManager) {
        try {
            const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'provider_pools.json';
            const currentPools = providerPoolManager.providerPools || {};
            currentPools[providerType] = providers;
            writeFileSync(filePath, JSON.stringify(currentPools, null, 2), 'utf8');
            console.log('[Usage API] Provider pools updated with cached userId/email');
        } catch (saveError) {
            console.error('[Usage API] Failed to save provider pools:', saveError.message);
        }
    }

    return result;
}

/**
 * 从适配器获取用量信息
 * @param {Object} adapter - 服务适配器
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object>} 用量信息
 */
async function getAdapterUsage(adapter, providerType) {
    if (providerType === 'claude-kiro-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatKiroUsage(rawUsage);
        } else if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.kiroApiService.getUsageLimits();
            return formatKiroUsage(rawUsage);
        }
        throw new Error('该适配器不支持用量查询');
    }

    throw new Error(`不支持的提供商类型: ${providerType}`);
}

/**
 * 获取提供商显示名称
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(provider, providerType) {
    // 尝试从凭据文件路径提取名称
    const credPathKey = {
        'claude-kiro-oauth': 'KIRO_OAUTH_CREDS_FILE_PATH'
    }[providerType];

    if (credPathKey && provider[credPathKey]) {
        const filePath = provider[credPathKey];
        const fileName = path.basename(filePath);
        const dirName = path.basename(path.dirname(filePath));
        return `${dirName}/${fileName}`;
    }

    return provider.uuid || '未命名';
}

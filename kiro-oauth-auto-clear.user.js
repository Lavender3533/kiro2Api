// ==UserScript==
// @name         Kiro OAuth 终极清除 Session (v2.1)
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  终极方案：清除 Kiro、GitHub、Google 的所有缓存，确保每次都能使用不同账号登录
// @author       You
// @match        https://prod.us-east-1.auth.desktop.kiro.dev/*
// @match        https://*.auth.desktop.kiro.dev/*
// @match        https://github.com/login/oauth/authorize*
// @match        https://github.com/login*
// @match        https://github.com/sessions*
// @match        https://github.com/logout*
// @match        https://accounts.google.com/o/oauth2/*
// @match        https://accounts.google.com/ServiceLogin*
// @match        https://accounts.google.com/Logout*
// @grant        GM_cookie
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const currentUrl = window.location.href;
    const currentHost = window.location.hostname;

    console.log('[Kiro UltimateClear v2.1] 脚本已加载，当前页面:', currentUrl);

    // ==================== Kiro OAuth 页面 ====================
    if (currentHost.includes('kiro.dev')) {
        const urlParams = new URLSearchParams(window.location.search);
        const isOAuthLogin = urlParams.has('idp') || window.location.pathname.includes('/login');

        if (isOAuthLogin) {
            console.log('[Kiro UltimateClear] ===== 检测到 Kiro OAuth 登录页面 =====');
            console.log('[Kiro UltimateClear] 开始清除 Kiro session...');

            // 立即阻止页面加载，先清除缓存
            document.addEventListener('DOMContentLoaded', (e) => {
                e.stopPropagation();
            }, true);

            clearAllCookies('Kiro');
            clearStorage();
            clearAllCaches();

            showNotice('Kiro Session 已清除', '准备前往 GitHub/Google 登录');

            console.log('[Kiro UltimateClear] Kiro session 清除完成');
        }
    }

    // ==================== GitHub OAuth 页面 ====================
    else if (currentHost === 'github.com') {
        // 检查是否是 OAuth 相关页面
        const isGitHubOAuth = currentUrl.includes('/login') ||
                             currentUrl.includes('/oauth/authorize') ||
                             currentUrl.includes('/sessions');

        if (isGitHubOAuth) {
            console.log('[Kiro UltimateClear] ===== 检测到 GitHub OAuth 页面 =====');

            // 检查是否来自 Kiro
            const isFromKiro = document.referrer.includes('kiro.dev') ||
                              sessionStorage.getItem('kiro-oauth-flow') === 'true' ||
                              currentUrl.includes('oauth/authorize'); // OAuth authorize 页面一定是来自外部的

            if (isFromKiro) {
                console.log('[Kiro UltimateClear] 确认来自 Kiro OAuth 流程');
                console.log('[Kiro UltimateClear] 开始清除 GitHub session...');

                // 标记 OAuth 流程
                sessionStorage.setItem('kiro-oauth-flow', 'true');

                // 清除 GitHub 的所有 cookies 和缓存
                clearAllCookies('GitHub');

                const kiroFlag = sessionStorage.getItem('kiro-oauth-flow');
                clearStorage();
                sessionStorage.setItem('kiro-oauth-flow', kiroFlag);

                clearAllCaches();

                showNotice('GitHub Session 已清除', '请选择要登录的 GitHub 账号');

                // GitHub 特殊处理：尝试多种方式退出登录
                attemptGitHubLogout();

                console.log('[Kiro UltimateClear] GitHub session 清除完成');
            }
        }
    }

    // ==================== Google OAuth 页面 ====================
    else if (currentHost.includes('google.com') && currentUrl.includes('oauth2')) {
        console.log('[Kiro UltimateClear] ===== 检测到 Google OAuth 页面 =====');

        const isFromKiro = document.referrer.includes('kiro.dev') ||
                          sessionStorage.getItem('kiro-oauth-flow') === 'true';

        if (isFromKiro) {
            console.log('[Kiro UltimateClear] 确认来自 Kiro OAuth 流程');
            console.log('[Kiro UltimateClear] 开始清除 Google session...');

            sessionStorage.setItem('kiro-oauth-flow', 'true');

            clearAllCookies('Google');

            const kiroFlag = sessionStorage.getItem('kiro-oauth-flow');
            clearStorage();
            sessionStorage.setItem('kiro-oauth-flow', kiroFlag);

            clearAllCaches();

            showNotice('Google Session 已清除', '请选择要登录的 Google 账号');

            // Google 特殊处理：添加账号选择参数并强制退出
            attemptGoogleLogout();

            console.log('[Kiro UltimateClear] Google session 清除完成');
        }
    }

    // ==================== 工具函数 ====================

    /**
     * 清除所有 cookies（最激进的方式）
     */
    function clearAllCookies(platform) {
        console.log(`[${platform}] 开始清除 cookies...`);
        let cleared = 0;

        // 方案1: GM_cookie API（最强力）
        if (typeof GM_cookie !== 'undefined') {
            GM_cookie.list({}, function(cookies, error) {
                if (!error && cookies) {
                    cookies.forEach(function(cookie) {
                        console.log(`[${platform}] [GM] 删除 cookie: ${cookie.name} (domain: ${cookie.domain})`);

                        // 尝试多种组合删除
                        [cookie.domain, '.' + cookie.domain, cookie.domain.replace(/^\./, '')].forEach(domain => {
                            ['/', cookie.path || '/'].forEach(path => {
                                GM_cookie.delete({
                                    name: cookie.name,
                                    url: window.location.protocol + '//' + domain.replace(/^\./, ''),
                                    domain: domain,
                                    path: path
                                }, function(error) {
                                    if (!error) cleared++;
                                });
                            });
                        });
                    });
                    console.log(`[${platform}] GM_cookie 已删除 ${cleared} 个 cookies`);
                }
            });
        }

        // 方案2: document.cookie（降级方案，但更激进）
        const cookies = document.cookie.split(";");
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i];
            const eqPos = cookie.indexOf("=");
            const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();

            if (!name) continue;

            // 生成所有可能的域名组合
            const currentDomain = window.location.hostname;
            const domainParts = currentDomain.split('.');
            const domains = ['', currentDomain];

            // 添加所有父域名（如 .github.com, .google.com）
            for (let j = 0; j < domainParts.length - 1; j++) {
                domains.push('.' + domainParts.slice(j).join('.'));
                domains.push(domainParts.slice(j).join('.'));
            }

            // 所有可能的路径
            const paths = ['/', ''];
            if (window.location.pathname) {
                const pathParts = window.location.pathname.split('/');
                for (let j = 0; j < pathParts.length; j++) {
                    paths.push('/' + pathParts.slice(0, j + 1).join('/'));
                }
            }

            // 尝试所有组合
            domains.forEach(domain => {
                paths.forEach(path => {
                    // 使用过去的时间戳删除
                    const expires = 'Thu, 01 Jan 1970 00:00:00 GMT';
                    const cookieString = `${name}=;expires=${expires};path=${path};domain=${domain}`;
                    document.cookie = cookieString;
                    document.cookie = `${name}=;expires=${expires};path=${path}`;

                    // 也尝试 max-age=0
                    document.cookie = `${name}=;max-age=0;path=${path};domain=${domain}`;
                    document.cookie = `${name}=;max-age=0;path=${path}`;
                });
            });

            cleared++;
            console.log(`[${platform}] [document.cookie] 删除: ${name}`);
        }

        console.log(`[${platform}] document.cookie 方案处理了 ${cleared} 个 cookies`);
    }

    /**
     * 清除 localStorage 和 sessionStorage
     */
    function clearStorage() {
        try {
            const kiroFlag = sessionStorage.getItem('kiro-oauth-flow');

            // 清除 localStorage
            const localStorageKeys = Object.keys(localStorage);
            localStorageKeys.forEach(key => {
                console.log('[Storage] 删除 localStorage:', key);
                localStorage.removeItem(key);
            });
            localStorage.clear();

            // 清除 sessionStorage（保留 kiro flag）
            const sessionStorageKeys = Object.keys(sessionStorage);
            sessionStorageKeys.forEach(key => {
                if (key !== 'kiro-oauth-flow') {
                    console.log('[Storage] 删除 sessionStorage:', key);
                    sessionStorage.removeItem(key);
                }
            });
            sessionStorage.clear();

            if (kiroFlag) {
                sessionStorage.setItem('kiro-oauth-flow', kiroFlag);
            }

            console.log('[Storage] localStorage 和 sessionStorage 已清除');
        } catch (e) {
            console.warn('[Storage] 无法清除 Storage:', e);
        }
    }

    /**
     * 清除所有缓存（IndexedDB, Cache API, Service Workers）
     */
    function clearAllCaches() {
        // 清除 IndexedDB
        try {
            if (window.indexedDB) {
                if (window.indexedDB.databases) {
                    window.indexedDB.databases().then(databases => {
                        databases.forEach(db => {
                            console.log('[Cache] 删除 IndexedDB:', db.name);
                            window.indexedDB.deleteDatabase(db.name);
                        });
                    });
                } else {
                    // 降级方案：尝试删除常见的数据库名
                    ['localStorage-polyfill', 'localforage', 'keyval-store', 'firebaseLocalStorageDb'].forEach(dbName => {
                        try {
                            window.indexedDB.deleteDatabase(dbName);
                        } catch (e) {
                            // 忽略错误
                        }
                    });
                }
            }
        } catch (e) {
            console.warn('[Cache] 无法清除 IndexedDB:', e);
        }

        // 清除 Cache API
        try {
            if ('caches' in window) {
                caches.keys().then(cacheNames => {
                    cacheNames.forEach(cacheName => {
                        console.log('[Cache] 删除 Cache API:', cacheName);
                        caches.delete(cacheName);
                    });
                });
            }
        } catch (e) {
            console.warn('[Cache] 无法清除 Cache API:', e);
        }

        // 注销 Service Workers
        try {
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then(registrations => {
                    registrations.forEach(registration => {
                        console.log('[Cache] 注销 Service Worker:', registration.scope);
                        registration.unregister();
                    });
                });
            }
        } catch (e) {
            console.warn('[Cache] 无法注销 Service Worker:', e);
        }

        console.log('[Cache] 所有缓存清除完成');
    }

    /**
     * 尝试 GitHub 退出登录
     */
    function attemptGitHubLogout() {
        // 方法1：发送 POST 请求到 /logout
        fetch('https://github.com/logout', {
            method: 'POST',
            credentials: 'include',
            mode: 'no-cors',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'authenticity_token='
        }).catch(e => console.log('[GitHub] Logout 请求已发送'));

        // 方法2：访问 /logout 页面
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = 'https://github.com/logout';
        document.documentElement.appendChild(iframe);
        setTimeout(() => iframe.remove(), 2000);

        console.log('[GitHub] 退出登录请求已发送');
    }

    /**
     * 尝试 Google 退出登录并强制账号选择
     */
    function attemptGoogleLogout() {
        // 方法1：访问 Google Logout 页面
        const logoutIframe = document.createElement('iframe');
        logoutIframe.style.display = 'none';
        logoutIframe.src = 'https://accounts.google.com/Logout';
        document.documentElement.appendChild(logoutIframe);
        setTimeout(() => logoutIframe.remove(), 2000);

        // 方法2：修改当前 URL 添加 prompt=select_account
        if (!currentUrl.includes('prompt=')) {
            const newUrl = new URL(currentUrl);
            newUrl.searchParams.set('prompt', 'select_account consent');
            newUrl.searchParams.set('authuser', '0'); // 强制账号选择

            if (currentUrl !== newUrl.href) {
                console.log('[Google] 重定向到账号选择页面');
                window.location.href = newUrl.href;
            }
        }

        console.log('[Google] 退出登录请求已发送');
    }

    /**
     * 显示通知
     */
    function showNotice(title, subtitle) {
        // 创建样式
        if (!document.getElementById('kiro-clear-style-v2')) {
            const style = document.createElement('style');
            style.id = 'kiro-clear-style-v2';
            style.textContent = `
                #kiro-clear-notice-v2 {
                    position: fixed;
                    top: 20px;
                    right: 20px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 15px 25px;
                    border-radius: 8px;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
                    z-index: 2147483647;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
                    font-size: 14px;
                    animation: slideIn 0.3s ease-out;
                    max-width: 320px;
                }
                @keyframes slideIn {
                    from { transform: translateX(400px); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(400px); opacity: 0; }
                }
                #kiro-clear-notice-v2.hiding {
                    animation: slideOut 0.3s ease-out forwards;
                }
            `;
            document.documentElement.appendChild(style);
        }

        // 等待 DOM 加载
        const showNoticeElement = () => {
            // 删除旧通知
            const oldNotice = document.getElementById('kiro-clear-notice-v2');
            if (oldNotice) oldNotice.remove();

            const notice = document.createElement('div');
            notice.id = 'kiro-clear-notice-v2';
            notice.innerHTML = `
                <div style="display: flex; align-items: center; gap: 10px;">
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" style="flex-shrink: 0;">
                        <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"/>
                    </svg>
                    <div>
                        <div style="font-weight: bold; margin-bottom: 2px;">${title}</div>
                        <div style="font-size: 12px; opacity: 0.9;">${subtitle}</div>
                    </div>
                </div>
            `;
            document.documentElement.appendChild(notice);

            // 3秒后自动消失
            setTimeout(() => {
                notice.classList.add('hiding');
                setTimeout(() => notice.remove(), 300);
            }, 3000);
        };

        if (document.documentElement) {
            showNoticeElement();
        } else {
            setTimeout(showNoticeElement, 100);
        }
    }

    console.log('[Kiro UltimateClear v2.1] 初始化完成');
})();

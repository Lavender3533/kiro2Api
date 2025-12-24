// ==UserScript==
// @name         Kiro OAuth Helper
// @namespace    https://kiro2api.local/
// @version      1.0.0
// @description  自动处理 Kiro OAuth 回调，替代 AntiHook
// @author       Kiro2API
// @match        https://kiro.dev/*
// @match        https://*.amazon.com/*
// @match        https://*.amazoncognito.com/*
// @match        https://github.com/login/oauth/*
// @match        https://accounts.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ========== 配置 ==========
    const CONFIG = {
        // 后端 API 地址（修改为你的实际地址）
        apiBase: GM_getValue('apiBase', 'http://localhost:23456'),
        // 管理员 Token（首次使用需要设置）
        authToken: GM_getValue('authToken', ''),
        // 是否启用自动处理
        autoProcess: GM_getValue('autoProcess', true),
        // 是否显示通知
        showNotifications: GM_getValue('showNotifications', true)
    };

    // ========== 工具函数 ==========
    function log(msg, type = 'info') {
        const prefix = '[Kiro OAuth Helper]';
        const styles = {
            info: 'color: #3b82f6',
            success: 'color: #22c55e',
            error: 'color: #ef4444',
            warn: 'color: #f59e0b'
        };
        console.log(`%c${prefix} ${msg}`, styles[type] || styles.info);
    }

    function notify(title, text, type = 'info') {
        if (!CONFIG.showNotifications) return;

        // 尝试使用 GM 通知
        if (typeof GM_notification !== 'undefined') {
            GM_notification({
                title: title,
                text: text,
                timeout: 5000
            });
        }

        // 页面内通知
        showPageNotification(title, text, type);
    }

    function showPageNotification(title, text, type = 'info') {
        const colors = {
            info: '#3b82f6',
            success: '#22c55e',
            error: '#ef4444',
            warn: '#f59e0b'
        };

        const container = document.createElement('div');
        container.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 999999;
            background: linear-gradient(135deg, #1f2937 0%, #111827 100%);
            border: 1px solid ${colors[type]}40;
            border-left: 4px solid ${colors[type]};
            border-radius: 12px;
            padding: 16px 20px;
            min-width: 300px;
            max-width: 450px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            animation: slideIn 0.3s ease-out;
        `;

        container.innerHTML = `
            <style>
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            </style>
            <div style="display: flex; align-items: start; gap: 12px;">
                <div style="width: 24px; height: 24px; border-radius: 50%; background: ${colors[type]}20; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                    <span style="color: ${colors[type]}; font-size: 14px;">${type === 'success' ? '✓' : type === 'error' ? '✗' : 'ℹ'}</span>
                </div>
                <div style="flex: 1;">
                    <div style="color: #fff; font-weight: 600; font-size: 14px; margin-bottom: 4px;">${title}</div>
                    <div style="color: #9ca3af; font-size: 13px; line-height: 1.5;">${text}</div>
                </div>
                <button onclick="this.parentElement.parentElement.style.animation='slideOut 0.3s ease-out forwards'; setTimeout(() => this.parentElement.parentElement.remove(), 300)"
                        style="background: none; border: none; color: #6b7280; cursor: pointer; font-size: 18px; padding: 0; line-height: 1;">&times;</button>
            </div>
        `;

        document.body.appendChild(container);

        // 5秒后自动消失
        setTimeout(() => {
            if (container.parentElement) {
                container.style.animation = 'slideOut 0.3s ease-out forwards';
                setTimeout(() => container.remove(), 300);
            }
        }, 5000);
    }

    // ========== API 请求 ==========
    function apiRequest(endpoint, method, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: method,
                url: `${CONFIG.apiBase}${endpoint}`,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${CONFIG.authToken}`
                },
                data: data ? JSON.stringify(data) : undefined,
                onload: (response) => {
                    try {
                        const result = JSON.parse(response.responseText);
                        if (response.status >= 200 && response.status < 300) {
                            resolve(result);
                        } else {
                            reject(result);
                        }
                    } catch (e) {
                        reject({ error: 'Parse error', raw: response.responseText });
                    }
                },
                onerror: (error) => {
                    reject({ error: 'Network error', details: error });
                }
            });
        });
    }

    // ========== OAuth 回调检测 ==========
    function checkForOAuthCallback() {
        const url = window.location.href;

        // 检测 kiro:// 协议重定向（某些情况下会显示在页面上）
        if (url.includes('kiro://') || document.body?.innerText?.includes('kiro://')) {
            log('检测到 kiro:// 协议回调', 'success');
            handleKiroCallback();
            return;
        }

        // 检测 URL 中的 authorization code
        const urlParams = new URLSearchParams(window.location.search);
        const code = urlParams.get('code');
        const state = urlParams.get('state');

        if (code && state) {
            log(`检测到 OAuth 回调: code=${code.substring(0, 10)}..., state=${state.substring(0, 10)}...`, 'success');
            handleOAuthCallback(code, state);
        }
    }

    // 处理 kiro:// 协议回调
    function handleKiroCallback() {
        // 尝试从页面内容提取 kiro:// URL
        const pageContent = document.body?.innerText || '';
        const kiroMatch = pageContent.match(/kiro:\/\/[^\s<>"']+/);

        if (kiroMatch) {
            const kiroUrl = kiroMatch[0];
            log(`提取到 kiro URL: ${kiroUrl}`, 'info');

            // 解析 URL 参数
            try {
                const url = new URL(kiroUrl);
                const code = url.searchParams.get('code');
                const state = url.searchParams.get('state');

                if (code && state) {
                    handleOAuthCallback(code, state);
                }
            } catch (e) {
                log(`解析 kiro URL 失败: ${e.message}`, 'error');
            }
        }
    }

    // 处理 OAuth 回调
    async function handleOAuthCallback(code, state) {
        if (!CONFIG.autoProcess) {
            log('自动处理已禁用，跳过', 'warn');
            showManualProcessUI(code, state);
            return;
        }

        if (!CONFIG.authToken) {
            notify('配置错误', '请先设置 API Token（点击油猴图标 -> Kiro OAuth Helper -> 设置 Token）', 'error');
            showManualProcessUI(code, state);
            return;
        }

        notify('处理中...', '正在发送 OAuth 回调到后端', 'info');

        try {
            const result = await apiRequest('/api/kiro/oauth/callback', 'POST', {
                code: code,
                state: state
            });

            if (result.success) {
                log('OAuth 回调处理成功!', 'success');
                notify('授权成功!', `账号 #${result.accountNumber || '?'} 已添加`, 'success');

                // 显示成功页面
                showSuccessPage(result);
            } else {
                throw new Error(result.error || '未知错误');
            }
        } catch (error) {
            log(`OAuth 回调处理失败: ${error.message || error.error}`, 'error');
            notify('授权失败', error.message || error.error || '请检查后端服务', 'error');
            showManualProcessUI(code, state);
        }
    }

    // 显示手动处理 UI
    function showManualProcessUI(code, state) {
        const container = document.createElement('div');
        container.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 999998;
            background: rgba(0, 0, 0, 0.9);
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        `;

        container.innerHTML = `
            <div style="background: linear-gradient(135deg, #1f2937 0%, #111827 100%); border-radius: 16px; padding: 32px; max-width: 500px; width: 90%; border: 1px solid rgba(255,255,255,0.1);">
                <h2 style="color: #fff; margin: 0 0 8px 0; font-size: 24px;">OAuth 回调已捕获</h2>
                <p style="color: #9ca3af; margin: 0 0 24px 0;">请复制以下信息手动处理，或配置 Token 后自动处理</p>

                <div style="margin-bottom: 16px;">
                    <label style="color: #9ca3af; font-size: 12px; display: block; margin-bottom: 4px;">Authorization Code:</label>
                    <div style="display: flex; gap: 8px;">
                        <input type="text" value="${code}" readonly style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; color: #10b981; font-family: monospace; font-size: 12px;">
                        <button onclick="navigator.clipboard.writeText('${code}'); this.innerText='已复制!'; setTimeout(() => this.innerText='复制', 2000)"
                                style="background: #3b82f6; color: #fff; border: none; border-radius: 8px; padding: 12px 16px; cursor: pointer; font-weight: 500;">复制</button>
                    </div>
                </div>

                <div style="margin-bottom: 24px;">
                    <label style="color: #9ca3af; font-size: 12px; display: block; margin-bottom: 4px;">State:</label>
                    <div style="display: flex; gap: 8px;">
                        <input type="text" value="${state}" readonly style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; color: #f59e0b; font-family: monospace; font-size: 12px;">
                        <button onclick="navigator.clipboard.writeText('${state}'); this.innerText='已复制!'; setTimeout(() => this.innerText='复制', 2000)"
                                style="background: #3b82f6; color: #fff; border: none; border-radius: 8px; padding: 12px 16px; cursor: pointer; font-weight: 500;">复制</button>
                    </div>
                </div>

                <div style="display: flex; gap: 12px;">
                    <button onclick="this.closest('div[style*=position]').remove()"
                            style="flex: 1; background: rgba(255,255,255,0.1); color: #fff; border: none; border-radius: 8px; padding: 12px; cursor: pointer; font-weight: 500;">关闭</button>
                    <button id="kiro-retry-btn"
                            style="flex: 1; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; border-radius: 8px; padding: 12px; cursor: pointer; font-weight: 500;">重新发送到后端</button>
                </div>
            </div>
        `;

        document.body.appendChild(container);

        // 重试按钮
        container.querySelector('#kiro-retry-btn').onclick = async () => {
            CONFIG.authToken = GM_getValue('authToken', '');
            if (CONFIG.authToken) {
                container.remove();
                await handleOAuthCallback(code, state);
            } else {
                notify('请先设置 Token', '点击油猴图标 -> Kiro OAuth Helper -> 设置 Token', 'warn');
            }
        };
    }

    // 显示成功页面
    function showSuccessPage(result) {
        document.body.innerHTML = `
            <div style="min-height: 100vh; background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); display: flex; align-items: center; justify-content: center; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                <div style="text-align: center; padding: 40px;">
                    <div style="width: 80px; height: 80px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 24px; box-shadow: 0 0 40px rgba(16, 185, 129, 0.4);">
                        <span style="font-size: 40px; color: #fff;">✓</span>
                    </div>
                    <h1 style="color: #fff; font-size: 32px; margin: 0 0 12px 0;">授权成功!</h1>
                    <p style="color: #9ca3af; font-size: 18px; margin: 0 0 32px 0;">Kiro OAuth 账号已成功添加</p>

                    <div style="background: rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; text-align: left; max-width: 400px; margin: 0 auto 32px;">
                        ${result.accountNumber ? `<div style="color: #9ca3af; margin-bottom: 8px;">账号编号: <span style="color: #10b981; font-weight: 600;">#${result.accountNumber}</span></div>` : ''}
                        ${result.tokenFile ? `<div style="color: #9ca3af; margin-bottom: 8px;">Token 文件: <code style="color: #f59e0b; background: rgba(245,158,11,0.1); padding: 2px 6px; border-radius: 4px;">${result.tokenFile}</code></div>` : ''}
                        <div style="color: #9ca3af;">状态: <span style="color: #10b981;">已保存</span></div>
                    </div>

                    <button onclick="window.close()" style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #fff; border: none; border-radius: 8px; padding: 14px 32px; font-size: 16px; cursor: pointer; font-weight: 500;">
                        关闭此页面
                    </button>
                    <p style="color: #6b7280; font-size: 14px; margin-top: 16px;">此页面可以安全关闭</p>
                </div>
            </div>
        `;
    }

    // ========== 菜单命令 ==========
    GM_registerMenuCommand('⚙️ 设置 API 地址', () => {
        const newBase = prompt('请输入后端 API 地址:', CONFIG.apiBase);
        if (newBase) {
            GM_setValue('apiBase', newBase);
            CONFIG.apiBase = newBase;
            notify('设置已保存', `API 地址: ${newBase}`, 'success');
        }
    });

    GM_registerMenuCommand('🔑 设置 Token', () => {
        const newToken = prompt('请输入管理员 Token:', CONFIG.authToken);
        if (newToken !== null) {
            GM_setValue('authToken', newToken);
            CONFIG.authToken = newToken;
            notify('设置已保存', 'Token 已更新', 'success');
        }
    });

    GM_registerMenuCommand(CONFIG.autoProcess ? '🔄 禁用自动处理' : '🔄 启用自动处理', () => {
        const newValue = !CONFIG.autoProcess;
        GM_setValue('autoProcess', newValue);
        CONFIG.autoProcess = newValue;
        notify('设置已保存', `自动处理: ${newValue ? '已启用' : '已禁用'}`, 'success');
    });

    GM_registerMenuCommand('📋 查看当前配置', () => {
        alert(`Kiro OAuth Helper 配置:\n\nAPI 地址: ${CONFIG.apiBase}\nToken: ${CONFIG.authToken ? '已设置' : '未设置'}\n自动处理: ${CONFIG.autoProcess ? '启用' : '禁用'}\n通知: ${CONFIG.showNotifications ? '启用' : '禁用'}`);
    });

    // ========== 初始化 ==========
    function init() {
        log('脚本已加载', 'info');

        // 页面加载完成后检测回调
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', checkForOAuthCallback);
        } else {
            checkForOAuthCallback();
        }

        // 监听 URL 变化（SPA 支持）
        let lastUrl = location.href;
        new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                checkForOAuthCallback();
            }
        }).observe(document.body || document.documentElement, { subtree: true, childList: true });
    }

    init();
})();

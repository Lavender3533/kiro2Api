/**
 * Kiro 批量注册工具 - AWS Builder ID 注册 + 设备授权自动化
 *
 * 流程：
 * 1. 从 Kiro2API 服务器启动 AWS SSO 设备授权，获取 userCode 和 verificationUri
 * 2. 用 Roxy Browser 自动化完成 AWS Builder ID 注册（使用邮箱池中的邮箱）
 * 3. 自动完成设备授权流程（输入 userCode，点击授权）
 * 4. 服务器后台轮询获取 token 并保存
 */

import { chromium } from 'playwright-core';
import config from './config.js';

export class KiroRegister {
    constructor(roxyBrowser, emailApi, kiro2api) {
        this.roxyBrowser = roxyBrowser;
        this.emailApi = emailApi;
        this.kiro2api = kiro2api;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.dirId = null;
    }

    /**
     * 初始化浏览器（使用无痕模式）
     */
    async initBrowser(windowName) {
        console.log('[KiroRegister] 初始化无痕浏览器...');

        // 启动 Edge 无痕浏览器（使用系统已安装的 Edge）
        this.browser = await chromium.launch({
            headless: false,  // 显示浏览器窗口
            channel: 'msedge',  // 使用系统安装的 Edge
            args: [
                '--disable-blink-features=AutomationControlled',  // 隐藏自动化特征
                '--disable-dev-shm-usage',
                '--no-sandbox',
                '--disable-setuid-sandbox',
            ],
        });

        // 创建无痕上下文
        this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 720 },
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        this.page = await this.context.newPage();

        // 设置超时
        this.page.setDefaultTimeout(config.register.pageTimeout);

        console.log('[KiroRegister] 无痕浏览器初始化完成');
        return this;
    }

    /**
     * 关闭浏览器
     */
    async closeBrowser() {
        console.log('[KiroRegister] 清理浏览器资源...');
        try {
            if (this.page) {
                await this.page.close();
                this.page = null;
            }
            if (this.context) {
                await this.context.close();
                this.context = null;
            }
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
            }
            console.log('[KiroRegister] 浏览器资源清理完成');
        } catch (error) {
            console.warn(`[KiroRegister] 清理浏览器时出错: ${error.message}`);
        }
    }

    /**
     * 完整注册流程
     * @param {object} emailAccount - 邮箱账号 {email, password, clientId, refreshToken}
     * @param {number} accountNumber - Kiro 账号编号
     */
    async register(emailAccount, accountNumber) {
        const { email, password: emailPassword, clientId, refreshToken } = emailAccount;
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[KiroRegister] 开始注册流程`);
        console.log(`  邮箱: ${email}`);
        console.log(`  账号编号: ${accountNumber}`);
        console.log(`${'='.repeat(60)}\n`);

        try {
            // Step 1: 从服务器启动设备授权
            console.log('[Step 1] 从服务器启动 AWS SSO 设备授权...');
            const deviceAuth = await this.startDeviceAuth(accountNumber);
            if (!deviceAuth.success) {
                throw new Error(`启动设备授权失败: ${deviceAuth.error}`);
            }
            console.log(`[Step 1] 设备授权已启动`);
            console.log(`  用户码: ${deviceAuth.userCode}`);
            console.log(`  验证链接: ${deviceAuth.verificationUri}`);

            // 随机延迟 10-30 秒（模拟人类思考时间）
            await this.randomSleep(10000, 30000);

            // Step 2: 注册 AWS Builder ID
            console.log('\n[Step 2] 注册 AWS Builder ID...');
            const awsPassword = this.generatePassword(accountNumber);
            const registerResult = await this.registerAWSBuilderID(email, emailAccount, awsPassword);
            if (!registerResult.success) {
                throw new Error(`AWS Builder ID 注册失败: ${registerResult.error}`);
            }
            console.log('[Step 2] AWS Builder ID 注册成功');

            // 随机延迟 10-30 秒（模拟人类从注册页面切换到授权页面）
            await this.randomSleep(10000, 30000);

            // Step 3: 完成设备授权
            console.log('\n[Step 3] 完成设备授权流程...');
            const authResult = await this.completeDeviceAuth(
                deviceAuth.verificationUriComplete || deviceAuth.verificationUri,
                deviceAuth.userCode
            );
            if (!authResult.success) {
                throw new Error(`设备授权失败: ${authResult.error}`);
            }
            console.log('[Step 3] 设备授权完成');

            // Step 4: 等待服务器获取 token
            console.log('\n[Step 4] 等待服务器获取 token...');

            let tokenReceived = false;
            const maxWaitTime = 60000; // 最多等待 60 秒
            const checkInterval = 3000; // 每 3 秒检查一次
            const startTime = Date.now();

            while (Date.now() - startTime < maxWaitTime) {
                await this.sleep(checkInterval);

                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                console.log(`[Step 4] 检查服务器是否已获取 token... (${elapsed}s / ${maxWaitTime / 1000}s)`);

                try {
                    const result = await this.kiro2api.checkTokenExists(accountNumber);
                    if (result.exists) {
                        console.log(`[Step 4] ✓ 服务器已成功获取 token！`);
                        tokenReceived = true;
                        break;
                    }
                } catch (error) {
                    console.warn(`[Step 4] 检查失败: ${error.message}`);
                }
            }

            if (!tokenReceived) {
                console.error(`[Step 4] ✗ 服务器未能获取 token（超时）`);
                throw new Error(`服务器未能在 ${maxWaitTime / 1000} 秒内获取 token，可能授权流程有问题`);
            }

            console.log(`\n${'='.repeat(60)}`);
            console.log(`[KiroRegister] 注册成功！`);
            console.log(`  邮箱: ${email}`);
            console.log(`  AWS 密码: ${awsPassword}`);
            console.log(`  账号编号: ${accountNumber}`);
            console.log(`  Token 文件: kiro-auth-token-${accountNumber}.json`);
            console.log(`${'='.repeat(60)}\n`);

            return {
                success: true,
                email,
                awsPassword,
                accountNumber,
            };

        } catch (error) {
            console.error(`[KiroRegister] 注册失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 从服务器启动设备授权
     */
    async startDeviceAuth(accountNumber) {
        try {
            const response = await this.kiro2api.request('/api/kiro/oauth/aws-sso/start', 'POST', {
                accountNumber,
                startUrl: config.awsBuilderID.ssoStartUrl,
            });

            if (response.success) {
                return {
                    success: true,
                    userCode: response.userCode,
                    verificationUri: response.verificationUri,
                    verificationUriComplete: response.verificationUriComplete,
                    expiresIn: response.expiresIn,
                };
            }

            return { success: false, error: response.error || '未知错误' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * 注册 AWS Builder ID
     */
    async registerAWSBuilderID(email, emailAccount, awsPassword) {
        const emailPassword = emailAccount.password; // 兼容性
        try {
            // 访问 AWS Builder ID 注册页面 - 使用更宽松的加载策略
            console.log('[AWS] 访问注册页面...');
            try {
                await this.page.goto('https://profile.aws.amazon.com/', {
                    waitUntil: 'domcontentloaded',  // 改为 domcontentloaded，不等待所有资源
                    timeout: 60000  // 增加到 60 秒
                });
            } catch (gotoError) {
                console.warn(`[AWS] 页面加载超时，尝试继续: ${gotoError.message}`);
                // 即使超时也继续，因为页面可能已经部分加载
            }

            // 等待页面完全加载 + 随机延迟 3-10 秒（模拟人类阅读页面）
            console.log('[AWS] 等待页面完全加载...');
            await this.randomSleep(3000, 10000);

            // 等待页面中的关键元素出现
            console.log('[AWS] 等待页面元素加载...');
            try {
                await this.page.waitForSelector('body', { timeout: 10000 });
                await this.sleep(2000);
            } catch (e) {
                console.warn('[AWS] 等待 body 元素超时');
            }

            // 处理 Cookie 弹窗
            console.log('[AWS] 检查 Cookie 弹窗...');
            const cookieAcceptBtn = await this.page.$('button:has-text("Accept"), button:has-text("Decline")');
            if (cookieAcceptBtn) {
                console.log('[AWS] 关闭 Cookie 弹窗...');
                await cookieAcceptBtn.click();
                await this.sleep(2000);
            }

            // 点击 "Create your AWS Builder ID"
            console.log('[AWS] 查找注册按钮...');
            await this.sleep(2000); // 额外等待

            const createBtn = await this.page.$('a:has-text("Create"), button:has-text("Create")');
            if (createBtn) {
                console.log('[AWS] 点击注册按钮...');
                await createBtn.click();
                await this.sleep(3000);
            } else {
                console.log('[AWS] 未找到注册按钮，可能已经在注册页面');
            }

            // 输入邮箱 - 使用更灵活的选择器，并增加重试机制
            console.log('[AWS] 输入邮箱...');
            await this.sleep(3000); // 等待表单加载

            let emailInput = null;
            const emailSelectors = [
                'input[placeholder*="example.com"]',
                'input[type="email"]',
                'input[name="email"]',
                '#email',
                'input[autocomplete="email"]'
            ];

            // 重试 3 次查找邮箱输入框
            for (let retry = 0; retry < 3; retry++) {
                console.log(`[AWS] 尝试查找邮箱输入框 (${retry + 1}/3)...`);

                for (const selector of emailSelectors) {
                    emailInput = await this.page.$(selector);
                    if (emailInput) {
                        console.log(`[AWS] 找到邮箱输入框: ${selector}`);
                        break;
                    }
                }

                if (emailInput) break;

                // 如果没找到，等待后重试
                console.log('[AWS] 未找到邮箱输入框，等待 3 秒后重试...');
                await this.sleep(3000);
            }

            if (!emailInput) {
                // 截图并输出页面内容用于调试
                await this.screenshot('no-email-input');
                const pageContent = await this.page.content();
                console.log('[AWS] 页面 HTML 片段:', pageContent.substring(0, 500));
                throw new Error('找不到邮箱输入框');
            }

            await emailInput.fill(email);
            await this.randomSleep(1000, 3000); // 随机延迟 1-3 秒（模拟人类检查输入）

            // 点击 Continue 按钮 - 直接按 Enter 更可靠
            console.log('[AWS] 提交邮箱（按 Enter）...');
            await emailInput.press('Enter');

            // 等待页面跳转完成
            console.log('[AWS] 等待页面跳转...');
            await this.sleep(5000);

            // 检查是否跳转到登录页面（说明邮箱已注册）
            const checkUrl = this.page.url();
            const pageContent = await this.page.content();

            if (checkUrl.includes('/login') || pageContent.includes('Sign in with your AWS Builder ID')) {
                console.log('[AWS] ⚠ 检测到登录页面，该邮箱已经注册过！');
                return {
                    success: false,
                    error: 'EMAIL_ALREADY_REGISTERED',
                    alreadyRegistered: true,
                };
            }

            // 等待页面稳定后再继续
            try {
                await this.page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {
                console.log('[AWS] 页面加载超时，继续...');
            }

            // 输入用户名（邮箱前缀）- 可能需要
            console.log('[AWS] 检查是否需要输入用户名...');
            await this.sleep(3000); // 额外等待

            try {
                // 更多的用户名输入框选择器
                const nameSelectors = [
                    'input[name="name"]',
                    'input[name="username"]',
                    'input[name="displayName"]',
                    'input[placeholder*="name"]',
                    'input[placeholder*="Name"]',
                    'input[type="text"]',  // 通用文本输入框
                    '#name',
                    '#username'
                ];

                let nameInput = null;

                // 重试 3 次查找用户名输入框
                for (let retry = 0; retry < 3; retry++) {
                    console.log(`[AWS] 尝试查找用户名输入框 (${retry + 1}/3)...`);

                    for (const selector of nameSelectors) {
                        try {
                            nameInput = await this.page.$(selector);
                            if (nameInput) {
                                // 检查是否可见
                                const isVisible = await nameInput.isVisible();
                                if (isVisible) {
                                    console.log(`[AWS] 找到用户名输入框: ${selector}`);
                                    break;
                                }
                            }
                        } catch (e) {
                            // 继续尝试下一个选择器
                        }
                    }

                    if (nameInput) break;

                    console.log('[AWS] 未找到用户名输入框，等待 3 秒后重试...');
                    await this.sleep(3000);
                }

                if (nameInput) {
                    console.log('[AWS] 输入用户名...');
                    const username = email.split('@')[0];
                    await nameInput.fill(username);
                    await this.randomSleep(1000, 3000); // 随机延迟 1-3 秒（模拟人类检查输入）

                    // 再次检查并关闭 Cookie 弹窗（可能在页面底部）
                    console.log('[AWS] 再次检查 Cookie 弹窗...');
                    const cookieBtn2 = await this.page.$('button:has-text("Accept"), button:has-text("Decline")');
                    if (cookieBtn2) {
                        console.log('[AWS] 关闭底部 Cookie 弹窗...');
                        try {
                            await cookieBtn2.click();
                            await this.sleep(1000);
                        } catch (e) {
                            console.log('[AWS] Cookie 弹窗点击失败，尝试键盘操作...');
                            await this.page.keyboard.press('Tab');
                            await this.page.keyboard.press('Enter');
                            await this.sleep(1000);
                        }
                    }

                    // 查找并点击 Continue 按钮
                    console.log('[AWS] 查找 Continue 按钮...');
                    await this.sleep(1000);

                    const currentUrl = this.page.url();
                    console.log(`[AWS] 当前 URL: ${currentUrl}`);

                    // 尝试多种方式点击 Continue 按钮
                    let clicked = false;
                    const continueSelectors = [
                        'button:has-text("继续")',
                        'button:has-text("Continue")',
                        'button[type="submit"]',
                        'button.awsui-button-variant-primary',
                    ];

                    for (const selector of continueSelectors) {
                        try {
                            const btn = await this.page.$(selector);
                            if (btn) {
                                const isVisible = await btn.isVisible();
                                const isEnabled = await btn.isEnabled();
                                if (isVisible && isEnabled) {
                                    console.log(`[AWS] 找到 Continue 按钮: ${selector}`);

                                    // 随机延迟 2-5 秒（模拟人类思考）
                                    await this.randomSleep(2000, 5000);

                                    await btn.click();
                                    clicked = true;
                                    console.log('[AWS] ✓ Continue 按钮已点击');
                                    break;
                                }
                            }
                        } catch (e) {
                            // 继续尝试下一个选择器
                        }
                    }

                    if (!clicked) {
                        console.log('[AWS] 未找到可点击的 Continue 按钮，尝试按 Enter...');
                        await this.randomSleep(2000, 4000);
                        await nameInput.press('Enter');
                    }

                    // 等待 URL 变化（确认页面跳转）
                    console.log('[AWS] 等待页面跳转...');
                    let urlChanged = false;
                    for (let i = 0; i < 15; i++) {
                        await this.sleep(1000);
                        const newUrl = this.page.url();

                        // 检查是否出现错误提示
                        const pageText = await this.page.textContent('body').catch(() => '');
                        if (pageText.includes('处理您的请求时出错') || pageText.includes('error processing your request')) {
                            console.log('[AWS] ⚠ 检测到错误提示，等待 5 秒后重试...');
                            await this.sleep(5000);

                            // 重新点击 Continue 按钮
                            for (const selector of continueSelectors) {
                                try {
                                    const btn = await this.page.$(selector);
                                    if (btn) {
                                        const isVisible = await btn.isVisible();
                                        const isEnabled = await btn.isEnabled();
                                        if (isVisible && isEnabled) {
                                            console.log(`[AWS] 重新点击 Continue 按钮...`);
                                            await this.randomSleep(2000, 4000);
                                            await btn.click();
                                            break;
                                        }
                                    }
                                } catch (e) {
                                    // 继续
                                }
                            }
                            continue;
                        }

                        if (newUrl !== currentUrl) {
                            console.log(`[AWS] ✓ 页面已跳转: ${newUrl}`);
                            urlChanged = true;
                            break;
                        }
                    }

                    if (!urlChanged) {
                        console.warn('[AWS] ⚠ 页面未跳转，可能按钮未点击成功');
                        await this.screenshot('continue-not-clicked');
                    }

                    await this.sleep(3000);
                } else {
                    console.log('[AWS] 无需输入用户名，直接进入验证码步骤');
                    // 可能已经在验证码页面，截图看看
                    await this.screenshot('after-email-submit');
                }
            } catch (error) {
                console.log(`[AWS] 检查用户名输入框时出错: ${error.message}，继续...`);
                await this.screenshot('name-input-error');
            }

            // 等待并获取验证码
            console.log('[AWS] 等待验证码邮件（最多2分钟）...');
            const verificationCode = await this.emailApi.waitForAWSVerificationCode(
                email,
                { email, password: emailPassword, clientId: emailAccount.clientId, refreshToken: emailAccount.refreshToken },
                config.register.verificationCodeTimeout,
                config.register.verificationCodePollInterval
            );

            if (!verificationCode) {
                throw new Error('未收到验证码邮件');
            }

            // 输入验证码 - 尝试多种选择器
            console.log(`[AWS] 输入验证码: ${verificationCode}`);
            await this.sleep(3000); // 等待页面加载

            // 等待页面稳定
            try {
                await this.page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {
                console.log('[AWS] 页面加载超时，继续...');
            }

            let codeInput = null;
            const codeSelectors = [
                'input[name="code"]',
                'input[name="verificationCode"]',
                'input[placeholder*="code"]',
                'input[placeholder*="Code"]',
                '#code',
                'input[type="text"]'
            ];

            for (const selector of codeSelectors) {
                try {
                    codeInput = await this.page.$(selector);
                    if (codeInput) {
                        console.log(`[AWS] 找到验证码输入框: ${selector}`);
                        break;
                    }
                } catch (e) {
                    console.log(`[AWS] 选择器 ${selector} 失败: ${e.message}`);
                }
            }

            if (!codeInput) {
                await this.screenshot('no-code-input');
                throw new Error('找不到验证码输入框');
            }

            await codeInput.fill(verificationCode);
            await this.randomSleep(1000, 3000); // 随机延迟 1-3 秒（模拟人类检查验证码）

            // 提交验证码 - 查找并点击 Continue 按钮
            console.log('[AWS] 查找提交按钮...');
            const continueSelectors = [
                'button:has-text("Continue")',
                'button:has-text("Verify")',
                'button:has-text("Submit")',
                'button[type="submit"]',
                'button:has-text("确认")',
                'button:has-text("继续")'
            ];

            let continueBtn = null;
            for (const selector of continueSelectors) {
                try {
                    continueBtn = await this.page.$(selector);
                    if (continueBtn) {
                        const isVisible = await continueBtn.isVisible();
                        if (isVisible) {
                            console.log(`[AWS] 找到提交按钮: ${selector}`);
                            break;
                        }
                    }
                } catch (e) {
                    // 继续尝试下一个
                }
            }

            const currentUrl = this.page.url();
            console.log(`[AWS] 提交前 URL: ${currentUrl}`);

            if (continueBtn) {
                console.log('[AWS] 点击提交按钮...');
                try {
                    await continueBtn.click();
                    await this.sleep(3000);
                } catch (clickError) {
                    console.log(`[AWS] 点击失败，尝试按 Enter: ${clickError.message}`);
                    await codeInput.press('Enter');
                    await this.sleep(3000);
                }
            } else {
                console.log('[AWS] 未找到提交按钮，尝试按 Enter...');
                await codeInput.press('Enter');
                await this.sleep(3000);
            }

            // 等待页面跳转（URL 应该变化）
            console.log('[AWS] 等待页面跳转...');
            let urlChanged = false;
            for (let i = 0; i < 10; i++) {
                await this.sleep(1000);
                const newUrl = this.page.url();
                if (newUrl !== currentUrl && !newUrl.includes('verify-otp')) {
                    console.log(`[AWS] ✓ 页面已跳转: ${newUrl}`);
                    urlChanged = true;
                    break;
                }
                console.log(`[AWS] 等待跳转中... (${i + 1}/10)`);
            }

            if (!urlChanged) {
                const finalUrl = this.page.url();
                console.log(`[AWS] ⚠ URL 未变化: ${finalUrl}`);
                await this.screenshot('code-submit-failed');

                // 如果还在验证码页面，可能验证码错误或提交失败
                if (finalUrl.includes('verify-otp')) {
                    throw new Error('验证码提交失败，页面未跳转');
                }
            }

            // 等待页面稳定
            try {
                await this.page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {
                console.log('[AWS] 页面加载超时，继续...');
            }

            // 设置密码
            console.log('[AWS] 设置密码...');
            await this.sleep(3000); // 等待密码页面加载

            // 等待页面稳定
            try {
                await this.page.waitForLoadState('networkidle', { timeout: 10000 });
            } catch (e) {
                console.log('[AWS] 页面加载超时，继续...');
            }

            // 查找所有密码输入框（通常有两个：密码 + 确认密码）
            const passwordInputs = await this.page.$$('input[type="password"]');
            console.log(`[AWS] 找到 ${passwordInputs.length} 个密码输入框`);

            if (passwordInputs.length >= 2) {
                // 有两个密码框：密码 + 确认密码
                console.log(`[AWS] 输入密码: ${awsPassword}`);
                await passwordInputs[0].fill(awsPassword);
                await this.randomSleep(800, 2000); // 随机延迟 0.8-2 秒

                console.log(`[AWS] 输入确认密码: ${awsPassword}`);
                await passwordInputs[1].fill(awsPassword);
                await this.randomSleep(1000, 3000); // 随机延迟 1-3 秒（模拟人类检查密码）

                // 查找并点击 Continue 按钮
                console.log('[AWS] 查找 Continue 按钮...');
                const continueBtn = await this.page.$('button:has-text("Continue")');
                if (continueBtn) {
                    console.log('[AWS] 点击 Continue 按钮...');
                    try {
                        await continueBtn.click();
                        await this.sleep(5000);
                    } catch (clickError) {
                        console.log(`[AWS] 点击失败，尝试按 Enter: ${clickError.message}`);
                        await passwordInputs[1].press('Enter');
                        await this.sleep(5000);
                    }
                } else {
                    console.log('[AWS] 未找到 Continue 按钮，按 Enter 提交...');
                    await passwordInputs[1].press('Enter');
                    await this.sleep(5000);
                }

                // 等待页面跳转
                try {
                    await this.page.waitForLoadState('networkidle', { timeout: 10000 });
                } catch (e) {
                    console.log('[AWS] 页面加载超时，继续...');
                }

            } else if (passwordInputs.length === 1) {
                // 只有一个密码框
                console.log(`[AWS] 输入密码: ${awsPassword}`);
                await passwordInputs[0].fill(awsPassword);
                await this.sleep(500);

                console.log('[AWS] 提交密码（按 Enter）...');
                await passwordInputs[0].press('Enter');
                await this.sleep(5000);

                try {
                    await this.page.waitForLoadState('networkidle', { timeout: 10000 });
                } catch (e) {
                    console.log('[AWS] 页面加载超时，继续...');
                }
            } else {
                console.log('[AWS] ⚠ 未找到密码输入框');
            }

            // 检查是否注册成功
            const finalUrl = this.page.url();
            console.log(`[AWS] 当前页面: ${finalUrl}`);

            return { success: true };

        } catch (error) {
            console.error(`[AWS] 注册异常: ${error.message}`);
            await this.screenshot('aws-register-error');
            return { success: false, error: error.message };
        }
    }

    /**
     * 完成设备授权流程
     */
    async completeDeviceAuth(verificationUri, userCode) {
        try {
            console.log(`[DeviceAuth] 访问验证页面: ${verificationUri}`);
            try {
                await this.page.goto(verificationUri, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });
            } catch (gotoError) {
                console.warn(`[DeviceAuth] 页面加载超时，尝试继续: ${gotoError.message}`);
            }
            await this.randomSleep(5000, 15000); // 随机延迟 5-15 秒（模拟人类阅读授权页面）

            // 检查当前页面 URL
            const currentUrl = this.page.url();
            console.log(`[DeviceAuth] 当前页面 URL: ${currentUrl}`);

            // 如果页面跳转到了其他地方（不是 view.awsapps.com），说明出问题了
            if (!currentUrl.includes('view.awsapps.com') && !currentUrl.includes('device')) {
                console.warn(`[DeviceAuth] ⚠ 页面跳转异常，不是设备授权页面`);
                console.warn(`[DeviceAuth] 尝试重新访问授权页面...`);

                // 重新访问
                await this.page.goto(verificationUri, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });
                await this.sleep(5000);

                const newUrl = this.page.url();
                console.log(`[DeviceAuth] 重新访问后 URL: ${newUrl}`);

                if (!newUrl.includes('view.awsapps.com') && !newUrl.includes('device')) {
                    await this.screenshot('wrong-page');
                    throw new Error(`页面跳转错误：期望设备授权页面，实际: ${newUrl}`);
                }
            }

            // 处理 Cookie 弹窗（如果有）
            const cookieBtn = await this.page.$('button:has-text("Accept"), button:has-text("Decline")');
            if (cookieBtn) {
                console.log('[DeviceAuth] 关闭 Cookie 弹窗...');
                try {
                    await cookieBtn.click();
                    await this.sleep(1000);
                } catch (e) {
                    console.log('[DeviceAuth] Cookie 弹窗点击失败，继续...');
                }
            }

            // 如果需要输入用户码
            console.log('[DeviceAuth] 检查是否需要输入用户码...');
            const codeSelectors = [
                'input[name="user_code"]',
                'input[name="code"]',
                'input[placeholder*="code"]',
                'input[placeholder*="Code"]',
                '#user_code',
                '#code'
            ];

            let codeInput = null;
            for (const selector of codeSelectors) {
                codeInput = await this.page.$(selector);
                if (codeInput) {
                    console.log(`[DeviceAuth] 找到用户码输入框: ${selector}`);
                    break;
                }
            }

            if (codeInput) {
                console.log(`[DeviceAuth] 输入用户码: ${userCode}`);
                await codeInput.fill(userCode);
                await this.randomSleep(1000, 3000); // 随机延迟 1-3 秒（模拟人类检查用户码）

                // 直接按 Enter 提交
                console.log('[DeviceAuth] 提交用户码（按 Enter）...');
                await codeInput.press('Enter');
                await this.sleep(4000);
            }

            // 点击允许/授权按钮
            console.log('[DeviceAuth] 查找授权按钮...');
            await this.sleep(5000); // 等待页面加载

            const allowBtnSelectors = [
                'button:has-text("Confirm and continue")',  // AWS 新版授权页面
                'button:has-text("Accept")',
                'button:has-text("Allow")',
                'button:has-text("Authorize")',
                'button:has-text("Confirm")',
                'button:has-text("允许")',
                'button:has-text("授权")',
                'button[type="submit"]'
            ];

            let allowBtn = null;
            let foundSelector = null;

            // 重试 10 次，每次等待 2 秒
            for (let retry = 0; retry < 10; retry++) {
                console.log(`[DeviceAuth] 查找授权按钮... (尝试 ${retry + 1}/10)`);

                for (const selector of allowBtnSelectors) {
                    try {
                        const btn = await this.page.$(selector);
                        if (btn) {
                            const isVisible = await btn.isVisible();
                            const isEnabled = await btn.isEnabled();
                            if (isVisible && isEnabled) {
                                console.log(`[DeviceAuth] ✓ 找到可见且可点击的按钮: ${selector}`);
                                allowBtn = btn;
                                foundSelector = selector;
                                break;
                            } else {
                                console.log(`[DeviceAuth] 找到按钮但不可用: ${selector} (visible=${isVisible}, enabled=${isEnabled})`);
                            }
                        }
                    } catch (e) {
                        // 继续尝试下一个选择器
                    }
                }

                if (allowBtn) break;

                console.log('[DeviceAuth] 未找到可用按钮，等待 2 秒后重试...');
                await this.sleep(2000);
            }

            if (!allowBtn) {
                console.error('[DeviceAuth] ✗ 未找到可点击的授权按钮');
                await this.screenshot('no-auth-button');

                // 输出页面内容用于调试
                const pageContent = await this.page.content();
                console.log('[DeviceAuth] 页面内容片段:', pageContent.substring(0, 500));

                throw new Error('未找到可点击的授权按钮');
            }

            const authPageUrl = this.page.url();
            console.log(`[DeviceAuth] 点击前 URL: ${authPageUrl}`);

            // 随机延迟 2-5 秒（模拟人类阅读授权内容后决定）
            await this.randomSleep(2000, 5000);

            console.log('[DeviceAuth] 点击授权按钮...');
            const allowBtnText = await allowBtn.textContent();
            console.log(`[DeviceAuth] 授权按钮文本: ${allowBtnText}`);

            // 使用 Playwright 的 click 方法，带重试
            try {
                await allowBtn.click({ timeout: 10000 });
                console.log('[DeviceAuth] ✓ 点击成功，等待页面跳转...');
            } catch (clickError) {
                console.error(`[DeviceAuth] ✗ 点击失败: ${clickError.message}`);
                await this.screenshot('click-failed');
                throw new Error(`授权按钮点击失败: ${clickError.message}`);
            }

            // 等待页面跳转
            console.log('[DeviceAuth] 等待页面跳转...');
            await this.sleep(3000);

            // 检查是否有第二个授权按钮 "Allow access"
            console.log('[DeviceAuth] 检查是否有第二个授权按钮...');
            await this.sleep(2000);

            const allowAccessSelectors = [
                'button:has-text("Allow access")',
                'button:has-text("Allow")',
                'button:has-text("Authorize")',
                'button:has-text("授权访问")'
            ];

            let allowAccessBtn = null;
            for (let retry = 0; retry < 5; retry++) {
                console.log(`[DeviceAuth] 查找 "Allow access" 按钮... (尝试 ${retry + 1}/5)`);

                for (const selector of allowAccessSelectors) {
                    try {
                        const btn = await this.page.$(selector);
                        if (btn) {
                            const isVisible = await btn.isVisible();
                            const isEnabled = await btn.isEnabled();
                            if (isVisible && isEnabled) {
                                console.log(`[DeviceAuth] ✓ 找到第二个授权按钮: ${selector}`);
                                allowAccessBtn = btn;
                                break;
                            }
                        }
                    } catch (e) {
                        // 继续尝试
                    }
                }

                if (allowAccessBtn) break;
                await this.sleep(1000);
            }

            if (allowAccessBtn) {
                console.log('[DeviceAuth] 找到第二个授权按钮');

                // 随机延迟 2-5 秒（模拟人类思考）
                await this.randomSleep(2000, 5000);

                console.log('[DeviceAuth] 点击 "Allow access" 按钮...');
                try {
                    const btnText = await allowAccessBtn.textContent();
                    console.log(`[DeviceAuth] 按钮文本: ${btnText}`);
                    await allowAccessBtn.click({ timeout: 10000 });
                    console.log('[DeviceAuth] ✓ 点击成功');
                    await this.sleep(3000);
                } catch (clickError) {
                    console.error(`[DeviceAuth] ✗ 点击失败: ${clickError.message}`);
                    await this.screenshot('allow-access-click-failed');
                    throw new Error(`"Allow access" 按钮点击失败: ${clickError.message}`);
                }
            } else {
                console.log('[DeviceAuth] 未找到第二个授权按钮，可能不需要');
            }

            // 等待授权完成
            console.log('[DeviceAuth] 等待授权完成...');
            let authSuccess = false;

            for (let i = 0; i < 10; i++) {
                await this.sleep(1000);
                const currentUrl = this.page.url();
                const pageContent = await this.page.content();

                // 检查是否授权成功（页面包含成功关键词）
                if (pageContent.includes('success') ||
                    pageContent.includes('authorized') ||
                    pageContent.includes('完成') ||
                    pageContent.includes('Success') ||
                    pageContent.includes('approved') ||
                    currentUrl.includes('profile.aws.amazon.com')) {
                    console.log(`[DeviceAuth] ✓ 授权成功 (${i + 1}s)`);
                    console.log(`[DeviceAuth] 最终 URL: ${currentUrl}`);
                    authSuccess = true;
                    break;
                }
            }

            if (!authSuccess) {
                console.error('[DeviceAuth] ✗ 授权未完成，超时');
                await this.screenshot('auth-timeout');
                throw new Error('授权超时，页面未响应');
            }

            return { success: true };

        } catch (error) {
            console.error(`[DeviceAuth] 授权异常: ${error.message}`);
            await this.screenshot('device-auth-error');
            return { success: false, error: error.message };
        }
    }

    /**
     * 生成统一格式的 AWS 密码
     * 格式: Xwechat.fileswxid.{accountNumber}
     */
    generatePassword(accountNumber) {
        return `Xwechat.fileswxid.${accountNumber}`;
    }

    /**
     * 截图
     */
    async screenshot(name) {
        try {
            const fs = await import('fs');
            const path = await import('path');
            const dir = './logs/screenshots';
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const filePath = path.join(dir, `${name}-${Date.now()}.png`);
            await this.page.screenshot({ path: filePath, fullPage: true });
            console.log(`[Screenshot] 已保存: ${filePath}`);
        } catch (error) {
            console.warn(`[Screenshot] 截图失败: ${error.message}`);
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 随机延迟（模拟人类行为）
     * @param {number} minMs - 最小延迟（毫秒）
     * @param {number} maxMs - 最大延迟（毫秒）
     */
    async randomSleep(minMs, maxMs) {
        const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        console.log(`[Random Delay] 随机等待 ${(delay / 1000).toFixed(1)} 秒...`);
        await this.sleep(delay);
    }
}

export default KiroRegister;

/**
 * AWS Builder ID 注册自动化
 * 使用 Playwright 连接 Roxy Browser 进行自动化操作
 */

import { chromium } from 'playwright-core';
import config from './config.js';

export class AWSBuilderIDRegister {
    constructor(roxyBrowser, emailApi) {
        this.roxyBrowser = roxyBrowser;
        this.emailApi = emailApi;
        this.browser = null;
        this.context = null;
        this.page = null;
        this.envId = null;
    }

    /**
     * 初始化浏览器
     * @param {string} windowName - 窗口名称
     */
    async init(windowName) {
        console.log('[AWSRegister] 初始化浏览器...');

        // 创建并打开 Roxy Browser 窗口
        const windowInfo = await this.roxyBrowser.createAndOpen(windowName);
        this.envId = windowInfo.envId;

        // 连接到浏览器
        this.browser = await chromium.connectOverCDP(windowInfo.ws);
        this.context = this.browser.contexts()[0];
        this.page = this.context.pages()[0] || await this.context.newPage();

        // 设置超时
        this.page.setDefaultTimeout(config.register.pageTimeout);

        console.log('[AWSRegister] 浏览器初始化完成');
        return this;
    }

    /**
     * 关闭浏览器
     */
    async close() {
        try {
            if (this.browser) {
                await this.browser.close();
            }
            if (this.envId) {
                await this.roxyBrowser.closeWindow(this.envId);
            }
        } catch (error) {
            console.warn(`[AWSRegister] 关闭浏览器时出错: ${error.message}`);
        }
    }

    /**
     * 注册 AWS Builder ID
     * @param {object} emailAccount - 邮箱账号信息
     * @returns {Promise<{success: boolean, refreshToken?: string, error?: string}>}
     */
    async register(emailAccount) {
        const { email, password } = emailAccount;
        console.log(`[AWSRegister] 开始注册 AWS Builder ID: ${email}`);

        try {
            // 1. 访问 AWS Builder ID 注册页面
            await this.page.goto('https://profile.aws.amazon.com/', { waitUntil: 'networkidle' });
            await this.sleep(2000);

            // 2. 点击 "Create your AWS Builder ID" 或类似按钮
            const createButton = await this.page.$('text=Create');
            if (createButton) {
                await createButton.click();
                await this.sleep(2000);
            }

            // 3. 输入邮箱
            console.log('[AWSRegister] 输入邮箱...');
            const emailInput = await this.page.waitForSelector('input[type="email"], input[name="email"], #email');
            await emailInput.fill(email);
            await this.sleep(500);

            // 4. 点击下一步/继续
            const nextButton = await this.page.$('button[type="submit"], text=Next, text=Continue, text=下一步');
            if (nextButton) {
                await nextButton.click();
            }
            await this.sleep(3000);

            // 5. 输入用户名（通常是邮箱前缀）
            const usernameInput = await this.page.$('input[name="name"], input[name="username"], #name');
            if (usernameInput) {
                const username = email.split('@')[0];
                await usernameInput.fill(username);
                await this.sleep(500);
            }

            // 6. 等待并获取验证码
            console.log('[AWSRegister] 等待验证码邮件...');
            const verificationCode = await this.emailApi.waitForAWSVerificationCode(
                email,
                password,
                config.register.verificationCodeTimeout,
                config.register.verificationCodePollInterval
            );

            // 7. 输入验证码
            console.log(`[AWSRegister] 输入验证码: ${verificationCode}`);
            const codeInput = await this.page.waitForSelector('input[name="code"], input[name="verificationCode"], #code');
            await codeInput.fill(verificationCode);
            await this.sleep(500);

            // 8. 点击验证按钮
            const verifyButton = await this.page.$('button[type="submit"], text=Verify, text=验证');
            if (verifyButton) {
                await verifyButton.click();
            }
            await this.sleep(3000);

            // 9. 设置密码（如果需要）
            const passwordInput = await this.page.$('input[type="password"], input[name="password"]');
            if (passwordInput) {
                // 生成一个强密码
                const awsPassword = this.generatePassword();
                await passwordInput.fill(awsPassword);

                const confirmPasswordInput = await this.page.$('input[name="confirmPassword"], input[name="password_confirm"]');
                if (confirmPasswordInput) {
                    await confirmPasswordInput.fill(awsPassword);
                }

                console.log(`[AWSRegister] 设置密码: ${awsPassword}`);
                await this.sleep(500);

                const submitButton = await this.page.$('button[type="submit"]');
                if (submitButton) {
                    await submitButton.click();
                }
                await this.sleep(3000);
            }

            // 10. 检查是否注册成功
            const currentUrl = this.page.url();
            if (currentUrl.includes('profile') || currentUrl.includes('success') || currentUrl.includes('dashboard')) {
                console.log('[AWSRegister] AWS Builder ID 注册成功！');
                return { success: true, email };
            }

            // 检查错误信息
            const errorElement = await this.page.$('.error, .alert-error, [role="alert"]');
            if (errorElement) {
                const errorText = await errorElement.textContent();
                throw new Error(`注册失败: ${errorText}`);
            }

            return { success: true, email };

        } catch (error) {
            console.error(`[AWSRegister] 注册失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 执行设备授权流程
     * @param {string} verificationUri - 验证 URI
     * @param {string} userCode - 用户码
     */
    async completeDeviceAuthorization(verificationUri, userCode) {
        console.log(`[AWSRegister] 开始设备授权流程...`);
        console.log(`[AWSRegister] 验证 URI: ${verificationUri}`);
        console.log(`[AWSRegister] 用户码: ${userCode}`);

        try {
            // 访问验证页面
            await this.page.goto(verificationUri, { waitUntil: 'networkidle' });
            await this.sleep(2000);

            // 输入用户码
            const codeInput = await this.page.waitForSelector('input[name="user_code"], input[name="code"], #user_code');
            if (codeInput) {
                await codeInput.fill(userCode);
                await this.sleep(500);

                const submitButton = await this.page.$('button[type="submit"], text=Submit, text=Confirm');
                if (submitButton) {
                    await submitButton.click();
                }
            }

            await this.sleep(3000);

            // 点击允许/授权按钮
            const allowButton = await this.page.$('text=Allow, text=Authorize, text=Confirm, text=允许');
            if (allowButton) {
                await allowButton.click();
                await this.sleep(3000);
            }

            console.log('[AWSRegister] 设备授权完成');
            return { success: true };

        } catch (error) {
            console.error(`[AWSRegister] 设备授权失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 登录已有的 AWS Builder ID
     * @param {string} email - 邮箱
     * @param {string} awsPassword - AWS 密码
     */
    async login(email, awsPassword) {
        console.log(`[AWSRegister] 登录 AWS Builder ID: ${email}`);

        try {
            await this.page.goto('https://profile.aws.amazon.com/', { waitUntil: 'networkidle' });
            await this.sleep(2000);

            // 输入邮箱
            const emailInput = await this.page.waitForSelector('input[type="email"], input[name="email"]');
            await emailInput.fill(email);

            const nextButton = await this.page.$('button[type="submit"], text=Next');
            if (nextButton) {
                await nextButton.click();
            }
            await this.sleep(2000);

            // 输入密码
            const passwordInput = await this.page.waitForSelector('input[type="password"]');
            await passwordInput.fill(awsPassword);

            const signInButton = await this.page.$('button[type="submit"], text=Sign in');
            if (signInButton) {
                await signInButton.click();
            }
            await this.sleep(3000);

            console.log('[AWSRegister] 登录成功');
            return { success: true };

        } catch (error) {
            console.error(`[AWSRegister] 登录失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * 生成强密码
     */
    generatePassword() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
        let password = '';
        // 确保包含各种字符类型
        password += 'A'; // 大写
        password += 'a'; // 小写
        password += '1'; // 数字
        password += '!'; // 特殊字符

        for (let i = 0; i < 12; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        // 打乱顺序
        return password.split('').sort(() => Math.random() - 0.5).join('');
    }

    /**
     * 等待
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 截图保存
     */
    async screenshot(name) {
        try {
            const path = `./logs/screenshots/${name}-${Date.now()}.png`;
            await this.page.screenshot({ path, fullPage: true });
            console.log(`[AWSRegister] 截图已保存: ${path}`);
        } catch (error) {
            console.warn(`[AWSRegister] 截图失败: ${error.message}`);
        }
    }
}

export default AWSBuilderIDRegister;

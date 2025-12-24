/**
 * Kiro 批量注册工具 - 主入口
 *
 * 使用方法:
 *   node index.js --register          # 开始批量注册
 *   node index.js --register --count=5  # 注册指定数量
 *   node index.js --test              # 测试所有连接
 *   node index.js --test-single       # 单个注册测试（手动模式）
 *   node index.js --status            # 查看邮箱池状态
 *   node index.js --reset             # 重置邮箱使用状态
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import EmailPool from './email-pool.js';
import EmailApiClient from './email-api.js';
import RoxyBrowserClient from './roxy-browser.js';
import Kiro2ApiClient from './kiro2api-client.js';
import KiroRegister from './kiro-register.js';
import ResultManager from './result-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 确保日志目录存在
const logsDir = path.join(__dirname, 'logs');
const screenshotsDir = path.join(__dirname, 'logs', 'screenshots');
const dataDir = path.join(__dirname, 'data');

[logsDir, screenshotsDir, dataDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

/**
 * 主程序
 */
class KiroRegisterTool {
    constructor() {
        this.emailPool = new EmailPool(config.emailPoolFile);
        this.emailApi = new EmailApiClient();
        this.roxyBrowser = new RoxyBrowserClient();
        this.kiro2api = new Kiro2ApiClient();
        this.resultManager = new ResultManager();
    }

    /**
     * 测试所有连接
     */
    async testConnections() {
        console.log('\n========== 连接测试 ==========\n');

        // 测试 Roxy Browser
        console.log('1. 测试 Roxy Browser...');
        const roxyResult = await this.roxyBrowser.test();
        console.log(`   结果: ${roxyResult.success ? '✓ 成功' : '✗ 失败'}`);
        if (roxyResult.success) {
            console.log(`   工作空间: ${roxyResult.workspaceId}`);
            console.log(`   窗口数: ${roxyResult.windowCount}`);
        } else {
            console.log(`   错误: ${roxyResult.error}`);
        }

        // 测试 Kiro2API
        console.log('\n2. 测试 Kiro2API 服务器...');
        const kiroResult = await this.kiro2api.test();
        console.log(`   结果: ${kiroResult.success ? '✓ 成功' : '✗ 失败'}`);
        if (!kiroResult.success) {
            console.log(`   错误: ${kiroResult.error}`);
        }

        // 加载邮箱池
        console.log('\n3. 加载邮箱池...');
        await this.emailPool.load();

        // 测试第一个邮箱的 API
        const firstEmail = this.emailPool.getNext();
        if (firstEmail) {
            console.log(`\n4. 测试邮箱 API (${firstEmail.email})...`);
            const emailResult = await this.emailApi.test(firstEmail.email, firstEmail);
            console.log(`   结果: ${emailResult.success ? '✓ 成功' : '✗ 失败'}`);
            if (emailResult.success) {
                console.log(`   邮件数: ${emailResult.count}`);
            } else {
                console.log(`   错误: ${emailResult.error}`);
            }
        }

        console.log('\n========== 测试完成 ==========\n');
    }

    /**
     * 显示邮箱池状态
     */
    async showStatus() {
        await this.emailPool.load();

        console.log('\n========== 邮箱池状态 ==========\n');
        console.log(`总数: ${this.emailPool.accounts.length}`);
        console.log(`已使用: ${this.emailPool.usedAccounts.size}`);
        console.log(`可用: ${this.emailPool.getAvailableCount()}`);

        console.log('\n可用邮箱列表:');
        const available = this.emailPool.accounts.filter(a => !this.emailPool.usedAccounts.has(a.email));
        available.slice(0, 10).forEach((account, i) => {
            console.log(`  ${i + 1}. ${account.email}`);
        });
        if (available.length > 10) {
            console.log(`  ... 还有 ${available.length - 10} 个`);
        }

        console.log('\n================================\n');
    }

    /**
     * 重置邮箱使用状态
     */
    async resetStatus() {
        await this.emailPool.load();
        await this.emailPool.reset();
        console.log('邮箱使用状态已重置');
    }

    /**
     * 清理所有浏览器窗口
     */
    async cleanBrowsers() {
        console.log('\n========== 清理浏览器窗口 ==========\n');
        const deleted = await this.roxyBrowser.cleanOldBrowsers(0);
        console.log(`\n已清理 ${deleted} 个浏览器窗口`);
        console.log('====================================\n');
    }

    /**
     * 批量注册（串行模式 - 一个接一个）
     * @param {number} count - 注册数量，0 表示全部
     */
    async batchRegister(count = 0) {
        console.log('\n========== 开始批量注册（串行模式）==========\n');

        // 加载邮箱池和已注册记录
        await this.emailPool.load();
        await this.resultManager.load();

        const availableCount = this.emailPool.getAvailableCount();
        if (availableCount === 0) {
            console.log('没有可用的邮箱账号');
            return;
        }

        // 获取起始账号编号
        let accountNumber = await this.kiro2api.getNextAccountNumber();

        // 如果获取失败（返回1），使用手动指定的起始编号
        if (accountNumber === 1 && config.register.startAccountNumber) {
            accountNumber = config.register.startAccountNumber;
            console.log(`使用手动指定的起始账号编号: ${accountNumber}`);
        } else {
            console.log(`起始账号编号: ${accountNumber}`);
        }

        const targetCount = count > 0 ? Math.min(count, availableCount) : availableCount;
        console.log(`计划注册: ${targetCount} 个账号`);
        console.log(`模式: 串行（一个接一个）\n`);

        let successCount = 0;
        let failCount = 0;
        const results = [];

        // 串行处理，一个接一个
        for (let i = 0; i < targetCount; i++) {
            const emailAccount = this.emailPool.getNext();
            if (!emailAccount) {
                console.log('没有更多可用邮箱');
                break;
            }

            const currentAccountNumber = accountNumber + i;

            console.log(`\n[${i + 1}/${targetCount}] 开始注册: ${emailAccount.email} (账号 ${currentAccountNumber})`);

            const register = new KiroRegister(
                this.roxyBrowser,
                this.emailApi,
                this.kiro2api
            );

            try {
                // 初始化浏览器
                await register.initBrowser(`kiro-${currentAccountNumber}-${Date.now()}`);

                // 执行注册
                const result = await register.register(emailAccount, currentAccountNumber);

                if (result.success) {
                    successCount++;
                    console.log(`\n[${i + 1}/${targetCount}] ✓ 注册成功: ${emailAccount.email}`);

                    // 标记邮箱为已使用
                    await this.emailPool.markUsed(emailAccount.email);

                    // 保存到结果管理器
                    await this.resultManager.addSuccess({
                        email: emailAccount.email,
                        emailPassword: emailAccount.password,
                        awsPassword: result.awsPassword,
                        accountNumber: currentAccountNumber,
                    });

                    results.push({
                        email: emailAccount.email,
                        awsPassword: result.awsPassword,
                        accountNumber: currentAccountNumber,
                        success: true,
                        timestamp: new Date().toISOString(),
                    });
                } else if (result.alreadyRegistered) {
                    // 邮箱已经注册过，标记为已使用并跳过
                    console.log(`\n[${i + 1}/${targetCount}] ⚠ 邮箱已注册，跳过: ${emailAccount.email}`);
                    await this.emailPool.markUsed(emailAccount.email);
                } else {
                    failCount++;
                    console.log(`\n[${i + 1}/${targetCount}] ✗ 注册失败: ${emailAccount.email}`);
                    console.log(`  错误: ${result.error}`);
                }
            } catch (error) {
                failCount++;
                console.error(`\n[${i + 1}/${targetCount}] ✗ 注册异常: ${emailAccount.email}`);
                console.error(`  错误: ${error.message}`);

                // 释放邮箱（允许重试）
                this.emailPool.releasePending(emailAccount.email);
            } finally {
                // 清理浏览器
                await register.closeBrowser();
            }

            // 等待一下再处理下一个
            if (i < targetCount - 1) {
                console.log(`\n等待 3 秒后继续下一个...\n`);
                await this.sleep(3000);
            }
        }

        // 输出统计
        console.log('\n========== 批量注册完成 ==========');
        console.log(`成功: ${successCount} 个`);
        console.log(`失败: ${failCount} 个`);
        console.log(`总计: ${successCount + failCount} 个\n`);

        if (results.length > 0) {
            console.log('成功注册的账号:');
            results.forEach(r => {
                console.log(`  ${r.email} -> 账号 ${r.accountNumber} (密码: ${r.awsPassword})`);
            });
        }
    }

    /**
     * 单个注册测试（手动模式）
     */
    async testSingleRegister() {
        console.log('\n========== 单个注册测试 ==========\n');

        await this.emailPool.load();
        await this.resultManager.load();
        const emailAccount = this.emailPool.getNext();

        if (!emailAccount) {
            console.log('没有可用的邮箱账号');
            return;
        }

        console.log(`测试邮箱: ${emailAccount.email}`);

        // 获取账号编号
        const accountNumber = await this.kiro2api.getNextAccountNumber();
        console.log(`账号编号: ${accountNumber}`);

        const register = new KiroRegister(
            this.roxyBrowser,
            this.emailApi,
            this.kiro2api
        );

        try {
            await register.initBrowser('test-register');

            console.log('\n浏览器已打开，开始自动注册流程...\n');

            // 执行注册
            const result = await register.register(emailAccount, accountNumber);

            if (result.success) {
                console.log('\n✓ 注册成功！');
                console.log(`  邮箱: ${result.email}`);
                console.log(`  AWS 密码: ${result.awsPassword}`);
                console.log(`  账号编号: ${result.accountNumber}`);

                // 标记邮箱为已使用（从号池中移除）
                await this.emailPool.markUsed(emailAccount.email);

                // 保存到结果管理器
                await this.resultManager.addSuccess({
                    email: emailAccount.email,
                    emailPassword: emailAccount.password,
                    awsPassword: result.awsPassword,
                    accountNumber: accountNumber,
                });
            } else {
                console.log(`\n✗ 注册失败: ${result.error}`);
            }

        } catch (error) {
            console.error(`测试失败: ${error.message}`);
        } finally {
            // 等待用户确认后关闭
            console.log('\n按 Ctrl+C 退出并关闭浏览器...');
            await new Promise((resolve) => {
                process.on('SIGINT', async () => {
                    await register.closeBrowser();
                    resolve();
                    process.exit(0);
                });
            });
        }
    }

    /**
     * 手动模式 - 只打开浏览器，不自动操作
     */
    async manualMode() {
        console.log('\n========== 手动模式 ==========\n');

        await this.emailPool.load();
        const emailAccount = this.emailPool.getNext();

        if (!emailAccount) {
            console.log('没有可用的邮箱账号');
            return;
        }

        console.log(`测试邮箱: ${emailAccount.email}`);
        console.log(`邮箱密码: ${emailAccount.password}`);

        const register = new KiroRegister(
            this.roxyBrowser,
            this.emailApi,
            this.kiro2api
        );

        try {
            await register.initBrowser('manual-test');

            console.log('\n浏览器已打开，请手动操作测试...');
            console.log('按 Ctrl+C 退出\n');

            // 保持运行
            await new Promise((resolve) => {
                process.on('SIGINT', async () => {
                    await register.closeBrowser();
                    resolve();
                    process.exit(0);
                });
            });

        } catch (error) {
            console.error(`测试失败: ${error.message}`);
            await register.closeBrowser();
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

/**
 * 命令行入口
 */
async function main() {
    const args = process.argv.slice(2);
    const tool = new KiroRegisterTool();

    if (args.includes('--test') || args.includes('--test-all')) {
        await tool.testConnections();
    } else if (args.includes('--test-browser')) {
        const result = await tool.roxyBrowser.test();
        console.log(result);
    } else if (args.includes('--test-email')) {
        await tool.emailPool.load();
        const email = tool.emailPool.getNext();
        if (email) {
            const result = await tool.emailApi.test(email.email, email.password);
            console.log(result);
        }
    } else if (args.includes('--test-kiro2api')) {
        const result = await tool.kiro2api.test();
        console.log(result);
    } else if (args.includes('--status')) {
        await tool.showStatus();
    } else if (args.includes('--reset')) {
        await tool.resetStatus();
    } else if (args.includes('--register')) {
        const countArg = args.find(a => a.startsWith('--count='));
        const count = countArg ? parseInt(countArg.split('=')[1]) : 0;
        const concurrentArg = args.find(a => a.startsWith('--concurrent='));
        const concurrent = concurrentArg ? parseInt(concurrentArg.split('=')[1]) : 3;
        await tool.batchRegister(count, concurrent);
    } else if (args.includes('--test-single')) {
        await tool.testSingleRegister();
    } else if (args.includes('--manual')) {
        await tool.manualMode();
    } else if (args.includes('--clean-browsers')) {
        await tool.cleanBrowsers();
    } else {
        console.log(`
Kiro 批量注册工具

使用方法:
  node index.js --test              测试所有连接
  node index.js --test-browser      测试 Roxy Browser
  node index.js --test-email        测试邮箱 API
  node index.js --test-kiro2api     测试 Kiro2API 服务器
  node index.js --status            查看邮箱池状态
  node index.js --reset             重置邮箱使用状态
  node index.js --clean-browsers    清理所有浏览器窗口
  node index.js --register          开始批量注册
  node index.js --register --count=5  注册指定数量
  node index.js --test-single       单个注册测试（自动模式）
  node index.js --manual            手动模式（只打开浏览器）

配置文件: config.js
邮箱池: ${config.emailPoolFile}
Kiro2API: ${config.kiro2api.baseUrl}
        `);
    }
}

main().catch(console.error);

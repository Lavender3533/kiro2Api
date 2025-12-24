/**
 * 邮箱池管理器
 * 解析 yx.txt 格式的邮箱账号
 * 格式: email----password----clientId----refreshToken
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class EmailPool {
    constructor(filePath) {
        this.filePath = path.resolve(__dirname, filePath);
        this.accounts = [];
        this.usedAccounts = new Set();
        this.pendingAccounts = new Set(); // 正在使用中的邮箱（并发控制）
        this.statusFile = path.resolve(__dirname, './data/email-status.json');
    }

    /**
     * 加载邮箱池
     */
    async load() {
        try {
            const content = await fs.promises.readFile(this.filePath, 'utf-8');
            const lines = content.split('\n').filter(line => line.trim());

            this.accounts = lines.map((line, index) => {
                // 移除行号前缀（如果有）
                const cleanLine = line.replace(/^\s*\d+→/, '').trim();
                if (!cleanLine) return null;

                const parts = cleanLine.split('----');
                if (parts.length < 4) {
                    console.warn(`[EmailPool] 跳过无效行 ${index + 1}: ${cleanLine.substring(0, 50)}...`);
                    return null;
                }

                return {
                    email: parts[0].trim(),
                    password: parts[1].trim(),
                    clientId: parts[2].trim(),
                    refreshToken: parts[3].trim(),
                    index: index + 1,
                };
            }).filter(Boolean);

            // 加载已使用状态
            await this.loadStatus();

            console.log(`[EmailPool] 加载了 ${this.accounts.length} 个邮箱账号`);
            console.log(`[EmailPool] 已使用: ${this.usedAccounts.size} 个`);
            console.log(`[EmailPool] 可用: ${this.getAvailableCount()} 个`);

            return this.accounts;
        } catch (error) {
            console.error(`[EmailPool] 加载邮箱池失败: ${error.message}`);
            throw error;
        }
    }

    /**
     * 加载使用状态
     */
    async loadStatus() {
        try {
            if (fs.existsSync(this.statusFile)) {
                const content = await fs.promises.readFile(this.statusFile, 'utf-8');
                const status = JSON.parse(content);
                this.usedAccounts = new Set(status.usedEmails || []);
            }
        } catch (error) {
            console.warn(`[EmailPool] 加载状态文件失败: ${error.message}`);
        }
    }

    /**
     * 保存使用状态
     */
    async saveStatus() {
        try {
            const dir = path.dirname(this.statusFile);
            if (!fs.existsSync(dir)) {
                await fs.promises.mkdir(dir, { recursive: true });
            }
            await fs.promises.writeFile(this.statusFile, JSON.stringify({
                usedEmails: Array.from(this.usedAccounts),
                lastUpdated: new Date().toISOString(),
            }, null, 2));
        } catch (error) {
            console.error(`[EmailPool] 保存状态失败: ${error.message}`);
        }
    }

    /**
     * 获取下一个可用邮箱（并发安全）
     */
    getNext() {
        for (const account of this.accounts) {
            // 跳过已使用和正在使用中的邮箱
            if (!this.usedAccounts.has(account.email) && !this.pendingAccounts.has(account.email)) {
                // 立即标记为正在使用中
                this.pendingAccounts.add(account.email);
                return account;
            }
        }
        return null;
    }

    /**
     * 标记邮箱为已使用（注册成功后调用）
     */
    async markUsed(email) {
        this.usedAccounts.add(email);
        this.pendingAccounts.delete(email); // 从正在使用中移除
        await this.saveStatus();
    }

    /**
     * 释放邮箱（注册失败后调用，允许重试）
     */
    releasePending(email) {
        this.pendingAccounts.delete(email);
    }

    /**
     * 获取可用邮箱数量
     */
    getAvailableCount() {
        return this.accounts.filter(a => !this.usedAccounts.has(a.email)).length;
    }

    /**
     * 获取所有账号
     */
    getAll() {
        return this.accounts;
    }

    /**
     * 重置所有状态
     */
    async reset() {
        this.usedAccounts.clear();
        await this.saveStatus();
        console.log('[EmailPool] 已重置所有邮箱状态');
    }
}

export default EmailPool;

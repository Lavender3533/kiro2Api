/**
 * 注册结果管理器
 * 保存已注册账号的信息
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class RegisterResultManager {
    constructor() {
        this.resultFile = path.resolve(__dirname, './data/registered-accounts.json');
        this.results = [];
    }

    /**
     * 加载已有结果
     */
    async load() {
        try {
            if (fs.existsSync(this.resultFile)) {
                const content = await fs.promises.readFile(this.resultFile, 'utf-8');
                this.results = JSON.parse(content);
                console.log(`[ResultManager] 加载了 ${this.results.length} 条注册记录`);
            }
        } catch (e) {
            console.warn(`[ResultManager] 加载结果文件失败: ${e.message}`);
            this.results = [];
        }
        return this.results;
    }

    /**
     * 保存结果
     */
    async save() {
        try {
            const dir = path.dirname(this.resultFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            await fs.promises.writeFile(this.resultFile, JSON.stringify(this.results, null, 2));
            console.log(`[ResultManager] 结果已保存到 ${this.resultFile}`);
        } catch (e) {
            console.error(`[ResultManager] 保存结果失败: ${e.message}`);
        }
    }

    /**
     * 添加成功的注册记录
     */
    async addSuccess(data) {
        const record = {
            email: data.email,
            emailPassword: data.emailPassword,
            awsPassword: data.awsPassword,
            kiroAccountNumber: data.accountNumber,
            registeredAt: new Date().toISOString(),
            status: 'success',
        };
        this.results.push(record);
        await this.save();
        console.log(`[ResultManager] 已保存注册记录: ${data.email}`);
        return record;
    }

    /**
     * 添加失败的注册记录
     */
    async addFailure(data) {
        const record = {
            email: data.email,
            error: data.error,
            registeredAt: new Date().toISOString(),
            status: 'failed',
        };
        this.results.push(record);
        await this.save();
        return record;
    }

    /**
     * 获取成功注册的数量
     */
    getSuccessCount() {
        return this.results.filter(r => r.status === 'success').length;
    }

    /**
     * 获取所有成功的记录
     */
    getSuccessRecords() {
        return this.results.filter(r => r.status === 'success');
    }

    /**
     * 导出为文本格式（方便查看）
     */
    async exportToText() {
        const textFile = path.resolve(__dirname, './data/registered-accounts.txt');
        const lines = ['# Kiro 注册账号列表', `# 生成时间: ${new Date().toISOString()}`, ''];

        const successRecords = this.getSuccessRecords();
        lines.push(`# 成功注册: ${successRecords.length} 个`, '');
        lines.push('# 格式: 邮箱 | 邮箱密码 | AWS密码 | Kiro账号编号 | 注册时间');
        lines.push('');

        for (const record of successRecords) {
            lines.push(`${record.email} | ${record.emailPassword || '-'} | ${record.awsPassword} | #${record.kiroAccountNumber} | ${record.registeredAt}`);
        }

        await fs.promises.writeFile(textFile, lines.join('\n'));
        console.log(`[ResultManager] 已导出到 ${textFile}`);
        return textFile;
    }
}

export default RegisterResultManager;

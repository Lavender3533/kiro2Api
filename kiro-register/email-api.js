/**
 * 邮箱 API 客户端
 * 用于获取 Outlook 邮箱的验证码
 */

import axios from 'axios';
import config from './config.js';

export class EmailApiClient {
    constructor() {
        this.baseUrl = config.emailApi.baseUrl;
    }

    /**
     * 获取最新邮件
     * @param {string} email - 邮箱地址
     * @param {string} clientId - 客户端 ID
     * @param {string} refreshToken - 刷新令牌
     * @param {number} num - 获取邮件数量
     * @param {number} boxType - 邮箱类型 (1=收件箱)
     * @returns {Promise<Array>} 邮件列表
     */
    async getLastEmails(email, clientId, refreshToken, num = 2, boxType = 1) {
        try {
            // API 最大支持 num=2
            if (num > 2) num = 2;

            const url = `${this.baseUrl}/api/GetLastEmails`;
            const params = { email, clientId, refreshToken, num, boxType };

            console.log(`[EmailAPI] 请求 URL: ${url}`);
            console.log(`[EmailAPI] 请求参数: email=${email}, num=${num}, boxType=${boxType}`);

            const response = await axios.get(url, {
                params,
                timeout: 30000,
            });

            console.log(`[EmailAPI] 响应状态: ${response.status}`);
            console.log(`[EmailAPI] 响应数据:`, JSON.stringify(response.data).substring(0, 500));

            // 检查响应格式
            if (response.data && response.data.code === 200) {
                const emails = response.data.data || [];
                console.log(`[EmailAPI] 成功获取 ${emails.length} 封邮件`);
                return emails;
            }

            console.warn(`[EmailAPI] 非标准响应格式，返回原始数据`);
            return response.data || [];
        } catch (error) {
            console.error(`[EmailAPI] 获取邮件失败: ${error.message}`);
            if (error.response) {
                console.error(`[EmailAPI] 响应状态: ${error.response.status}`);
                console.error(`[EmailAPI] 响应数据:`, error.response.data);
            }
            throw error;
        }
    }

    /**
     * 等待并获取 AWS 验证码
     * @param {string} email - 邮箱地址
     * @param {object} emailAccount - 邮箱账号信息 {email, password, clientId, refreshToken}
     * @param {number} timeout - 超时时间（毫秒）
     * @param {number} pollInterval - 轮询间隔（毫秒）
     * @returns {Promise<string>} 验证码
     */
    async waitForAWSVerificationCode(email, emailAccount, timeout = 120000, pollInterval = 3000) {
        const startTime = Date.now();
        const startTimestamp = new Date().toISOString();

        console.log(`[EmailAPI] 开始等待 AWS 验证码... (邮箱: ${email})`);
        console.log(`[EmailAPI] 开始时间: ${startTimestamp}`);

        while (Date.now() - startTime < timeout) {
            try {
                const emails = await this.getLastEmails(
                    email,
                    emailAccount.clientId,
                    emailAccount.refreshToken,
                    2,  // API 最大支持 2 封邮件
                    1
                );

                if (Array.isArray(emails) && emails.length > 0) {
                    console.log(`[EmailAPI] 收到 ${emails.length} 封邮件，开始检查...`);

                    // 查找 AWS 验证码邮件
                    for (let i = 0; i < emails.length; i++) {
                        const mail = emails[i];

                        // 检查是否是 AWS 发送的验证码邮件
                        const subject = mail.subject || mail.Subject || '';
                        const body = mail.body || mail.Body || mail.content || mail.Content || '';
                        const from = mail.from || mail.From || '';
                        const receivedTime = mail.receivedTime || mail.ReceivedTime || mail.date || mail.Date || '';

                        console.log(`[EmailAPI] 邮件 ${i + 1}:`);
                        console.log(`  发件人: ${from}`);
                        console.log(`  主题: ${subject}`);
                        console.log(`  时间: ${receivedTime}`);
                        console.log(`  内容长度: ${body.length} 字符`);

                        // 调试：输出部分邮件内容
                        if (body.length > 0) {
                            // 查找包含数字的部分
                            const digitMatches = body.match(/\d{3,}/g);
                            if (digitMatches) {
                                console.log(`  ⚙ 调试：邮件中的数字: ${digitMatches.slice(0, 10).join(', ')}`);
                            }

                            // 查找纯文本中的验证码（去掉HTML标签）
                            const textOnly = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
                            const textMatches = textOnly.match(/\b\d{6}\b/g);
                            if (textMatches) {
                                console.log(`  ⚙ 调试：纯文本中的6位数字: ${textMatches.slice(0, 5).join(', ')}`);
                            }
                        }

                        // 检查是否是新邮件（在开始等待之后收到的）
                        // 容忍 30 秒的时间差，因为邮件可能在提交表单时就已发送
                        if (receivedTime) {
                            const mailTime = new Date(receivedTime);
                            const startTime = new Date(startTimestamp);
                            const timeDiff = (startTime - mailTime) / 1000; // 秒

                            if (timeDiff > 30) {
                                console.log(`  ⏩ 跳过：旧邮件 (${mailTime.toISOString()} 早于开始时间 ${timeDiff.toFixed(1)} 秒)`);
                                continue;
                            } else if (timeDiff > 0) {
                                console.log(`  ✓ 接受：邮件在开始前 ${timeDiff.toFixed(1)} 秒发送（30秒容忍范围内）`);
                            } else {
                                console.log(`  ✓ 接受：新邮件 (${mailTime.toISOString()})`);
                            }
                        }

                        // AWS 验证码邮件特征
                        const fromLower = from.toLowerCase();
                        const subjectLower = subject.toLowerCase();

                        if (
                            (fromLower.includes('amazon') || fromLower.includes('aws') || fromLower.includes('no-reply')) &&
                            (subjectLower.includes('verification') || subjectLower.includes('验证') ||
                             subjectLower.includes('code') || subjectLower.includes('verify'))
                        ) {
                            console.log(`  ✓ 匹配 AWS 验证码邮件特征`);

                            // 先将 HTML 转换为纯文本（去掉所有标签）
                            const textOnly = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

                            // 在纯文本中提取 6 位数字验证码
                            const codeMatch = textOnly.match(/\b(\d{6})\b/);
                            if (codeMatch) {
                                console.log(`[EmailAPI] ✓ 找到验证码: ${codeMatch[1]}`);
                                return codeMatch[1];
                            } else {
                                console.log(`  ✗ 未在邮件纯文本中找到 6 位验证码`);
                            }
                        }

                        // 备用：直接在邮件内容中查找 6 位验证码
                        const allTextLower = (subject + ' ' + body).toLowerCase();
                        if (allTextLower.includes('aws') || allTextLower.includes('amazon') || allTextLower.includes('builder')) {
                            console.log(`  ✓ 邮件包含 AWS/Amazon/Builder 关键词`);

                            // 同样先转换为纯文本
                            const textOnly = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
                            const codeMatch = textOnly.match(/\b(\d{6})\b/);
                            if (codeMatch) {
                                console.log(`[EmailAPI] ✓ 找到验证码 (备用匹配): ${codeMatch[1]}`);
                                return codeMatch[1];
                            }
                        }
                    }
                } else {
                    console.log(`[EmailAPI] 暂无新邮件`);
                }
            } catch (error) {
                console.warn(`[EmailAPI] 轮询邮件失败: ${error.message}`);
            }

            // 等待下一次轮询
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            console.log(`[EmailAPI] 等待验证码中... (${elapsed}s / ${timeout / 1000}s)`);
        }

        throw new Error(`等待验证码超时 (${timeout / 1000}s)`);
    }

    /**
     * 测试邮箱 API 连接
     */
    async test(email, emailAccount) {
        try {
            console.log(`[EmailAPI] 测试邮箱: ${email}`);
            const emails = await this.getLastEmails(
                email,
                emailAccount.clientId,
                emailAccount.refreshToken,
                2,  // API 最大支持 2 封邮件
                1
            );
            console.log(`[EmailAPI] 获取到 ${Array.isArray(emails) ? emails.length : 0} 封邮件`);

            // 显示每封邮件的基本信息
            if (Array.isArray(emails) && emails.length > 0) {
                emails.forEach((mail, i) => {
                    const subject = mail.subject || mail.Subject || '';
                    const from = mail.from || mail.From || '';
                    const date = mail.receivedTime || mail.ReceivedTime || mail.date || mail.Date || '';
                    console.log(`  邮件 ${i + 1}: ${from} - ${subject} (${date})`);
                });
            }

            return { success: true, count: Array.isArray(emails) ? emails.length : 0 };
        } catch (error) {
            console.error(`[EmailAPI] 测试失败: ${error.message}`);
            return { success: false, error: error.message };
        }
    }
}

export default EmailApiClient;

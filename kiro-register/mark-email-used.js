/**
 * 手动标记邮箱为已使用
 * 用法: node mark-email-used.js qzseqet28367@hotmail.com
 */

import EmailPool from './email-pool.js';
import config from './config.js';

const email = process.argv[2];

if (!email) {
    console.log('用法: node mark-email-used.js <email>');
    process.exit(1);
}

const pool = new EmailPool(config.emailPoolFile);
await pool.load();

console.log(`标记邮箱为已使用: ${email}`);
await pool.markUsed(email);

console.log('✓ 完成');
console.log(`可用邮箱数: ${pool.getAvailableCount()}`);

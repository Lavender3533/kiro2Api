import { KiroApiService } from './src/claude/claude-kiro.js';
import { promises as fs } from 'fs';

async function testModels() {
    // 读取第一个有效的凭据
    const poolsContent = await fs.readFile('provider_pools.json', 'utf8');
    const pools = JSON.parse(poolsContent);
    const firstPool = pools['claude-kiro-oauth'][0];

    const config = {
        KIRO_OAUTH_CREDS_FILE_PATH: firstPool.KIRO_OAUTH_CREDS_FILE_PATH
    };

    const service = new KiroApiService(config);
    await service.initialize();

    // 测试不同的模型名称
    const testModels = [
        'claude-sonnet-4-20250514',
        'CLAUDE_SONNET_4_20250514_V1_0',
        'claude-haiku-4-5',
        'claude-opus-4-20250514',
        'claude-opus-4.5'
    ];

    console.log('\n=== Testing Model Support ===\n');

    for (const model of testModels) {
        try {
            const requestBody = { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 };
            const result = await service.generateContent(model, requestBody);
            console.log(`SUCCESS: ${model}`);
        } catch (error) {
            const status = error.response?.status || 'ERROR';
            const msg = error.message.substring(0, 80);
            console.log(`FAILED: ${model} (${status}) - ${msg}`);
        }
    }
}

testModels().catch(console.error);

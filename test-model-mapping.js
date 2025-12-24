import { KiroApiService } from './src/claude/claude-kiro.js';
import { promises as fs } from 'fs';

async function testModelMapping() {
    console.log('\n=== Testing Model Mapping ===\n');

    // 读取第一个有效的凭据
    const poolsContent = await fs.readFile('provider_pools.json', 'utf8');
    const pools = JSON.parse(poolsContent);
    const firstPool = pools['claude-kiro-oauth'][0];

    const config = {
        KIRO_OAUTH_CREDS_FILE_PATH: firstPool.KIRO_OAUTH_CREDS_FILE_PATH
    };

    const service = new KiroApiService(config);
    await service.initialize();

    // 测试 Anthropic 官方模型 ID 是否能正确映射
    const testCases = [
        { input: 'claude-opus-4-5-20251101', expected: 'should map to claude-opus-4.5' },
        { input: 'claude-haiku-4-5-20251001', expected: 'should map to claude-haiku-4-5' },
        { input: 'claude-sonnet-4-5-20250929', expected: 'should map to claude-sonnet-4-20250514' },
        { input: 'claude-haiku-4-5', expected: 'should use claude-haiku-4-5 directly' }
    ];

    for (const testCase of testCases) {
        try {
            const requestBody = {
                messages: [{ role: 'user', content: 'Test' }],
                max_tokens: 1
            };

            console.log(`\nTesting: ${testCase.input}`);
            console.log(`Expected: ${testCase.expected}`);

            const result = await service.generateContent(testCase.input, requestBody);
            console.log(`✓ SUCCESS - Model ${testCase.input} works`);
            console.log(`  Response model: ${result.model}`);

        } catch (error) {
            const status = error.response?.status || 'ERROR';
            const msg = error.message.substring(0, 100);
            console.log(`✗ FAILED - ${testCase.input} (${status})`);
            console.log(`  Error: ${msg}`);
        }
    }
}

testModelMapping().catch(console.error);

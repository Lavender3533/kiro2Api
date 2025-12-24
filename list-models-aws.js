import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';

async function listAvailableModels() {
    // 读取凭据
    const poolsContent = await fs.readFile('provider_pools.json', 'utf8');
    const pools = JSON.parse(poolsContent);
    const firstPool = pools['claude-kiro-oauth'][0];

    const credsPath = firstPool.KIRO_OAUTH_CREDS_FILE_PATH;
    const credsContent = await fs.readFile(credsPath, 'utf8');
    const creds = JSON.parse(credsContent);

    const accessToken = creds.accessToken;
    const profileArn = creds.profileArn;
    const region = creds.region || 'us-east-1';

    // AWS CodeWhisperer List Available Models API
    const url = `https://codewhisperer.${region}.amazonaws.com/listAvailableModels`;

    const requestBody = {
        origin: 'AI_EDITOR',
        profileArn: profileArn
    };

    try {
        const response = await axios.post(url, requestBody, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'amz-sdk-invocation-id': uuidv4()
            }
        });

        console.log('\n=== Available Models from AWS API ===\n');
        console.log(JSON.stringify(response.data, null, 2));

        if (response.data.models) {
            console.log('\n=== Model IDs ===\n');
            response.data.models.forEach(model => {
                console.log(`- ${model.modelId} (${model.modelName || 'no name'})`);
            });
        }

        if (response.data.defaultModel) {
            console.log('\n=== Default Model ===\n');
            console.log(`${response.data.defaultModel.modelId} (${response.data.defaultModel.modelName || 'no name'})`);
        }
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
    }
}

listAvailableModels().catch(console.error);

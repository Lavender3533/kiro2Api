/**
 * 各提供商支持的模型列表
 * 用于前端UI选择不支持的模型
 * 只保留 Kiro OAuth 渠道
 */

export const PROVIDER_MODELS = {
    'claude-kiro-oauth': [
        // Sonnet 4.0 (AWS CodeWhisperer 原生支持)
        'claude-sonnet-4-20250514',
        // Opus 4.5 (AWS CodeWhisperer 原生支持)
        'claude-opus-4.5',
        // Haiku 4.5 (AWS CodeWhisperer 原生支持)
        'claude-haiku-4-5',
        // 支持常见的Anthropic官方模型ID（通过FULL_MODEL_MAPPING映射）
        'claude-opus-4-5-20251101',
        'claude-haiku-4-5-20251001',
        'CLAUDE_SONNET_4_20250514_V1_0',
        'claude-sonnet-4-5',
        'claude-sonnet-4-5-20250929'
    ]
};

/**
 * 获取指定提供商类型支持的模型列表
 * @param {string} providerType - 提供商类型
 * @returns {Array<string>} 模型列表
 */
export function getProviderModels(providerType) {
    return PROVIDER_MODELS[providerType] || [];
}

/**
 * 获取所有提供商的模型列表
 * @returns {Object} 所有提供商的模型映射
 */
export function getAllProviderModels() {
    return PROVIDER_MODELS;
}
# Kiro OAuth 2 API

> 基于 AWS CodeWhisperer (Kiro) 的 Claude API 兼容代理服务

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-%3E%3D5.0.0-blue.svg)](https://www.typescriptlang.org/)

## 📖 项目简介

Kiro OAuth 2 API 是一个强大的代理服务，将 AWS CodeWhisperer (Kiro) 的 OAuth 认证转换为 Claude API 兼容格式。支持 Claude Code、Cursor 等 AI 编程工具，提供完整的 Provider Pool 管理功能。

### ✨ 核心特性

- 🔐 **Kiro OAuth 认证** - 支持 AWS CodeWhisperer OAuth 2.0 认证
- 🔄 **Claude API 兼容** - 完全兼容 Claude Messages API (`/v1/messages`)
- 🎯 **Provider Pool 管理** - 多账号池管理，自动负载均衡和健康检查
- 💭 **Extended Thinking** - 支持 Claude Extended Thinking 功能
- 🛠️ **工具调用支持** - 完整支持 Claude Tools API
- 📊 **Web UI 管理** - 现代化的管理界面
- 🔄 **自动 Token 刷新** - 自动刷新过期的 OAuth Token
- 📝 **详细日志** - 可配置的日志系统

## 🚀 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0

### 安装步骤

1. **克隆仓库**

```bash
git clone https://github.com/Lavender3533/kiro2Api.git
cd kiro2Api
```

2. **安装依赖**

```bash
npm install
```

3. **配置服务**

复制示例配置文件：

```bash
cp config.json.example config.json
```

编辑 `config.json`：

```json
{
  "REQUIRED_API_KEY": "your-secret-key",
  "SERVER_PORT": 8045,
  "HOST": "0.0.0.0",
  "MODEL_PROVIDER": "claude-kiro-oauth",
  "KIRO_OAUTH_CREDS_FILE_PATH": "./configs/kiro/kiro-auth-token.json",
  "PROVIDER_POOLS_FILE_PATH": "provider_pools.json",
  "ENABLE_THINKING_BY_DEFAULT": true
}
```

4. **启动服务**

```bash
# 开发模式
npm start

# 生产模式（使用 PM2）
npm run pm2:start
```

5. **访问管理界面**

打开浏览器访问：`http://localhost:8045`

默认登录密码：`config.json` 中的 `REQUIRED_API_KEY`

## 📚 使用指南

### 获取 Kiro OAuth Token

#### 方法 1：通过管理界面（推荐）

1. 访问 `http://localhost:8045/login.html`
2. 登录后进入 "凭据管理" 页面
3. 点击 "开始 Kiro OAuth 授权"
4. 按照提示完成 AWS Builder ID 授权
5. Token 会自动保存到 `configs/kiro/` 目录

#### 方法 2：手动导入

如果你已有 Kiro OAuth Token：

```bash
# 将 token 文件放到 configs/kiro/ 目录
mkdir -p configs/kiro
cp your-kiro-token.json configs/kiro/kiro-auth-token.json
```

### 配置 Claude Code

在 Claude Code 中配置自定义 API：

```json
{
  "anthropic.apiKey": "your-secret-key",
  "anthropic.baseUrl": "http://localhost:8045"
}
```

### 配置 Cursor

在 Cursor 设置中：

1. 打开 Settings → Models
2. 选择 "Custom API"
3. 填写：
   - API Key: `your-secret-key`
   - Base URL: `http://localhost:8045`

## 🔧 高级功能

### Provider Pool 管理

支持多账号池管理，自动负载均衡：

```json
{
  "claude-kiro-oauth": [
    {
      "uuid": "account-1",
      "KIRO_OAUTH_CREDS_FILE_PATH": "./configs/kiro/token-1.json",
      "isHealthy": true
    },
    {
      "uuid": "account-2",
      "KIRO_OAUTH_CREDS_FILE_PATH": "./configs/kiro/token-2.json",
      "isHealthy": true
    }
  ]
}
```

通过管理界面可以：
- 查看所有账号状态
- 添加/删除账号
- 手动标记账号健康状态
- 查看使用统计

### Extended Thinking

启用 Extended Thinking 功能：

```json
{
  "ENABLE_THINKING_BY_DEFAULT": true
}
```

或在请求中指定：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

## 📁 项目结构

```
.
├── src/                      # 后端源码
│   ├── claude/              # Kiro API 实现
│   │   ├── claude-kiro.js   # Kiro OAuth 客户端
│   │   └── claude-kiro-server.js
│   ├── converters/          # API 格式转换器
│   ├── ui-manager.js        # Web UI 管理
│   └── api-server.js        # 主服务器
├── frontend/                # 前端源码 (Next.js)
│   ├── app/                 # 页面组件
│   └── components/          # UI 组件
├── configs/                 # 配置文件目录
│   └── kiro/               # Kiro Token 存储
├── config.json             # 主配置文件
└── provider_pools.json     # Provider Pool 配置
```

## 🔐 安全建议

1. **修改默认密钥**

```json
{
  "REQUIRED_API_KEY": "使用强密码替换"
}
```

2. **使用 HTTPS**

生产环境建议使用 nginx 反向代理并配置 SSL：

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8045;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

3. **限制访问**

使用防火墙限制访问来源：

```bash
# 只允许本地访问
ufw allow from 127.0.0.1 to any port 8045
```

## 🛠️ 配置参数

### 基础配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `REQUIRED_API_KEY` | string | `"123456"` | API 访问密钥 |
| `SERVER_PORT` | number | `8045` | 服务端口 |
| `HOST` | string | `"0.0.0.0"` | 监听地址 |
| `MODEL_PROVIDER` | string | `"claude-kiro-oauth"` | 模型提供商 |

### Kiro OAuth 配置

| 参数 | 类型 | 说明 |
|------|------|------|
| `KIRO_OAUTH_CREDS_FILE_PATH` | string | Token 文件路径 |
| `KIRO_OAUTH_CREDS_BASE64` | string | Base64 编码的 Token |

### 高级配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `PROVIDER_POOLS_FILE_PATH` | string | `"provider_pools.json"` | Provider Pool 配置文件 |
| `REQUEST_MAX_RETRIES` | number | `8` | 最大重试次数 |
| `REQUEST_BASE_DELAY` | number | `3000` | 重试延迟（毫秒）|
| `CRON_REFRESH_TOKEN` | boolean | `true` | 自动刷新 Token |
| `CRON_NEAR_MINUTES` | number | `15` | Token 刷新间隔（分钟）|
| `ENABLE_THINKING_BY_DEFAULT` | boolean | `true` | 默认启用 Thinking |
| `MAX_ERROR_COUNT` | number | `5` | 最大错误次数 |

### Redis 缓存配置（可选）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `REDIS_ENABLED` | boolean | `false` | 是否启用 Redis 缓存 |
| `REDIS_HOST` | string | `"localhost"` | Redis 服务器地址 |
| `REDIS_PORT` | number | `6379` | Redis 端口 |
| `REDIS_PASSWORD` | string | `""` | Redis 密码（可选）|
| `REDIS_DB` | number | `0` | Redis 数据库编号 |

启用 Redis 可以提升性能，缓存包括：
- Token 缓存（1小时）
- Provider 健康状态（5分钟）
- 会话历史（30分钟）
- 请求缓存（1分钟）

## 🐛 故障排除

### 常见问题

**1. 413 Request Entity Too Large**

增加 nginx 请求体大小限制：

```nginx
client_max_body_size 100M;
```

**2. 504 Gateway Timeout**

增加 nginx 超时时间：

```nginx
proxy_connect_timeout 300s;
proxy_send_timeout 300s;
proxy_read_timeout 300s;
```

**3. Token 过期**

- 检查 `kiro-oauth-states.json` 中的 Token 状态
- 通过管理界面重新授权
- 或手动刷新 Token

**4. Provider Pool 无可用账号**

- 检查 `provider_pools.json` 中账号的 `isHealthy` 状态
- 通过管理界面查看账号详情
- 删除失效账号或重新授权

## 📊 监控与日志

### 查看日志

```bash
# PM2 日志
pm2 logs

# 实时日志
tail -f ~/.pm2/logs/kiro2api-out.log
tail -f ~/.pm2/logs/kiro2api-error.log
```

### 健康检查

```bash
# 检查服务状态
curl http://localhost:8045/health

# 查看统计信息
curl http://localhost:8045/stats
```

### 管理界面

访问 `http://localhost:8045/dashboard` 查看：
- Provider 使用统计
- 账号健康状态
- 请求日志
- 系统配置

## 🤝 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📄 许可证

本项目采用 Apache 2.0 许可证 - 查看 [LICENSE](LICENSE) 文件了解详情

## 🙏 致谢

- [AWS CodeWhisperer](https://aws.amazon.com/codewhisperer/) - 提供 AI 编程助手服务
- [Anthropic Claude](https://www.anthropic.com/) - 提供 Claude API 标准
- [Next.js](https://nextjs.org/) - 前端框架
- [PM2](https://pm2.keymetrics.io/) - 进程管理

## 📮 联系方式

如有问题或建议，请通过以下方式联系：

- 提交 [Issue](https://github.com/Lavender3533/kiro2Api/issues)
- 发送邮件至：285567389@qq.com

---

**⚠️ 免责声明**

本项目仅供学习和研究使用。使用本项目时，请遵守 AWS 服务条款和相关法律法规。作者不对使用本项目造成的任何后果负责。

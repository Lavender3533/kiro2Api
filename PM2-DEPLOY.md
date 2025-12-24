# PM2 一键部署指南

## 快速开始

### 方式一：使用脚本（推荐）

**Linux/Mac 服务器：**
```bash
# 1. 赋予执行权限（首次使用）
chmod +x start-pm2.sh stop-pm2.sh restart-pm2.sh

# 2. 启动服务
./start-pm2.sh

# 3. 重启服务
./restart-pm2.sh

# 4. 停止服务
./stop-pm2.sh
```

**Windows 服务器：**
```bash
# 命令行执行
start-pm2.bat

# 重启
restart-pm2.bat

# 停止
stop-pm2.bat
```

### 方式二：使用 npm 命令（跨平台）

```bash
# 启动
npm run pm2:start

# 重启
npm run pm2:restart

# 停止
npm run pm2:stop

# 查看状态
npm run pm2:status

# 查看日志
npm run pm2:logs
```

## 特性

- ✅ **自动安装 PM2**：如果未安装会自动安装
- ✅ **自动重启**：服务异常退出会自动重启
- ✅ **日志管理**：日志文件保存在 `logs/` 目录
- ✅ **内存限制**：内存超过 150M 自动重启
- ✅ **保持端口**：使用 `config.json` 中的配置（端口 8045）
- ✅ **开机自启**：可选择是否开机自动启动

## PM2 常用命令

### 查看服务状态
```bash
pm2 status
```

### 查看实时日志
```bash
pm2 logs kiro2api
```

### 查看所有日志（最近 200 行）
```bash
pm2 logs kiro2api --lines 200
```

### 清空日志
```bash
pm2 flush
```

### 重启服务
```bash
pm2 restart kiro2api
```

### 停止服务
```bash
pm2 stop kiro2api
```

### 删除服务
```bash
pm2 delete kiro2api
```

### 监控面板
```bash
pm2 monit
```

### 查看详细信息
```bash
pm2 show kiro2api
```

## 配置说明

配置文件位置：`ecosystem.config.cjs`

主要配置项：
- **实例数量**：1 个（可根据需要调整）
- **Node.js 内存限制**：120MB
- **最大内存重启**：150MB
- **自动重启**：已启用
- **错误重启次数**：最多 10 次
- **最小运行时间**：10 秒
- **重启延迟**：4 秒

## 日志文件

日志保存在 `logs/` 目录下：
- `pm2-out.log` - 正常输出日志
- `pm2-error.log` - 错误日志

## 开机自启动

### 启用开机自启动

**Linux/Mac:**
```bash
pm2 startup
# 复制输出的命令并执行（需要 sudo）
pm2 save
```

**Windows:**
```bash
pm2 startup
pm2 save
```

### 禁用开机自启动

```bash
pm2 unstartup
```

## 服务器部署步骤

1. **上传项目文件到服务器**
   ```bash
   scp -r AIClient-2-API-main user@server:/path/to/deploy/
   ```

2. **安装依赖**
   ```bash
   cd /path/to/deploy/AIClient-2-API-main
   npm install
   ```

3. **配置 config.json**
   - 修改 `HOST` 为 `0.0.0.0`（对外开放）或 `127.0.0.1`（本地访问）
   - 设置其他必要配置（API Key、OAuth 凭证等）

4. **启动服务**
   ```bash
   # Linux/Mac
   chmod +x start-pm2.sh
   ./start-pm2.sh

   # Windows Server
   start-pm2.bat
   ```

5. **配置防火墙**（如需外网访问）
   ```bash
   # 开放端口 8045
   sudo ufw allow 8045
   ```

6. **配置 Nginx 反向代理**（推荐）
   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       location / {
           proxy_pass http://127.0.0.1:8045;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       }
   }
   ```

## 故障排查

### 服务无法启动

1. 检查 Node.js 是否安装
   ```bash
   node -v
   ```

2. 检查端口是否被占用
   ```bash
   # Linux/Mac
   lsof -i:8045

   # Windows
   netstat -ano | findstr :8045
   ```

3. 查看错误日志
   ```bash
   pm2 logs kiro2api --err
   ```

### 服务频繁重启

1. 查看日志找出错误原因
   ```bash
   pm2 logs kiro2api
   ```

2. 检查内存使用
   ```bash
   pm2 monit
   ```

3. 调整内存限制（修改 `ecosystem.config.cjs`）

### 日志文件过大

定期清理日志：
```bash
pm2 flush
```

或使用日志轮转工具：
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## 性能优化建议

1. **启用日志轮转**
   ```bash
   pm2 install pm2-logrotate
   ```

2. **监控服务**
   ```bash
   pm2 install pm2-server-monit
   ```

3. **使用集群模式**（如需）
   修改 `ecosystem.config.cjs`：
   ```javascript
   instances: 2,  // 或使用 'max' 自动根据 CPU 核心数
   exec_mode: 'cluster'
   ```

4. **定期检查服务状态**
   添加 crontab 任务：
   ```bash
   */5 * * * * pm2 status
   ```

## 更新服务

```bash
# 1. 拉取最新代码
git pull

# 2. 安装依赖
npm install

# 3. 重启服务
pm2 restart kiro2api

# 4. 保存配置
pm2 save
```

## 卸载

1. 停止并删除服务
   ```bash
   pm2 stop kiro2api
   pm2 delete kiro2api
   pm2 save
   ```

2. 取消开机自启动
   ```bash
   pm2 unstartup
   ```

3. 卸载 PM2（可选）
   ```bash
   npm uninstall -g pm2
   ```

## 技术支持

遇到问题请查看：
- PM2 官方文档：https://pm2.keymetrics.io/
- 项目 Issues：https://github.com/your-repo/issues

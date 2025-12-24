module.exports = {
  apps: [{
    name: 'kiro2api',
    script: 'src/api-server.js',

    // Node.js 参数
    node_args: '--max-old-space-size=120',

    // 运行模式
    instances: 1,
    exec_mode: 'fork',

    // 自动重启配置
    autorestart: true,
    watch: false,
    max_memory_restart: '150M',

    // 错误重启配置
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 4000,

    // 环境变量（可选，如果需要覆盖 config.json）
    env: {
      NODE_ENV: 'production',
    },

    // 日志配置
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // 其他配置
    kill_timeout: 5000,
    listen_timeout: 10000,
    shutdown_with_message: false,
  }]
};

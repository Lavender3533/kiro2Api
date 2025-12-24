module.exports = {
  apps: [{
    name: 'kiro2api',
    script: 'src/api-server.js',

    // 运行模式
    instances: 1,
    exec_mode: 'fork',

    // 自动重启配置
    autorestart: true,
    watch: false,

    // 环境变量
    env: {
      NODE_ENV: 'production',
    },

    // 日志配置
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
  }]
};

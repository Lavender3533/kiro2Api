/** @type {import('next').NextConfig} */
const nextConfig = {
  // 开发环境下代理 API 请求到后端 8045 端口
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:8045/api/:path*',
      },
    ];
  },
  // 导出静态文件
  output: 'export',
  // 图片优化
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;

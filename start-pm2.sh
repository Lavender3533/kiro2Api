#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   Kiro2API PM2 一键部署脚本${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查 PM2 是否安装
if ! command -v pm2 &> /dev/null; then
    echo -e "${RED}[错误] PM2 未安装${NC}"
    echo -e "${YELLOW}正在安装 PM2...${NC}"
    npm install -g pm2
    if [ $? -ne 0 ]; then
        echo -e "${RED}[错误] PM2 安装失败，请手动执行: npm install -g pm2${NC}"
        exit 1
    fi
    echo -e "${GREEN}[成功] PM2 安装完成${NC}"
fi

# 创建日志目录
if [ ! -d "logs" ]; then
    echo -e "${YELLOW}[信息] 创建日志目录...${NC}"
    mkdir -p logs
fi

# 检查是否已经在运行
if pm2 list | grep -q "kiro2api"; then
    echo -e "${YELLOW}[信息] 检测到 kiro2api 已在运行，正在重启...${NC}"
    pm2 restart kiro2api
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[成功] 服务重启成功${NC}"
    else
        echo -e "${RED}[错误] 服务重启失败${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}[信息] 启动 kiro2api 服务...${NC}"
    pm2 start ecosystem.config.cjs
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[成功] 服务启动成功${NC}"
    else
        echo -e "${RED}[错误] 服务启动失败${NC}"
        exit 1
    fi
fi

# 保存 PM2 进程列表（开机自启动需要）
echo -e "${YELLOW}[信息] 保存 PM2 进程列表...${NC}"
pm2 save

# 设置开机自启动（可选）
read -p "是否设置开机自启动? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}[信息] 配置开机自启动...${NC}"
    pm2 startup
    echo -e "${GREEN}[提示] 请复制上面的命令并执行（需要 sudo）${NC}"
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}[完成] 部署完成！${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "${YELLOW}常用命令:${NC}"
echo -e "  查看状态: ${GREEN}pm2 status${NC}"
echo -e "  查看日志: ${GREEN}pm2 logs kiro2api${NC}"
echo -e "  停止服务: ${GREEN}pm2 stop kiro2api${NC}"
echo -e "  重启服务: ${GREEN}pm2 restart kiro2api${NC}"
echo -e "  删除服务: ${GREEN}pm2 delete kiro2api${NC}"
echo -e "  监控面板: ${GREEN}pm2 monit${NC}"
echo ""

# 显示当前状态
pm2 status

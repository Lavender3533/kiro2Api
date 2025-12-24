#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   Kiro2API PM2 重启脚本${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查是否在运行
if pm2 list | grep -q "kiro2api"; then
    echo -e "${YELLOW}[信息] 正在重启 kiro2api 服务...${NC}"
    pm2 restart kiro2api
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[成功] 服务重启成功${NC}"
    else
        echo -e "${RED}[错误] 服务重启失败${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}[信息] kiro2api 服务未在运行，正在启动...${NC}"
    pm2 start ecosystem.config.cjs
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[成功] 服务启动成功${NC}"
    else
        echo -e "${RED}[错误] 服务启动失败${NC}"
        exit 1
    fi
fi

pm2 save
echo ""
pm2 status

#!/bin/bash

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   Kiro2API PM2 停止脚本${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# 检查是否在运行
if pm2 list | grep -q "kiro2api"; then
    echo -e "${YELLOW}[信息] 正在停止 kiro2api 服务...${NC}"
    pm2 stop kiro2api
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}[成功] 服务已停止${NC}"
    else
        echo -e "${RED}[错误] 服务停止失败${NC}"
        exit 1
    fi

    # 询问是否删除
    read -p "是否同时删除服务? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        pm2 delete kiro2api
        echo -e "${GREEN}[成功] 服务已删除${NC}"
        pm2 save
    fi
else
    echo -e "${YELLOW}[信息] kiro2api 服务未在运行${NC}"
fi

echo ""
pm2 status

@echo off
chcp 65001 >nul
cd /d %~dp0
echo Starting Kiro2API...
node --max-old-space-size=120 src/api-server.js --api-key 123456 --host 127.0.0.1 --port 8045 --model-provider claude-kiro-oauth
pause

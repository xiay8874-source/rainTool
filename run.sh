#!/usr/bin/env bash
# RainTool 启动脚本
# 用法: ./run.sh
set -e
cd "$(dirname "$0")"

echo "🔨 构建前端..."
npm run build 2>&1 | tail -2

echo "🔨 构建 Electron 主进程..."
npm run build:electron 2>&1 | tail -1

echo "🚀 启动 RainTool..."
npx electron .

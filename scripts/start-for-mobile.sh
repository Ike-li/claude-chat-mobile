#!/bin/bash
# 真机验证启动脚本
# 用法: ./scripts/start-for-mobile.sh

set -e

echo "🚀 Claude Chat Mobile - 真机验证启动"
echo "======================================="
echo ""

# 检查环境
if ! command -v claude &> /dev/null; then
    echo "❌ 未找到 claude 命令"
    echo "   请先安装: https://claude.ai/download"
    exit 1
fi

# 读取或生成 token
if [ -z "$AUTH_TOKEN" ]; then
    echo "⚠️  AUTH_TOKEN 未设置，生成随机 token..."
    AUTH_TOKEN=$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | xxd -p)
    echo "   生成的 token: $AUTH_TOKEN"
    echo ""
fi

# 显示配置
echo "📋 配置信息:"
echo "   端口: ${PORT:-3000}"
echo "   工作目录: ${WORK_DIR:-$HOME}"
echo "   模型: ${ANTHROPIC_MODEL:-默认}"
echo "   鉴权 token: ${AUTH_TOKEN:0:8}..."
echo ""

# 检查端口占用
PORT_CHECK=${PORT:-3000}
if lsof -Pi :$PORT_CHECK -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "❌ 端口 $PORT_CHECK 已被占用"
    echo "   请设置 PORT 环境变量或关闭占用进程"
    exit 1
fi

# 启动服务
echo "🎬 启动服务..."
export AUTH_TOKEN
node server.js &
SERVER_PID=$!

# 等待启动
sleep 2

# 检查服务是否正常
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "❌ 服务启动失败"
    exit 1
fi

# 获取本机 IP
LOCAL_IP=$(ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1)

echo ""
echo "✅ 服务已启动 (PID: $SERVER_PID)"
echo ""
echo "📱 手机访问方式:"
echo "======================================="
echo ""
echo "1️⃣  局域网直连（同 WiFi）:"
echo "   http://$LOCAL_IP:${PORT:-3000}#token=$AUTH_TOKEN"
echo ""
echo "2️⃣  隧道方式（推荐，外网可访问）:"
echo "   # 新开终端运行:"
echo "   cloudflared tunnel --url http://localhost:${PORT:-3000}"
echo "   # 或使用 ngrok:"
echo "   ngrok http ${PORT:-3000}"
echo "   # 获得 URL 后手动拼接: https://<tunnel-url>#token=$AUTH_TOKEN"
echo ""
echo "======================================="
echo ""
echo "💡 验收清单 (A1-A10 + E7/E8/E13):"
echo "   □ 发消息流式显示 (E4)"
echo "   □ 工具卡片可见 (E5)"
echo "   □ 点停止按钮中断 (E6)"
echo "   □ 触发审批弹窗允许/拒绝 (E3)"
echo "   □ 点会话按钮看列表 (E13)"
echo "   □ 切换会话上下文接续 (E1)"
echo "   □ 选模型下拉发消息 (E8)"
echo "   □ 锁屏 2 分钟解锁续传 (E10)"
echo ""
echo "🛑 停止服务: kill $SERVER_PID"
echo ""

# 保持脚本运行
trap "echo ''; echo '🛑 停止服务...'; kill $SERVER_PID 2>/dev/null; exit" INT TERM

wait $SERVER_PID

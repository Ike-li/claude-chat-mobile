#!/bin/bash
# playground app entrypoint: seed HOME workspace, print banner, then watch-reload server.
# Invoked as `bash /app/tests/infra/playground/entrypoint-app.sh` so the file need not be +x.
set -euo pipefail

mkdir -p /home/ccm-test/workspace /home/ccm-test/ccm-data /home/ccm-test/.claude/projects
if [ ! -f /home/ccm-test/workspace/README.md ]; then
  cp -a /app/tests/infra/playground/seed/workspace/. /home/ccm-test/workspace/
fi
# 仓库根不 bind-mount，这两份写在容器可写层，碰不到宿主机 ccm.config.json / .env。
cp /app/tests/infra/playground/seed/app-config.json /app/ccm.config.json
chmod 0600 /app/ccm.config.json
rm -f /app/.env

cat <<'EOF'
========================================
  CCM playground  （测试基础设施，不是产品入口）
  打开:   http://127.0.0.1:13000/#token=playground-local-not-a-secret
  Token:  playground-local-not-a-secret
  工作区: /home/ccm-test/workspace   （不是宿主机仓库）
  CLAUDE_BIN: /app/tests/fixtures/fake-claude.sh
  ⚠ 这是 fake-claude：发消息不会完成 agent turn。
     误点发送后会话会一直 busy（默认 idle 600s），用 playground:restart。
     聊天/流式 UI → npm run playground:up:mock → http://127.0.0.1:13100/
  批准设备: npm run playground:device -- list|approve <ID>
  设置面板改配置会写失败（overlay 只读）；改 playground/runtime.env 后 recreate。
  重置数据: npm run playground:reset
  不要打真实隧道。公网 Host 模拟: npm run playground:up:proxy
  不要打开不带 #token= 的 URL（会触发鉴权限速短锁）。
========================================
EOF

cd /app
exec node --watch server.js

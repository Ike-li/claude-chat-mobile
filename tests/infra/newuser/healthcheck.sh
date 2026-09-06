#!/bin/bash
# 容器健康检查：token 由 setup 生成、事先不知道，所以从写好的配置里读再打 /health。
cfg=/home/node/claude-chat-mobile/ccm.config.json
[ -f "$cfg" ] || exit 1
exec node -e "
  const t = require(process.argv[1]).AUTH_TOKEN;
  fetch('http://127.0.0.1:3000/health?token=' + encodeURIComponent(t))
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch(() => process.exit(1));
" "$cfg"

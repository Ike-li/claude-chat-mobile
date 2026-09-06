#!/bin/bash
# 新用户装机路径（与 docs/getting-started.md 同序）：解包 → npm install --omit=dev → setup → 按方案配置 → start。
# 用法：entrypoint.sh <lan|direct|reverse-proxy|cloudflare> <宿主机端口>
# HOME 是 named volume：重启容器时跳过已完成的步骤，行为像用户第二次开机。
set -euo pipefail

PROFILE="${1:?profile}"
HOST_PORT="${2:?host port}"
PROJ="$HOME/claude-chat-mobile"
HOST_IP="${NEWUSER_HOST_IP:?NEWUSER_HOST_IP}"

step() { printf '\n==> [%s] %s\n' "$PROFILE" "$*"; }

if [ ! -d "$PROJ" ]; then
  step "解包分发 tarball（等价于 curl … | tar xz）"
  tar xzf /dist/claude-chat-mobile.tar.gz -C "$HOME"
  mv "$HOME"/claude-chat-mobile-*/ "$PROJ"
fi
cd "$PROJ"

if [ ! -d node_modules ]; then
  step "npm install --omit=dev"
  npm install --omit=dev --no-audit --no-fund
fi

step "claude CLI 凭据（宿主机 .claude/settings.docker.json 的容器副本）"
mkdir -p "$HOME/.claude"
cp /run/newuser/settings.json "$HOME/.claude/settings.json"
chmod 600 "$HOME/.claude/settings.json"
claude --version

mkdir -p "$HOME/workspace"
if [ ! -f "$HOME/workspace/README.md" ]; then
  printf '# workspace\n\n新用户的第一个工作区。\n' > "$HOME/workspace/README.md"
  git -C "$HOME/workspace" init -q 2>/dev/null || true
fi

if [ ! -f ccm.config.json ]; then
  step "node scripts/setup.js --yes（非交互装机向导）"
  node scripts/setup.js --yes --work-dir="$HOME/workspace" --hooks=off --desktop=off --access-profile="$PROFILE"

  step "按方案补配置（node scripts/config.js set）"
  case "$PROFILE" in
    lan)
      node scripts/config.js set BIND_MODE=lan ;;
    direct)
      node scripts/config.js set BIND_MODE=lan "PUBLIC_URL=http://$HOST_IP:$HOST_PORT" ;;
    reverse-proxy)
      node scripts/config.js set BIND_MODE=loopback TRUSTED_PROXY=loopback "PUBLIC_URL=http://$HOST_IP:$HOST_PORT" ;;
    cloudflare)
      # shellcheck disable=SC1091
      . /run/newuser/cf.env
      node scripts/config.js set BIND_MODE=loopback \
        "CF_ACCESS_HOSTNAME=$CF_ACCESS_HOSTNAME" "CF_ACCESS_TEAM=$CF_ACCESS_TEAM" "CF_ACCESS_AUD=$CF_ACCESS_AUD"
      # 假边缘的 JWKS 预置成本地缓存：cf-access.js 启动时同步读它，后台拉取 https://<team>/cdn-cgi/access/certs 失败不影响。
      data_dir="$(node -e "const c=require('./ccm.config.json');console.log(c.CCM_DATA_DIR||'')")"
      [ -n "$data_dir" ] || data_dir="$PROJ/data"
      mkdir -p "$data_dir"
      cp /run/newuser/jwks.json "$data_dir/cf-access-certs.json" ;;
    *) echo "未知 profile: $PROFILE" >&2; exit 2 ;;
  esac
fi

step "node scripts/doctor.js"
node scripts/doctor.js || true

step "npm start"
exec npm start

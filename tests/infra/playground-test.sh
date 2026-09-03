#!/bin/sh
# 容器内 playground 验收：down -v 清 TOFU 表，起 app+mock+proxy，再 run probe / browser。
# 由 `npm run test:docker:playground` 调用。不要在宿主机原生跑 Playwright。
set -e
# 切到本脚本所在目录（tests/infra/），两份 compose 就在同级——不依赖调用方的 cwd。
# compose 内部的 ../../ 是相对 compose 文件解析的，与这里的 cd 无关。
cd "$(dirname "$0")"
# run 不会继承 up 时的 --profile。若不把 proxy 留在项目里，run probe 会重建 app、拆掉
# nginx 的 netns，T-proxy 的 :8080 就变成 websocket error。
export COMPOSE_PROFILES=mock,proxy
COMPOSE="docker compose -f docker-compose.playground.yml -f docker-compose.playground.test.yml"
$COMPOSE down -v --remove-orphans
$COMPOSE up --build -d --wait
# --no-deps 是必需的，不是优化：`compose run` 会去「确保」depends_on 的服务符合当前配置，
# 实测它会把已经健康的 app **Recreate** 掉；而 proxy 用 network_mode: service:app 寄生在
# app 的 netns 上，app 一换容器，nginx 那侧的 :8080 就永久失联，T-proxy 用例报 websocket error。
# 上面的 COMPOSE_PROFILES 只保证 proxy 留在项目里（不被判成孤儿删掉），拦不住这次 recreate——
# 两道都要有。依赖已由上一行 up --wait 起好并等到 healthy，这里无需 compose 再确保一次。
$COMPOSE run --rm --no-deps probe
$COMPOSE run --rm --no-deps browser

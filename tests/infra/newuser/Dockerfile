# tests/infra/newuser/Dockerfile —— 「新用户的内网电脑」（测试基础设施，不是产品入口）
#
# 与 Dockerfile.test 的区别：那边是维护者跑测试的镜像（预装仓库依赖、fake-claude）；
# 这边什么都不预装，只有 Node 与真 claude CLI，让容器里的装机步骤与 docs/getting-started.md
# 逐条一致：tar xz → npm install --omit=dev → setup → start。
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

COPY entrypoint.sh healthcheck.sh /newuser/

# claude CLI 拒绝以 root 运行；node 镜像自带 uid 1000 的 node 用户，正好当「用户」。
USER node
ENV HOME=/home/node
WORKDIR /home/node

# 配置参考（环境变量）

> 本文是环境变量的**唯一权威参考**。可运行模板见 [`.env.example`](../.env.example)（两者同步，改一处即核对另一处）。`server.js` 顶部加载 `.env`。

## 加载规则（三条，勿绕过）

1. **dotenv 不覆盖 shell 已有变量**——shell 里 export 的优先。
2. **空串值 = 未设置**：`.env` 顶部加载后剥除所有空串环境变量，让解构默认值生效（空 `WORK_DIR=` 回退 `$HOME`，空 `IDLE_TIMEOUT_MS=` 回退默认而非 0）。
3. **`.env` 注入的 `ANTHROPIC_*` 一律在启动期剥除**（shell 已有的保留）——保证 web 端 claude 与终端 claude 环境一致（终端等价性）。**Anthropic 凭据/网关/模型只能来自启动 shell，不经 `.env` 配置**（见 [ADR-0004](decisions.md#adr-0004) / [ADR-0005](decisions.md#adr-0005)）。**用第三方 provider / 自定义网关同理**：在启动 shell `export ANTHROPIC_BASE_URL`（及 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` 等）后再启动 server，web 端自动沿用、与终端完全一致——这正是接第三方 provider 的方式。

## 变量清单

### 鉴权

| 变量 | 默认 | 说明 |
|---|---|---|
| `AUTH_TOKEN` | 空（= 只监听 `127.0.0.1`） | 对外服务必填。建议 `openssl rand -hex 32`。手机首次访问用 `https://<域名>/#token=<值>`，token 随即存 localStorage 并从地址栏清除。详见 [design.md §4 安全模型](design.md#4-安全模型) |

### Cloudflare Access 双因素（[ADR-0017](decisions.md#adr-0017)，可选）

| 变量 | 说明 |
|---|---|
| `CF_ACCESS_HOSTNAME` | 公网固定域名。**三项齐全才启用**「公网 Host 强制验 Access JWT、fail-closed、不回退 token」；任一缺失则整层关闭、回退 `AUTH_TOKEN`。启用后公网走 Access、不再需 `#token=` |
| `CF_ACCESS_TEAM` | CF Zero Trust team 名（用于拉 JWKS） |
| `CF_ACCESS_AUD` | Access 应用的 AUD tag（防重放） |

### 运行

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `WORK_DIR` | `$HOME` | claude 的工作目录（E9）。**公网常驻建议固定到具体项目，勿用 `$HOME`**（[design.md §4 安全模型](design.md#4-安全模型)） |
| `WORK_DIRS_FILE` | 空 | 多 repo（[ADR-0010](decisions.md#adr-0010)）：JSON 数组文件路径，每元素一个目录。优先于 `WORK_DIRS` |
| `WORK_DIRS` | 空 | web 内可切的 cwd 白名单（逗号分隔，`WORK_DIR` 自动并入首位）。只设 `WORK_DIR` 则退化单目录、目录切换器隐藏 |
| `CLAUDE_BIN` | `which claude` | 本机 claude 可执行文件路径（[ADR-0004](decisions.md#adr-0004)：必须用本机的，不用 SDK 捆绑副本） |
| `IDLE_TIMEOUT_MS` | `600000`（10 分钟） | agent 静默超时（等待审批不计时）。超时判挂死并中断、可 resume |

### 权限（[ADR-0003](decisions.md#adr-0003)）

无环境变量。**投屏层零注入白名单**（代码里无 `allowedTools` / `disallowedTools`）：工具放行集 = 全局 `~/.claude/settings.json` + 项目 `.claude/settings.json` + 本地 `.claude/settings.local.json` 三处 `permissions.allow` 的合并结果（经 `settingSources: ['user','project','local']` 加载，与终端 claude 同源、用户自管）。命中即自动放行、未命中推手机审批弹窗。优先级合并由 claude CLI 自身处理，本项目不插手。**高风险/公网应收紧 `permissions`——尤其全局 `~/.claude/settings.json`**（见 [design.md §4 安全模型](design.md#4-安全模型)）。

### Web Push（[ADR-0009](decisions.md#adr-0009)）

| 变量 | 说明 |
|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | **三项齐全才启用推送**，任一缺失则推送优雅缺席。生成：`node -e "import('web-push').then(m=>console.log(JSON.stringify(m.default.generateVAPIDKeys(),null,2)))"`。`VAPID_SUBJECT` 填 `mailto:` 或 `https://` 域名。**私钥勿提交 git** |

### statusLine 状态栏（[ADR-0011](decisions.md#adr-0011)）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEB_STATUSLINE` | 启用 | 设为 `off` 禁用 web 状态栏（零 UI 痕迹）。statusLine 为 app 自有 UI、server 端自包含组装（SDK 数据 + git），**无需任何脚本/快照/`settings.json` 配置，开箱即用** |

### 调试

| 变量 | 说明 |
|---|---|
| `LOG_STDERR` | `1` 输出 claude 子进程 stderr |
| `LOG_INTERACTIONS` | `1` 记录四跳内容摘要（脱敏 + 截断 1500 字符，默认关，[ADR-0014](decisions.md#adr-0014)） |

> **不在此列：`ANTHROPIC_*`**（模型/网关/凭据）——在终端 shell 里 `export` 后再启动 server（见上方加载规则 3）。

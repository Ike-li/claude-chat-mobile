# 首次使用指南

> 目标：从一个已经能运行 `claude` 的电脑开始，把 Claude Chat Mobile 启动起来，并从手机发出第一条消息。

[English](getting-started.en.md) · [返回 README](../README.md)

## 完成后你会得到什么

- 一个只在你电脑上运行的 Claude Chat Mobile server。
- 一个受 `AUTH_TOKEN`、工作区白名单和设备审批保护的手机入口。
- 与本机 `claude` CLI 共用配置、工具和落盘会话记录的 Web 界面。

本指南覆盖首次安装。已经用 LaunchAgent/systemd 常驻部署的实例不要再手动运行 `npm start`，请按[部署指南](deployment.md)重启服务。

## 1. 检查前置条件

```bash
node --version
which claude
claude --version
```

需要满足：

- Node.js ≥ 20。
- `which claude` 能找到本机 CLI。
- `claude` 已登录，能在终端正常开始一次对话。
- macOS 或 Linux。原生 Windows 属实验路径，推荐 WSL2。

项目不自带 Claude，也不会替你安装或登录 CLI。

### 官方订阅与第三方网关

- 官方订阅：确保启动 server 的本机账号已经登录 `claude`，无需再配 API key。
- 第三方网关：先在**将要启动 server 的 shell** 中导出网关要求的 `ANTHROPIC_*`，再启动项目。
- 不要把 `ANTHROPIC_*` 写进项目 `.env`：启动时会主动剥除这些值，避免项目文件覆盖 CLI/provider 环境。

## 2. 获取代码与安装依赖

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile
npm install --omit=dev
```

`--omit=dev` 只安装运行依赖，不下载 Playwright 浏览器。需要参与开发或运行测试时再使用完整的 `npm install`。

## 3. 生成本地配置

### 交互式向导

在真实终端里运行：

```bash
npm run setup
```

向导会：

1. 生成随机 `AUTH_TOKEN` 并写入 `.env`，文件权限设为 `0600`。
2. 询问 `WORK_DIR`。请选择明确的项目目录，不要把整个家目录作为方便的默认范围。
3. 询问是否安装 CLI hooks bridge。默认安装，但只有你确认后才会写 `~/.claude/settings.json`。

如果 `.env` 已存在，向导默认不覆盖。

### 非交互模式

编程 agent、CI shell 或其他没有 TTY 的环境必须显式使用：

```bash
node scripts/setup.js \
  --yes \
  --work-dir=/绝对路径/到/项目 \
  --hooks=off
```

- `--work-dir` 必填，不会静默回落到 `$HOME`。
- `--hooks` 只接受 `on` 或 `off`；`on` 会修改用户级 Claude hooks 配置。
- 已有 `.env` 时命令会拒绝覆盖。只有确认要替换现有 token 与配置时才加 `--force`。
- 可用 `--env <path>` 指定其他环境文件。

多工作区推荐在 `.env` 设置 `WORK_DIRS_FILE=workdirs.json`，文件内容为绝对路径数组：

```json
[
  "/Users/you/code/project-a",
  {
    "path": "/Users/you/code/project-b",
    "sessionLimit": 10
  }
]
```

`workdirs.json` 支持热加载。git worktree 也必须作为独立绝对路径显式加入；项目不会自动发现或放行。

## 4. 运行启动自检

```bash
node scripts/doctor.js
```

它会检查 token、CLI 路径、工作区、端口、网关环境、文件权限、bridge 状态和文档/前端一致性。

权限类问题可让 doctor 做最小修复：

```bash
node scripts/doctor.js --fix
```

`--fix` 会收紧 `.env` 与控制面 JSON 文件权限；先阅读输出，再决定是否运行。

## 5. 启动 server

首次本地试用：

```bash
npm start
```

默认监听 `3000` 端口。启动日志应显示：

- server 已监听；
- 脱敏后的 token 状态；
- 可在手机打开的局域网 URL；
- bridge 与待审批设备状态。

设有 `AUTH_TOKEN` 时，健康检查也需要鉴权：

```bash
curl -sS "http://127.0.0.1:3000/health?token=<AUTH_TOKEN>"
```

返回包含 `status`、`versions`、`buildNonce` 与 `timestamp` 的 JSON 才算 server 已正常响应。`AUTH_TOKEN` 等同本机 shell 入口密钥，不要把真实值贴到 issue、聊天记录或截图中。

如果这台机器已经有 LaunchAgent/systemd 常驻实例，3000 端口通常已被占用。不要启动第二个 server；按[部署指南的运维速查](deployment.md#运维速查)重启现有服务。

## 6. 从手机打开

### 同一 WiFi

直接打开启动日志给出的地址：

```text
http://<lan-ip>:3000/#token=<AUTH_TOKEN>
```

首次加载后 token 会存入浏览器 `localStorage`，并从地址栏清除。

### 临时 HTTPS

PWA 或 Web Push 需要 HTTPS。临时试用可在另一个终端运行：

```bash
cloudflared tunnel --url http://localhost:3000
```

然后打开：

```text
https://<random>.trycloudflare.com/#token=<AUTH_TOKEN>
```

随机隧道适合测试，域名每次启动都可能变化，也没有 Cloudflare Access；设备审批仍然生效。固定域名、Access 2FA 与常驻服务见[部署指南](deployment.md)。

## 7. 批准手机设备

手机首次从非本机路径连接时会显示等待批准。回到电脑运行：

```bash
node scripts/device.js list
node scripts/device.js approve <ID>
```

先核对待审设备 ID，再批准。批准后页面会立即解锁，不需要重新输入 token。

如批准错设备或设备丢失：

```bash
node scripts/device.js deny <ID>
```

本机 loopback 和已经通过 Cloudflare Access JWT 的公网连接会跳过设备审批；普通局域网和临时随机隧道不会。

## 8. 完成首次验收

在手机上依次确认：

1. 首页显示预期工作区。
2. 新建会话并发送一个无副作用的问题，例如“只回复 OK”。
3. 能看到流式回答和回合结束状态。
4. 打开设置，确认模型、权限档、思考强度和服务状态可见。
5. 如已启用 Web Push，使用“发一条测试推送”验证通道，不要等真实审批出现才发现配置有误。

到这里，最小可用路径已经完成。下面两座 bridge 都是可选增强，不影响 Web 自己发起会话。

## 可选：CLI statusline bridge

Web 驾驶的会话开箱即用 SDK 状态栏。只有当你还想在 Web **只读查看终端正在运行的会话**时同步 CLI 的模型、思考强度、上下文、成本和额度，才需要 statusline bridge。

```bash
npm run statusline:status
npm run statusline:install
```

- `status` 只读，不改 `~/.claude`。
- `install` 是显式 opt-in，会包装已有的 Claude CLI statusline 命令；未配置 statusline 时安装器会拒绝。
- 安装后重开终端里的 Claude CLI，并重启常驻 server。
- 卸载用 `npm run statusline:uninstall`，安装器会按 manifest 恢复原命令并拒绝覆盖发生漂移的配置。

## 可选：CLI hooks bridge

未安装 hooks 时，server 仍会每 2.5 秒轮询 transcript；但终端回合的 Stop / Notification 不会主动叫醒手机。安装 bridge 后，CLI 会把这两类事件写入受限文件投递箱，server 立即消费并按通知设置处理。

```bash
npm run hooks:status
npm run hooks:install
npm run hooks:verify
npm run hooks:uninstall
```

- `status` 只读。
- `install` 只追加自己的 hook 条目，保留已有 hooks，并自动做回环验证。
- 安装后必须新开终端里的 Claude CLI 会话，旧进程不会重新加载 hooks。
- server 不在线时 hook 只落盘并静默退出，不阻断 CLI。
- `.env` 设 `CLI_HOOKS_BRIDGE=off` 可让 server 暂停消费，不必卸载全局配置。

手机端也可在“设置 → 服务状态 → 终端会话推送”中显式安装或卸载。

<details>
<summary>把首次安装交给编程 agent</summary>

在仓库目录中把下面内容交给 Claude Code、Codex CLI 或其他本机编程 agent：

```text
帮我首次安装并启动 claude-chat-mobile（把本机 claude CLI 接到手机 Web UI）。
这是全新环境首次安装，不是重启已部署的常驻服务。

按顺序做，每步确认结果再进入下一步：
1. 检查 node --version ≥ 20，which claude 能找到命令，并确认 claude 已登录。
   任一不满足就停下来告诉我，不要自行安装或登录 claude。
2. 运行 npm install --omit=dev。
3. 先跟我确认 WORK_DIR 的绝对路径，以及是否安装 CLI hooks bridge。
   不要把整个家目录当 WORK_DIR；hooks=on 会修改 ~/.claude/settings.json。
4. 你的 shell 没有 TTY，不要运行交互向导。使用：
   node scripts/setup.js --yes --work-dir=<确认后的绝对路径> --hooks=<on 或 off>
   如果 .env 已存在就停下来，不要自行加 --force。
5. 运行 node scripts/doctor.js；只在输出明确要求且安全时使用 --fix。
6. 确认没有常驻服务占用端口后，在后台启动 server。用鉴权后的 /health JSON 验证，
   不要只看进程是否存在。
7. 告诉我启动日志中的局域网手机地址，但不要把 AUTH_TOKEN 写进任何会外传的文件或报告。
8. 等我的手机发起连接后，运行 node scripts/device.js list；让我核对设备，再执行 approve。
固定公网域名和常驻部署按 docs/deployment.md 处理，不要擅自改系统服务。
```

</details>

## 常见问题

| 现象 | 检查 |
|---|---|
| 启动日志没有手机地址 | `AUTH_TOKEN` 未设置；重新运行 setup 或修正 `.env` 后重启 |
| agent 运行 setup 后什么都没写 | 非 TTY 环境用了交互模式；改用 `--yes --work-dir=... --hooks=...` |
| `EADDRINUSE :3000` | 已有常驻服务或其他进程占用端口；不要盲目再启动 |
| 手机一直等待审批 | 运行 `device.js list`，核对并批准正确 ID |
| 第三方网关配置不生效 | `ANTHROPIC_*` 必须来自启动 server 的 shell，不是 `.env` |
| CLI 会话状态或通知缺失 | 分别检查 statusline bridge 与 hooks bridge；两者用途不同 |
| Android 安装后只是浏览器快捷方式 | Cloudflare Access 可能拦住 PWA 图标，见[部署指南](deployment.md#2b-android-pwa图标必须对匿名可达) |

## 下一步

- 长期公网使用：[部署与运维](deployment.md)
- 理解 Web/CLI 双通道：[架构说明](architecture.md)
- 理解模型、effort、statusline 展示来源：[展示契约](display-contracts.md)
- 查看所有环境变量：[`.env.example`](../.env.example)

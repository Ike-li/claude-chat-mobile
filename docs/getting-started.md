# 首次使用指南

> 目标：从一个已经能运行 `claude` 的电脑开始，把 Claude Chat Mobile 启动起来，并从手机发出第一条消息。

[English](getting-started.en.md) · [返回 README](../README.md)

## 完成后你会得到什么

- 一个只在你电脑上运行的 Claude Chat Mobile server。
- 一个受 `AUTH_TOKEN`、工作区白名单和设备审批保护的手机入口。
- 与本机 `claude` CLI 共用配置、工具和落盘会话记录的 Web 界面。

本指南覆盖首次安装。已经在跑桌面端或终端里的 `npm start` 时，不要再开第二个 server；桌面端用菜单里 server 一行的「重启」，headless 在原终端重启。

## 1. 检查前置条件

```bash
node --version
which claude
claude --version
claude auth status
```

需要满足：

- Node.js ≥ 20。
- `which claude` 能找到本机 CLI。
- `claude auth status` 显示已登录；或能在终端正常开始一次对话。
- macOS 或 Linux。原生 Windows 属实验路径，推荐 WSL2。

项目不自带 Claude，也不会替你安装或登录 CLI。

### 官方订阅与第三方网关

- 官方订阅：确保启动 server 的本机账号已经登录 `claude`，无需再配 API key。
- 第三方网关：网关配置属于 `claude` CLI 自己，不属于本项目。本项目拉起的每个会话都按工作区目录加载 CLI 的 user / project / local 三层 settings，所以**终端里怎么配，手机上就怎么生效**。两条正规通道：
  - **CLI settings 文件的 `env` 块（推荐）**：写在工作区的 `.claude/settings.local.json`（只对这一个工作区、不进 git），或 `~/.claude/settings.json`（所有目录的基底）。例如：

    ```json
    {
      "env": {
        "ANTHROPIC_BASE_URL": "https://gw.example.com",
        "ANTHROPIC_AUTH_TOKEN": "……",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "<网关认的模型名>",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "<网关认的模型名>"
      }
    }
    ```

    它由 CLI 按工作区目录从文件读取，不依赖启动 server 的进程环境，**macOS 桌面控制台拉起的常驻服务同样生效**。手建的 `settings.local.json` 要自己加进 `.gitignore`（CLI 只在自己首次写入时才会把它加进全局 git excludes）；`env` 块在目录被 CLI 信任后生效，终端里进过一次该目录即可。
  - **启动 shell 的 `export`**：先在**将要启动 server 的 shell** 里导出 `ANTHROPIC_*`，再 `npm start`。只有这条路才要求 headless 终端入口——macOS 桌面控制台拉起的常驻服务是干净的 GUI 血统环境，里面没有你终端里 export 的变量。两条路同时存在时，网关键以 settings 文件为准（本项目 2026-07-30 实测）。
- 不要把 `ANTHROPIC_*` 写进本项目的配置文件（`ccm.config.json` / `.env`）：启动时会主动剥除这些值，避免项目文件覆盖 CLI/provider 环境。剥除不是静默的——启动日志会逐个打印 `[config] 已忽略配置文件里的 ANTHROPIC_…`，`doctor` 的「网关环境一致性」一项也会提示。
- worktree 会话注意：CLI 在 worktree 里读的是**主 checkout** 根目录那份 `settings.local.json`（官方文档明写），本项目会把主 checkout 独有的网关键中和掉、不让它误伤 worktree。worktree 要走网关，在 worktree 自己的 `.claude/settings.local.json` 里配，或干脆配在 `~/.claude/settings.json`。
- `doctor` 的 MODEL_SETTINGS 一项会逐工作区读这些文件，核对 `model` 与 `ANTHROPIC_DEFAULT_*_MODEL` 档位映射是否打架。
- 顺带说明：官方的 Remote Control 遥控在网关 / API key / 关遥测配置下整条不可用（要求 claude.ai 订阅并直连官方 API）；本项目对模型通路零假设，上述配置下全功能可用——这正是它存在的主要理由之一，见 [README「为什么需要它」](../README.md#和官方-remote-control-差在哪)。

## 2. 获取代码与安装依赖

有两种取得代码的方式，选一种即可。

### 方式 A：源码归档（只想把它跑起来）

```bash
curl -fsSL https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz | tar xz
cd claude-chat-mobile-master
npm ci --omit=dev
```

归档由 GitHub 现打（`/archive/refs/heads/master.tar.gz`），约 1.5 MB。`master` 只在发版时前进，所以它就是最新发布；要钉住某个版本，换成 `/archive/refs/tags/vX.Y.Z.tar.gz`，解压目录名会是 `claude-chat-mobile-X.Y.Z`。裁剪按仓库里 `.gitattributes` 的 `export-ignore`：测试树、Docker 测试环境和维护者门禁工具都不在里面，运行 server、装机向导、启动自检、设备审批、桌面端和两个 CLI 桥则完整保留。

`package.json` 原样保留：`npm run` 仍会列出 `test` / `check` / `lint` / `mutate` 这类命令，但它们引用的测试树和门禁不在归档里，跑不了；`devDependencies` 也还在，`--omit=dev` 会跳过它们。需要 `npm test` / `npm run check` / `npm run lint` 就用方式 B。

### 方式 B：完整仓库（要改代码或跑测试）

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile
npm ci --omit=dev
```

两种方式都用 `npm ci --omit=dev`：严格按 `package-lock.json` 复现发布时的依赖树、不改写 lock，且只装运行依赖、不下载 Playwright 浏览器。要在完整仓库里跑测试，再执行一次不带该参数的 `npm ci`。

## 3. 生成本地配置

### 交互式向导

在真实终端里运行：

```bash
npm run setup
```

向导会：

1. 生成随机 `AUTH_TOKEN` 并写入 `ccm.config.json`，文件权限设为 `0600`。
2. 询问「手机端要打开哪个项目目录」。必须填绝对路径（或 `~/` 路径）；空回车和家目录本身都会被拒绝。首个之后可以继续追加更多项目目录（回车结束）——全部写进 `WORKDIRS` 数组，**第一项就是手机端默认打开的那个**。以后增删工作区直接改配置里的 `WORKDIRS` 即可，保存即热加载生效。
3. 询问「你打算怎么从手机访问」（仅局域网 / Cloudflare / 加密隧道 VPN / 反向代理与托管隧道 / 公网直连）。回车可跳过；选了会写入 `ACCESS_PROFILE`，`doctor` 与手机端安全体检按它做针对性检查，向导结尾也会打印对应方案的文档指引。
4. 询问是否启用手机端文件编辑器直写（唯一绕过 Agent 工具审批链的写入通道）。回车维持默认开；答 `n` 写入 `FILE_EDIT=off`。
5. macOS 上会问要不要编译[桌面控制台](#可选macos-桌面控制台)。默认不编译 —— 它需要
   Xcode Command Line Tools。
6. 询问是否安装 CLI hooks bridge。默认安装，但只有你确认后才会写 `~/.claude/settings.json`。

如果配置文件已存在，向导默认不覆盖。

### 配置文件

所有配置集中在项目根的 `ccm.config.json`，一份 JSON：

```json
{
  "$schemaVersion": 1,
  "AUTH_TOKEN": "……",
  "WORKDIRS": ["/Users/you/code/project-a"],
  "PORT": 3000,
  "WEB_STATUSLINE": false
}
```

开关是真正的 `true` / `false`，端口是数字，不再有 `KEY=value` 的引号与转义规则。

旧版 `.env` 仍受支持：**`ccm.config.json` 存在时优先读它，缺失则回落 `.env`**，既有部署无需改动。
（向导只生成新格式；已有 `.env` 的部署照常工作，配置项清单随时可用 `node scripts/config.js schema` 查看。）

环境变量始终优先于配置文件——`PORT=4000 npm start` 会压过文件里的值。

配置文件里**没被本项目登记的键也会照常传下去**（写进 `process.env`，claude 子进程继承它）——
`HTTPS_PROXY`、`CLAUDE_CONFIG_DIR` 这类第三方变量放在这里是有效的。启动日志会为每个未登记的键
打印一行提示，顺便帮你发现拼错的键名。

### 从旧版 `.env` 升级

**不迁移也能跑。** 拉了新代码之后，原有的 `.env` 会照常被读取，包括 `HTTPS_PROXY` 这类
未登记的键。以下两条是可选的，只是新格式更好用。

```bash
npm run config:migrate      # = node scripts/config.js migrate
```

迁移会把 `.env` 读进来、连同外置的 `workdirs.json` 一起内联进 `ccm.config.json`，
**保留原有的 `AUTH_TOKEN`**。原 `.env` 不会被删除，但从此不再被读取（新文件优先）。

> ⚠️ **不要用 `npm run setup --force` 来「升级」。** `--force` 是覆盖重装，会生成一个新的
> `AUTH_TOKEN`——所有已批准的设备都会失效，每台手机都得重新走一遍审批。
> **注意这道拒绝只在非交互模式（`--yes`）下存在**：`resolveSetupPlan` 的 `env_exists` 检查排在
> `if (!args.yes)` 早退之后，交互式 `npm run setup` 根本走不到它（`--force` 在交互模式下同样不起作用）。
> 升级请直接用 `node scripts/config.js migrate`。

桌面控制台在旧格式下会在配置窗口顶部显示一条横幅和「迁移配置」按钮，不必回到终端。

### 用命令行改配置

没有图形界面时（服务器部署），全部配置都能从命令行读写：

```bash
node scripts/config.js init              # 直接生成配置文件（含随机 AUTH_TOKEN），不走向导
node scripts/config.js schema            # 列出全部配置项及其含义（活文档，从 schema 生成）
node scripts/config.js get               # 当前配置（密钥默认脱敏，须 --reveal 才出明文）
node scripts/config.js set PORT=4100 WEB_STATUSLINE=false
node scripts/config.js set 'WORKDIRS=["/path/a","/path/b"]'   # 数组类要 JSON 字面量，不是逗号分隔
node scripts/config.js unset PORT
node scripts/config.js check             # 校验配置是否合法
node scripts/config.js migrate           # 旧 .env → ccm.config.json（含 workdirs 内联）
```

`set` 会告诉你哪些改动需要重启 server，哪些是热加载项（改完即生效）；开关接受 `true/false`、
`on/off`、`yes/no`、`1/0`。非法值整批拒写（不会写进去一半），与手机设置面板走的是同一套校验。
`init` 与 setup 一样不覆盖已有配置文件，要重建须显式加 `--force`。

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
- `--desktop` 只接受 `on` 或 `off`，缺省 `off`；`on` 会跑 `swiftc`。非 macOS 上显式给
  `--desktop=on` 会被拒绝并说明原因，而不是静默忽略。
- `--access-profile` 只接受 `cloudflare` / `vpn` / `reverse-proxy` / `direct` / `lan`，缺省不写（未声明，一切按 `CF_ACCESS_*` 推断）；非法值直接拒绝，不猜意图。
- 已有配置文件时命令会拒绝覆盖。只有确认要替换现有 token 与配置时才加 `--force`。
- 可用 `--config <path>` 指定配置文件位置。这条路径独立于仓库根已有的配置，不会因为旁边已有 `ccm.config.json` 而被拒。

多工作区在 `ccm.config.json` 里加 `WORKDIRS` 数组，每项是绝对路径或 `{path, sessionLimit}`。
**第一项就是手机端默认打开的那个**（2026-09-08 前另有一个独立的 `WORK_DIR` 键写同一个路径，已合并；
旧配置里那一行仍被识别、折进列表首位并提示可以删掉）：

```json
{
  "WORKDIRS": [
    "/Users/you/code/project-a",
    {
      "path": "/Users/you/code/project-b",
      "sessionLimit": 10
    }
  ]
}
```

`WORKDIRS` **支持热加载**，改完即生效、无需重启。哪些项能热加载由 schema 的 `reload` 标记决定，
`node scripts/config.js schema` 会在条目上标出（写这句时只有 `WORKDIRS`，以 schema 输出为准）。
仓库外的 git worktree（`../repo-<分支>` 这类）必须作为独立绝对路径显式加入。**唯一例外是「托管 worktree」**：
落在 `<已放行工作区>/.claude/worktrees/<单段目录名>` 下的那些（`EnterWorktree`、`--worktree`、agent isolation
的默认落点）由 `resolveManagedWorktree` 派生放行，无需写进 `WORKDIRS`，其会话也会并进父仓的会话列表；
深度固定 1、realpath 后比前缀、目录不存在即拒。跳出这个形态的仍然一律要显式加入。

旧版的 `WORK_DIRS`（逗号分隔）与 `WORK_DIRS_FILE=workdirs.json`（外部文件）仍然可用。
优先级：shell `WORK_DIRS` > shell `WORK_DIRS_FILE` > 配置文件内联 `WORKDIRS`。
两个 env 都没设时才用配置文件里的 `WORKDIRS`（这是生产路径）。

## 4. 运行启动自检

```bash
node scripts/doctor.js
```

它会检查 token、CLI 路径、工作区、端口、网关环境、文件权限、bridge 状态、文档/前端一致性等——
**跑一次看输出即可，这里不列全**（列全必漂：加检查项时没人会回头补散文）。
若提示 3000 已被桌面端占用，不要再执行下一步的 `npm start`，从桌面端菜单里 server 一行点「重启」。

权限类问题可让 doctor 做最小修复：

```bash
node scripts/doctor.js --fix
```

`--fix` 会收紧配置文件与控制面 JSON 文件权限；先阅读输出，再决定是否运行。

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

健康检查同样需要鉴权（`AUTH_TOKEN` 是启动前提，server 一定有它）：

```bash
curl -sS "http://127.0.0.1:3000/health?token=<AUTH_TOKEN>"
```

返回包含 `status`、`versions`、`buildNonce` 与 `timestamp` 的 JSON 才算 server 已正常响应。`AUTH_TOKEN` 等同本机 shell 入口密钥，不要把真实值贴到 issue、聊天记录或截图中。

如果桌面端或已有的 `npm start` 占着 3000，不要再起一个。桌面端菜单里 server 一行点「重启」，headless 在原终端重启。详见[部署指南的运维速查](deployment.md#运维速查)。

## 6. 从手机打开

### 同一 WiFi

直接打开启动日志给出的地址：

```text
http://<lan-ip>:3000/#token=<AUTH_TOKEN>
```

首次加载后 token 会存入浏览器 `localStorage`，并从地址栏清除。

手输 64 位 token 很痛苦，可以打成二维码用手机扫：

```bash
node scripts/qr.js                    # 自动取本机可达地址
node scripts/qr.js --url <地址>       # 指定隧道或 Tailscale 域名
```

需要约 90 列 × 45 行的终端窗口。窗口太窄时它直接拒绝输出，不会打印一个必然扫不出来的码。

> 二维码里含完整 `AUTH_TOKEN`。投屏、录屏或旁边有人时不要打印——一串明文 token 人会本能地遮挡，
> 一个「看起来无害」的二维码不会，而旁人拍一张就是完整凭据。

### 临时 HTTPS

PWA 或 Web Push 需要 HTTPS。临时试用可在另一个终端运行：

```bash
cloudflared tunnel --url http://localhost:3000
```

然后打开：

```text
https://<random>.trycloudflare.com/#token=<AUTH_TOKEN>
```

随机隧道适合测试，域名每次启动都可能变化，也没有 Cloudflare Access；设备审批仍然生效。固定域名和 Access 加层见[部署指南](deployment.md)——**还没有 CF 账号或域名**（含免费域名怎么弄）从[前置条件](deployment.md#0-前置条件-cf-账号与域名)开始看；不想经过 Cloudflare 看下一节。

### Tailscale（不经 Cloudflare 的推荐路径）

不想让流量经过 Cloudflare、也不想买域名，用 Tailscale：电脑与手机装好并登录同一账号，在电脑上跑一次

```bash
tailscale serve --bg 3000
```

然后手机打开 `https://<机器名>.<tailnet>.ts.net/#token=<AUTH_TOKEN>`（地址用 `node scripts/doctor.js` 的 TAILSCALE 项直接看）。
HTTPS 由 Tailscale 自动签发，PWA 与 Web Push 都能用；只有入了你 tailnet 的设备才触达得到，设备审批仍然生效。
完整步骤与「别顺手开 Funnel」的提醒见[部署指南](deployment.md)「Tailscale 五分钟配方」。

## 7. 批准手机设备

手机首次从非本机路径连接时会显示等待批准。四条路任选一条：

**桌面端菜单栏（macOS）** — 菜单顶部出现「🔐 N 台新设备等待批准」，展开那一行点「✓ 准入」。行标题是「设备类型 · 短 ID · 来源 IP」，悬停看完整 ID，准入前还会再确认一次。

**另一台已登录的设备** — 任何已受信任的设备上会弹出待审卡片，点「准入」即可，无需上电脑。

**headless 的终端** — 直接在跑着 `npm start` 的那个终端按回车批准最新设备，或输入 `deny` 拒绝。这条依赖 TTY，桌面端由 launchd 拉起的 server 没有 TTY，用上面两条。

**命令行**（任何模式都可用）：

```bash
node scripts/device.js list
node scripts/device.js approve <ID>
```

先核对待审设备 ID，再批准。批准后页面会立即解锁，不需要重新输入 token。

订阅了推送的话，新设备接入时还会收到一条「🔐 新设备请求接入」——出于明文通道的考虑，通知里不含设备 ID/IP，核对一律回 app 内做；同一批请求 5 分钟内只提醒一次。

如批准错设备或设备丢失：

```bash
node scripts/device.js deny <ID>
```

跳过设备审批只有两种情况：已经通过 Cloudflare Access JWT 的连接，或**真·本机直连**——peer 是 loopback **且** Host 也是 `localhost` / `127.0.0.1` / `::1`（空 Host 不算）。
经 cloudflared / nginx / SSH 反代进来的请求 peer 同样是 `127.0.0.1`，但 Host 是公网域名，**仍需审批**；普通局域网和临时随机隧道也不跳过。判据见 `app/src/auth/rate-limiter.js` 的 `shouldBypassDeviceApproval`。

## 8. 完成首次验收

两道门分开：**CCM 的访问令牌 / 设备审批**只决定手机能不能进主壳；**主机终端里的 `claude` 能不能正常跑完一轮会话**决定能不能真正对话。服务起来 ≠ 能聊天。

**这条判据对两种模型通路是同一条**（见上文 [官方订阅与第三方网关](#官方订阅与第三方网关)）：官方订阅要求本机已 `/login`；第三方网关不走 Anthropic 登录、**永远不会出现 `Not logged in`**，它要求的是 settings 里的 `ANTHROPIC_*` 真的生效。所以别拿「有没有登录」当判据——拿「在同一个工作区目录下，终端里的 `claude` 能不能聊」当判据。

在手机上依次确认：

1. 首页显示预期工作区。
2. **硬门（模型通路没配好也能验）**：新建会话并发送一条消息。**只要手机上出现的是 CLI 透传上来的真实结果——正常回答，或一条具体的错误——本步就算通过**：它证明 CCM 到 CLI 这条链路是通的，而不是假流式成功。
   - 官方订阅未登录 → 「Not logged in · Please run /login」：到主机终端打开 `claude` 执行 `/login`（或先跑通 `claude auth status`）。
   - 第三方网关**不会**出现上面那条（它不走 Anthropic 登录）。配置没生效时看到的是网关自己的报错，例如 401、连不上、模型名不认 → 照上文 [官方订阅与第三方网关](#官方订阅与第三方网关) 检查 `ANTHROPIC_*` 写在哪一层，再看 `doctor` 的 MODEL_SETTINGS 一项。
   - 两种情况收敛到同一个动作：**先在主机终端、同一个工作区目录下把 `claude` 跑通一轮正常会话**，再从手机重试。
3. **绿路径（终端已能正常会话）**：发送一个无副作用的问题，例如“只回复 OK”，能看到流式回答和回合结束状态。
4. 打开设置，确认模型、权限档、思考强度和服务状态可见。
5. 如已启用 Web Push，使用“发一条测试推送”验证通道，不要等真实审批出现才发现配置有误。

到这里，最小可用路径已经完成。下面几节都是可选增强，不影响 Web 自己发起会话。

## 可选：手机推送通知

锁屏时也能收到审批、提问和回合完成的提醒。**开启前先看清你的手机走哪条路**——三条路的依赖方完全不同：

| 手机 | 推送承载方 | 中国大陆网络 |
| --- | --- | --- |
| Android（Chrome / Edge / 三星浏览器等 Chromium 系） | Google FCM | 订阅需要代理，见下 |
| iPhone / iPad（Safari 16.4+ 且已「添加到主屏幕」） | Apple `web.push.apple.com` | 直接可用，不经 Google |
| 任意设备 + ntfy | 你自建或指定的 ntfy 服务 | 不经 Google |

### Chromium 系在中国大陆网络下的三个依赖点

Web Push 链路上有三处要连 Google，**分别发生在不同设备上**，而失败症状全都是「收不到推送」：

1. **手机订阅那一刻**——浏览器要向 Google 的注册端点注册。无代理时这一步必然失败，页面会提示「连不上推送服务（Google FCM）」。**开代理重试一次即可**。
2. **手机持续接收**——订阅完成后走 FCM 长连接。实测确认：订阅成功后关掉手机代理，推送仍能持续收到，**不需要一直挂着代理**。若你的网络下出现推送中断，改用下面的 ntfy。
3. **宿主机每次推送**——server 每次都要主动把通知 POST 给推送服务。**宿主机需要能访问 Google，而且是长期的**。

第 3 点最容易被忽略：它发生在电脑上，手机端看不出任何异常——订阅是成功的、铃铛已经收起，但一条推送也收不到。可见面有两处，文案同源（`logic/service-diag.js` 的 `formatServiceNotices`）：会话抽屉顶部的「服务」小节，以及设置 →「服务状态」里的「异常告警」段：

```text
🔔 推送最近失败于 3 分钟前（push，累计 6 次）：连不上推送服务（ENOTFOUND）
```

### 不想依赖 Google

用 ntfy：server 直接 POST 到你指定的 ntfy 服务，全程不经 Google，手机装 ntfy app 订阅 topic 即收。配置见 [deployment.md](deployment.md) 的「通知」一节——注意 ntfy 正文恒最小化，但**标题会带工作区目录名**，务必自托管或用私密 topic + `NTFY_TOKEN`。

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
- 配置里设 `CLI_HOOKS_BRIDGE: false` 可让 server 暂停消费，不必卸载全局配置。

手机端也可在“设置 → 🖥 宿主机 → 终端会话推送”中显式安装或卸载（与该页里的「📊 服务状态」按钮平级——
桥的装卸控件**不在**服务状态面板内部）。

## 可选：macOS 桌面控制台

只在 macOS 上可用，且完全可选 —— 手机端与命令行已经覆盖全部功能。

装机向导会问一句要不要编译它；也可以随时自己来：

```bash
npm run app:install    # 首次编译并装进 /Applications —— 这是 macOS 那条入口
                       # Spotlight / Launchpad / Dock 都能找到
                       # 装过之后要升级，不用回终端：菜单里点「更新桌面端（重新编译）」

# 只想先看一眼、不装系统目录：
npm run app:build && open desktop/build/CCM.app
```

**只需要 Xcode Command Line Tools，不是完整的 Xcode**（前者约 1–2GB，后者 12GB+）。
装过 git / 用过 `cc` 的机器多半已经有了；没有的话：

```bash
xcode-select --install
```

菜单栏图标显示服务状态。**桌面端自包含，不需要开终端** —— 安装、体检、看日志、改配置
全部在 app 内完成：

- **配置…**：一张表单，内容由 `config.js schema` 下发，改完点保存。它走的是同一个 CLI，
  所以**server 没起来时照样能改配置** —— 那恰恰是最需要改它的时刻。密钥只显示掩码，
  不动就不会被提交。还在旧版 `.env` 上时，窗口顶部会有一条横幅和「迁移配置」按钮。
- **查看日志**：内嵌滚动视图，下拉框可在 server / tunnel / logrotate 等各服务日志间切换（`~/Library/Logs/ccm-*.log` 有文件就有源），2 秒刷新，只读文件尾部（日志几百 MB 时也不会卡死）。
- **首次安装向导 / 体检 / 安装卸载服务**：在内嵌任务窗口里逐步执行，实时显示每一步的输出，
  某步失败就停在那里并显示退出码。
- **更新桌面端（重新编译）**：拉了新代码后点这一个就够——用当前仓库源码重新编译、装进
  `/Applications`、自动重启换上新版，一步到位。它上面那行灰字是这份 app 的身份（版本 · 编译
  时刻 · git commit · 装在哪）：两份 bundle 版本号相同，能分辨它们的是后两段。
  旁边的**重启应用**只重启不编译，用于 app 本身行为异常时。

菜单里的**打开控制台…**是主窗口：服务状态、各 unit、以及全部动作都在这一屏。

勾「开机自启（菜单栏）」只让菜单栏图标随登录出现，实现上是一个 LaunchAgent。
headless 继续用终端里的 `npm start`，两套不要同时占 3000。

### 桌面端不对劲时的退路

桌面端是 GUI 进程，有一类命令行结构上碰不到的失效方式——窗口沉到别的窗口后面点不到、菜单栏
图标被刘海挤掉、GUI 进程继承到的 `PATH` 和你终端里的不是同一份。这类问题的共同点是
**server 照常在跑，只是那一屏够不着它**。

所以菜单里「点了没反应」时，先用终端确认服务本身的状态。这两条不经过 app：

```bash
npm run service:status     # 各 unit 的真实运行态（菜单栏自己也是读它）
node scripts/doctor.js     # 启动自检
```

服务本身没问题的话，问题就在 app 层：菜单里的**重启应用**（只重启、不编译）多半能解；图标
彻底找不到时见[下面这节](#菜单栏图标被刘海挡住了怎么办)。

**桌面端没有任何独占能力**——它调的是 `scripts/` 下那几条同样的 CLI（`service.js` /
`doctor.js` / `config.js`），所以任何时候都可以绕过它直接敲命令，不必等 app 恢复。

### 为什么不直接发一个编译好的 app

自己编译出来的产物**没有 quarantine 属性**，双击就能开。而从网页下载的 app 会被系统打上
quarantine，第一次打开必然撞 Gatekeeper 的「无法验证开发者」——要根治得买 Apple 开发者
账号做公证（每年 $99），对一个自托管工具不成比例。让你自己 `xattr -d` 绕过去，等于教你
关掉一层安全机制。

编译还有个附带好处：产物与你手上这份源码严格同版本，不需要相信任何人打包的二进制。

### 菜单栏图标被刘海挡住了怎么办

MacBook Pro 的刘海会挤掉靠右的菜单栏图标。这个 app 默认没有 Dock 图标、也不进 Cmd+Tab，
所以图标一旦被挤掉就**没有任何入口**了（再次 `open CCM.app` 只是激活已在跑的实例）。

控制台窗口里有「在 Dock 中显示图标」开关，勾上之后 Dock 里会多一个图标，点它就能唤出控制台。
**建议在图标还找得到的时候先勾上它。**

已经被挤掉、进不去了的话，用命令行救一次再重开 app：

```bash
defaults write com.ccm.menubar CCMShowDockIcon -bool true
```

<details>
<summary>把首次安装交给编程 agent</summary>

在仓库目录中把下面内容交给 Claude Code、Codex CLI 或其他本机编程 agent：

```text
帮我首次安装并启动 claude-chat-mobile（把本机 claude CLI 接到手机 Web UI）。
这是全新环境首次安装，不是重启已经在跑的桌面端或 npm start。

按顺序做，每步确认结果再进入下一步：
1. 检查 node --version ≥ 20，which claude 能找到命令，并用 claude auth status 确认已登录。
   任一不满足就停下来告诉我，不要自行安装或登录 claude。
2. 运行 npm ci --omit=dev。
3. 先跟我确认工作区的绝对路径，以及是否安装 CLI hooks bridge。
   不要把整个家目录当工作区；hooks=on 会修改 ~/.claude/settings.json。
4. 你的 shell 没有 TTY，不要运行交互向导。先 unset AUTH_TOKEN WORK_DIR WORK_DIRS PORT CCM_DATA_DIR
   WORK_DIRS WORK_DIRS_FILE CF_ACCESS_HOSTNAME CF_ACCESS_TEAM CF_ACCESS_AUD LOG_TERMINAL，
   以免当前会话里已有的值压过刚写入的配置。然后：
   node scripts/setup.js --yes --work-dir=<确认后的绝对路径> --hooks=<on 或 off>
   如果配置文件已存在就停下来，不要自行加 --force。
5. 运行 node scripts/doctor.js；只在输出明确要求且安全时使用 --fix。
6. 确认 3000 没被桌面端或另一个 npm start 占用后，用 `npm start` 启动（headless）。
   用鉴权后的 /health JSON 验证，不要只看进程是否存在。
7. 告诉我启动日志中的局域网手机地址，但不要把 AUTH_TOKEN 写进任何会外传的文件或报告。
8. 等我的手机发起连接后，运行 node scripts/device.js list；让我核对设备，再执行 approve。
公网入口按 docs/deployment.md；启动只有 npm start 或 macOS 桌面端，不要擅自改系统服务。
```

</details>

## 命令速查

装机之后日常会用到的都在这里。**每条 CLI 不带子命令就会打印自己的用法**，参数一律以那份输出
为准——这份速查只列命令名和用途，不重复参数（重复一份就会和代码分叉）：

```bash
node scripts/config.js       # 不带子命令即列出用法，下面几条同理
node scripts/device.js
node scripts/service.js
node scripts/qr.js --help
npm run setup -- --help
```

> `npm run` 列出的**不是**命令全集：`service.js` 的 `start` / `stop` / `copy-token` 三个子命令
> 没有对应的 npm 别名，只能敲 `node scripts/service.js <子命令>`。

### 启动与配置

| 命令 | 用途 |
|---|---|
| `npm start` | 启动 server（默认 3000） |
| `npm run dev` | 同上，改代码自动重启 |
| `npm run setup` | 交互装机向导 |
| `node scripts/config.js schema` | **列出全部配置项及其含义**，从 schema 生成，永不与代码分叉 |
| `node scripts/config.js get\|set\|unset` | 读写单项；secret 要明文须显式 `--reveal` |
| `npm run config:check` | 校验现有配置 |
| `npm run config:migrate` | 旧版 `.env` → `ccm.config.json` |
| `node scripts/doctor.js` | 启动自检。`--fix` 把配置文件权限收紧到 0600，`--env=<文件>` 诊断指定的那一份 |

### 设备与连接

| 命令 | 用途 |
|---|---|
| `node scripts/device.js list` | 列出待审批与已受信任的设备（`--json` 机读） |
| `node scripts/device.js approve\|deny <ID>` | 批准 / 拒绝某台设备 |
| `node scripts/qr.js` | 把连接地址 + token 打成终端二维码，免手输 64 位令牌 |
| `node scripts/service.js copy-token` | 把 token 复制到剪贴板，**不打印到终端** |

> 后两条都会让令牌离开配置文件，按需敲、别写进脚本或日志。`qr.js --public` 解析公网地址；
> 受 Cloudflare Access 保护的域名**不会带 token**（那条路只认 JWT）。

### 两个 CLI 桥（可选，会写 `~/.claude`）

| 命令 | 用途 |
|---|---|
| `npm run statusline:install\|status\|uninstall` | 终端会话状态桥 |
| `npm run hooks:install\|status\|verify\|uninstall` | 终端会话通知桥 |

两者用途不同，见上面[两节](#可选cli-statusline-bridge)各自的说明。

### macOS 桌面端与受管服务

| 命令 | 用途 |
|---|---|
| `npm run app:install` / `npm run app:build` | 编译并装进 `/Applications` / 只编译到 `desktop/build/` |
| `npm run service:status` | 各 unit 的运行态与归属（`--json` 供菜单栏消费） |
| `npm run service:health` | 唯一会打 `/health` 的命令 |
| `npm run service:install\|restart\|logs\|uninstall` | 受管服务操作 |
| `npm run service:adopt` | 接管手工安装的 unit，只写 manifest、不动 plist |
| `node scripts/service.js start\|stop <unit>` | 单个 unit 启停（无 npm 别名） |

日常这些都不用手敲——桌面端菜单里都有。它们是菜单背后的同一条 CLI，app 出问题时可以直接用。

### 更新与卸载

见下面的[更新](#更新)与[卸载](#卸载)两节。

> **以下命令只在完整仓库里可用**：`npm test`、`npm run check`、`npm run lint`，以及全部
> `test:*` / `playground:*` / `mutate*`。它们引用测试树与门禁，源码归档里被裁掉了（原因见
> [方式 A](#方式-a源码归档只想把它跑起来)，要跑就用[方式 B](#方式-b完整仓库要改代码或跑测试)）。

## 更新

**代码怎么取的，就怎么更新**——第 2 步选的哪种方式，这里就走哪一条。

### 方式 A：原地覆盖（归档装的）

回到当初解压的**父目录**（也就是 `claude-chat-mobile-master/` 的上一级），重跑同一条命令：

```bash
curl -fsSL https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz | tar xz
cd claude-chat-mobile-master
npm ci --omit=dev
```

**这样覆盖不会动你的配置和数据。** `ccm.config.json` 与 `data/` 都写在 `.gitignore` 里，而归档就是
GitHub 现场 `git archive` 的产物——它只打包 git 追踪的文件，所以这两样根本不在归档中，`tar` 也就无从
覆盖。未读位点、设备审批记录、审计日志、上传附件都留在原处。

要钉住某个版本而不是跟着 `master` 走，把 URL 换成 `/archive/refs/tags/vX.Y.Z.tar.gz`，它解压出的目录名是
`claude-chat-mobile-X.Y.Z`——那是另一个目录，属于下面的「换目录」情形。

### 方式 B：`git pull`（克隆装的）

```bash
git pull
npm ci --omit=dev
```

`master` 只在发版时前进，所以拉到的就是最新发布。

### 两者之后

重启 server：桌面端点菜单里 server 那行的「重启」，headless 就重启那个 `npm start` 进程。改完建议顺手复检一次：

```bash
node scripts/doctor.js
```

**macOS 桌面端还有一步**：菜单里点「更新桌面端（重新编译）」。CCM.app 是 Swift 编译产物，不会随源码
一起更新——不点这一下，菜单栏跑的仍是旧 bundle。

### 两个需要留意的地方

**一、`tar` 是合并，不是替换。** 上游删掉的文件会残留在你的目录里。对运行没有影响（没有人 import 的
`.js` 就只是死代码），但如果想要一棵干净的树，就解压到新目录，再把 `ccm.config.json` 和 `data/` 搬过去。

**二、换了目录，两个 CLI 桥要重装。** statusline 与 hooks 桥把**安装时的绝对路径**写进了
`~/.claude/settings.json`，指向旧目录里的 runner。原地覆盖不受影响（路径没变，新代码自动生效）；换目录
之后旧路径要么指着老代码、要么直接不存在，而失效是**静默**的——状态栏不再刷新、手机端收不到 hooks
触发的推送，不会有任何报错指向这里。重装：

```bash
npm run statusline:install
npm run hooks:install
```

### 怎么知道有没有新版本

产品不主动检查上游版本。自己看：

```bash
git ls-remote --tags --refs https://github.com/Ike-li/claude-chat-mobile.git | tail -1
```

这条不要求本地是 git 仓库（它直接问远端），归档装的也能跑。本地版本：

```bash
node -p "require('./package.json').version"
```

server 起来之后，`/health` 的 `versions.server` 报的是同一个值，`versions.cli` 与 `versions.sdk` 则是本机
`claude` 与 Agent SDK 的版本——升级后拿它做一次回归核对最省事。

## 卸载

```bash
npm run uninstall -- --dry-run   # 先看会做什么，不动任何东西
npm run uninstall -- --yes       # 卸安装面：launchd 受管服务、残留的菜单栏 app 进程、CCM.app、偏好域、两个 CLI 桥及 ~/.claude/ccm
npm run uninstall -- --purge --yes  # 追加删除数据目录（按白名单逐项）、ccm.config.json/.env、受管服务日志
```

只删本产品安装/运行产生的东西：不在 service manifest 里的 launchd unit（比如手工装的
cloudflared 隧道）、`~/.claude/projects`、`~/.cloudflared`、settings.json 里桥条目以外的内容一律不碰；
两处附件目录都只报告、不删除——历史消息的附件预览要读它们：数据目录下的 `uploads/`（当前落点，
`--purge` 也不删），以及各工作区的 `.ccm-uploads/`（2026-09-06 改落数据目录之前的遗留）。
数据目录里其它不认识的文件（手动备份等）同样保留并列出。跑 `node scripts/doctor.js` 能看到它们各占多少。浏览器/手机侧的站点数据和 PWA 需要手动清。

## 常见问题

| 现象 | 检查 |
|---|---|
| server 起不来，日志说没有 `AUTH_TOKEN` | 令牌是启动前提，不再降级绑本机。跑 `npm run setup` 生成一个后重启 |
| 启动日志只列了本机地址，没有手机地址 | `BIND_MODE=loopback` 只绑 `127.0.0.1`，那些局域网地址上没人在听。要手机直连改回默认或 `lan` |
| agent 运行 setup 后什么都没写 | 非 TTY 环境用了交互模式；现在会直接拒绝。改用 `--yes --work-dir=... --hooks=...` |
| doctor / server 读的不是刚生成的配置 | 当前 shell 里已有 `AUTH_TOKEN` / `WORK_DIRS` / `CF_ACCESS_*` 等会压过配置文件；先 `unset` 这些变量再跑 |
| `EADDRINUSE :3000` | 桌面端或另一个 npm start 占着端口；不要盲目再启动 |
| 手机一直等待审批 | 运行 `device.js list`，核对并批准正确 ID |
| 手机已进主壳，发消息却出现「Not logged in · Please run /login」 | 这是 **Claude CLI 未登录**，不是 CCM 令牌/设备门坏了。到主机终端跑 `claude auth status`；未登录则在 `claude` 里 `/login`，完成后再从手机重试。**用第三方网关则不会出现这条**——它不走 Anthropic 登录，配置没生效时报的是网关自己的错，见下面「第三方网关配置不生效」。前置条件见上文 §1 |
| 输错一次 token 后，紧接着用正确 token 也被拒（HTTP 401） | 防暴破退避在生效，不是服务坏了。第 1 次失败就会武装一个 0.5 秒短锁，之后指数退避（1s → 2s → 4s…）。**这一档回的是 401 `unauthorized`、不带 `Retry-After`**（措辞刻意不说「尝试过多」——你只错了一次）。**等几秒再试**，正确 token 会自动恢复；不停重试反而一直落在锁里。只有连续 8 次失败触发的 15 分钟长锁才回 `{"status":"rate_limited"}` / HTTP 429 |
| 自己没输错，却被限速挡住 | 限速按来源分桶，同桶内的失败会累加。**IPv6 客户端按 /64 归桶**，所以同网段另一台设备连错也会连累你；反代终止在 loopback 时所有公网客户端更是共用一个桶（见[部署指南](deployment.md#换掉入口后ccm-侧的四处连带变化)）。等过锁定窗口，或重启 server 立即清零 |
| 第三方网关配置不生效 | `ANTHROPIC_*` 要放在 CLI 自己的通道里：工作区 `.claude/settings.local.json` 或 `~/.claude/settings.json` 的 `env` 块，或启动 server 的 shell；写进 `ccm.config.json` 会被剥除。桌面控制台入口只认前一种 |
| CLI 会话状态或通知缺失 | 分别检查 statusline bridge 与 hooks bridge；两者用途不同 |
| Android 安装后只是浏览器快捷方式 | Cloudflare Access 可能拦住 PWA 图标，见[部署指南](deployment.md#2b-android-pwa图标必须对匿名可达) |
| 启动日志刷「已读作数字/布尔」的类型转换提示 | `ccm.config.json` 里把数字或开关写成了字符串；改成 `3000` / `true` 而不是 `"3000"` / `"true"` |
| 桌面端菜单栏图标找不到了 | 刘海挤掉了；见[上面这节](#菜单栏图标被刘海挡住了怎么办)用 `defaults write` 救一次 |

## 下一步

- 长期公网使用：[部署与运维](deployment.md)
- 不经 Cloudflare 的公网路径：[部署与运维](deployment.md)「Tailscale 五分钟配方」
- 理解 Web/CLI 双通道：[架构说明](architecture.md)
- 理解模型、effort、statusline 展示来源：[展示契约](display-contracts.md)
- 维护者：n=1 硬性规则与技术债索引：[hard-rules.md](hard-rules.md)
- 查看全部配置项及其含义：`node scripts/config.js schema`（从 schema 生成，永不与代码分叉）

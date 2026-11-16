# 首次使用指南

> 目标：准备本机环境、安装 Claude Chat Mobile，并从手机发出第一条消息。

[English](getting-started.en.md) · [返回 README](../README.md)

## 完成后你会得到什么

- 一个只在你电脑上运行的 Claude Chat Mobile server。
- 一个受 `AUTH_TOKEN`、已连接的项目文件夹和设备审批保护的手机入口。
- 与本机 `claude` CLI 共用配置、工具和保存在本机的会话记录的 Web 界面。

本指南按步骤完成首次安装；推送、终端同步和桌面控制台可稍后配置。文中的命令都在电脑上执行，从第 3 步起须在项目目录中运行。

手动安装按 §1–§8 操作；要在外网使用，再接着看[Cloudflare 从注册到接入](deployment.md#从零搭建)。交给本机编程模型时，使用[安装提示词](#把安装交给模型)。

需要免费域名时，按[免费域名托管到 Cloudflare](cloudflare-free-domain.md)完成申请和 DNS 托管，再继续部署指南。

macOS 用「终端」App 执行命令。代码框可以复制；`<…>` 是要替换的值，不能原样执行。命令报错时先处理当前步骤，再继续。

如果 CCM 已在运行，使用原来的启动方式重启：桌面端点 server「重启」，终端运行的则在原终端停止后重新启动。

## 1. 检查前置条件

还没装 Node 或 Claude 时，先完成下表；已经能用的可以跳过。

| 工具 | 首次安装 | 装好后的检查 |
|---|---|---|
| Node.js（含 npm） | 打开 [Node.js 下载页](https://nodejs.org/en/download)，选择当前 LTS 和自己的操作系统。macOS 下载并打开 `.pkg` 安装包，按提示安装；Linux 使用页面给出的安装方式 | 重新打开终端，`node --version` 至少为 20，`npm --version` 能输出版本 |
| Claude Code CLI | 按 [Claude 官方安装说明](https://code.claude.com/docs/en/setup#install-claude-code)安装终端版。macOS / Linux 可运行下方命令 | 新开终端后 `claude --version` 能输出版本 |

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

然后运行 `claude`。官方订阅用户按提示在浏览器登录；API key / 网关用户按下一节配置。在准备接入的项目文件夹中完成一次正常对话，再回来继续。Claude 的账号、订阅或 API 费用由所用服务方提供，安装 CCM 不会开通模型服务。

若新开终端后仍提示 `claude: command not found`，按官方说明[检查 PATH](https://code.claude.com/docs/en/troubleshoot-install#verify-your-path)，不要直接进入 CCM 安装。

确认前置条件：

```bash
node --version
which claude
claude --version
```

需要满足：

- Node.js ≥ 20。
- `which claude` 能找到本机 CLI。
- 官方订阅用户：`claude auth status` 显示已登录。
- API key 或第三方网关用户：在目标项目目录运行 `claude`，能正常对话；不要求登录官方订阅账号。
- macOS 或 Linux。原生 Windows 属实验路径，推荐 WSL2。

CCM 的安装向导只配置 CCM；Node、Claude 安装及账号登录须先完成。

### 官方订阅与第三方网关

官方订阅用户先在电脑上登录 `claude`，无需额外配置 API key。API key、第三方网关等配置由 Claude CLI 管理，CCM 会读取目标项目的 CLI 配置。

推荐把网关变量写进以下任一文件的 `env` 中：

- 项目目录的 `.claude/settings.local.json`：只用于该项目；请确认已加入 `.gitignore`。
- `~/.claude/settings.json`：作为所有项目的默认配置。

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://gw.example.com",
    "ANTHROPIC_AUTH_TOKEN": "……",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<网关支持的模型名>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<网关支持的模型名>"
  }
}
```

在终端进入目标项目并启动 `claude`，按提示确认信任该目录。这种文件配置也适用于 macOS 后台服务。

也可以先在终端 `export ANTHROPIC_…`，再从**同一个终端**运行 `npm start`。桌面端启动的服务不会继承另一个终端临时导出的变量。两种配置同时存在时，网关变量以 CLI settings 文件为准。

**不要把 `ANTHROPIC_*` 写入 `ccm.config.json` 或 `.env`**：CCM 会忽略它们并打印提示。worktree 要使用网关时，写在该 worktree 的 `.claude/settings.local.json` 或用户级 `~/.claude/settings.json` 中；CCM 会排除仅来自主检出的网关变量。

手机的「设置与状态 → 排查 → 安全体检」中，`MODEL_SETTINGS` 只检查配置是否一致，不验证网关是否支持该模型。最终以实际回复为准。

## 2. 获取代码与安装依赖

有两种取得代码的方式，选一种即可。

### 方式 A：源码归档（只想把它跑起来）

```bash
curl -fsSL -o ccm-master.tar.gz https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz \
  && tar xzf ccm-master.tar.gz \
  && cd claude-chat-mobile-master \
  && npm ci --omit=dev
```

下载成功后才解压和安装。`master` 对应最新发布版本；指定版本时，把下载地址改为 `/archive/refs/tags/vX.Y.Z.tar.gz`，并进入对应的 `claude-chat-mobile-X.Y.Z` 目录。

归档包含运行、配置和运维工具，不含测试文件。需要修改代码或运行测试时选方式 B。

### 方式 B：完整仓库（要改代码或跑测试）

```bash
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile
npm ci --omit=dev
```

`npm ci --omit=dev` 只安装锁文件中指定的运行依赖。开发或测试时，在完整仓库中改用 `npm ci`。

## 3. 生成本地配置

### 交互式向导

在电脑的终端中运行（向导需要键盘输入）：

```bash
npm run setup
```

向导会：

1. 生成随机 `AUTH_TOKEN` 并写入 `ccm.config.json`，文件权限设为 `0600`。
2. 选择手机上要使用的项目文件夹。填绝对路径或 `~/` 路径，不能填家目录本身。可继续添加多个目录，第一项为默认目录；直接回车可跳过，以后在手机上选择或使用「无文件夹」。
3. 选择访问方式：局域网、Cloudflare、VPN、反向代理或公网直连。结果写入 `ACCESS_PROFILE`，供自检使用；回车可跳过。
4. 选择是否允许手机文件编辑器直接保存文件。默认开启，保存时不经过 Claude 审批；答 `n` 关闭。
5. macOS 上会问要不要编译[桌面控制台](#可选macos-桌面控制台)。默认不编译 —— 它需要
   Xcode Command Line Tools。
6. 询问是否安装 CLI hooks bridge。默认安装，但只有你确认后才会写 `~/.claude/settings.json`。

如果配置文件已存在，向导默认不覆盖。

**选择 Cloudflare 只写入访问方案声明。** 向导不会创建隧道、域名记录或 Access 应用，也不会自动填写 `CF_ACCESS_HOSTNAME/TEAM/AUD`。先完成本指南的本机启动与健康检查，再按[部署指南的新装顺序](deployment.md)配置公网入口。

### 固定 Claude CLI 的路径

在当前能运行 `claude` 的终端、项目目录下执行：

```bash
node scripts/config.js set CLAUDE_BIN="$(command -v claude)"
```

这会把当前找到的 CLI 绝对路径写入配置。尤其是 macOS 后台服务：终端里的 `which claude` 成功，不代表后台能找到它。后台使用 `zsh -lc`，读取 `.zprofile`，不会读取 `.zshrc`；仅把 `~/.local/bin` 加进 `.zshrc` 时就可能出现这个差异。以后 CLI 搬了位置，更新此项并重启 server。

### 配置文件

配置保存在项目根的 `ccm.config.json`。以下仅展示格式：保留向导生成的令牌，将目录换为自己的实际路径。

```json
{
  "$schemaVersion": 1,
  "AUTH_TOKEN": "……",
  "WORKDIRS": ["/Users/you/code/project-a"],
  "PORT": 3000
}
```

端口写数字，开关写 `true` 或 `false`，不要加引号。

<details>
<summary>更多配置：手动修改、多个文件夹和旧版迁移</summary>

旧版 `.env` 仍受支持：**`ccm.config.json` 存在时优先读它，缺失则回落 `.env`**，既有部署无需改动。
（向导只生成新格式；已有 `.env` 的部署照常工作，配置项清单随时可用 `node scripts/config.js schema` 查看。）

环境变量优先于配置文件。例如 `PORT=4000 npm start` 会使用 4000 端口。

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

> **升级时使用 `npm run config:migrate`，不要覆盖重跑 setup。** 覆盖配置会生成新 `AUTH_TOKEN`，所有设备都需要重新登录并审批。交互向导会询问是否覆盖；非交互模式仅在带 `--force` 时允许覆盖。

桌面控制台在旧格式下会在配置窗口顶部显示一条横幅和「迁移配置」按钮，不必回到终端。

### 用命令行改配置

没有图形界面时（服务器部署），全部配置都能从命令行读写：

```bash
node scripts/config.js init              # 直接生成配置文件（含随机 AUTH_TOKEN），不走向导
node scripts/config.js schema            # 列出全部配置项及其含义（与程序使用同一份配置定义）
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

由编程助手或自动化脚本安装、无法回答交互问题时，使用：

```bash
node scripts/setup.js \
  --yes \
  --work-dir=/绝对路径/到/项目 \
  --hooks=off
```

- `--work-dir` 可选：不给就一个文件夹都不连（手机上新建会话时再选）；给了就必须是绝对路径、不能是家目录本身。任何情况下都不会回落到 `$HOME`；显式给空值（`--work-dir=`，多半是变量没展开）会被拒绝。
- `--hooks` 只接受 `on` 或 `off`；`on` 会修改用户级 Claude hooks 配置。
- `--desktop` 只接受 `on` 或 `off`，缺省 `off`；`on` 会跑 `swiftc`。非 macOS 上显式给
  `--desktop=on` 会被拒绝并说明原因，而不是静默忽略。
- `--access-profile` 只接受 `cloudflare` / `vpn` / `reverse-proxy` / `direct` / `lan`，缺省不写（未声明，一切按 `CF_ACCESS_*` 推断）；非法值直接拒绝，不猜意图。
- 已有配置文件时命令会拒绝覆盖。只有确认要替换现有 token 与配置时才加 `--force`。
- 可用 `--config <path>` 指定配置文件位置。这条路径独立于仓库根已有的配置，不会因为旁边已有 `ccm.config.json` 而被拒。

### 多个文件夹与 worktree

在 `ccm.config.json` 的 `WORKDIRS` 数组中填写多个目录，每项可以是绝对路径或 `{path, sessionLimit}`。
**第一项是默认打开的目录。** 旧版 `WORK_DIR` 仍可识别，会合并到列表首位：

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

`WORKDIRS` 保存后立即生效，无需重启。其他配置是否需要重启，可用 `node scripts/config.js schema` 查看。

`WORKDIRS` 就是「已连接的文件夹」，与 Claude 桌面端给手机开的那份文件夹清单同一语义：

- **子文件夹直接可用**：连上 `~/code` 之后，`~/code/app` 里开会话不必再单独列出；抽屉里有会话的子文件夹各成一节。连接互相嵌套时归最深的那个。
- **git worktree**：仓库内部的 worktree 可直接使用，会话归入该仓库。仓库外的平级 worktree 需要单独连接，或连接包含它的父目录。
- **不能连接的**：家目录本身、磁盘根（配置文件里也写不进去）。`~/.claude` 与本应用的数据目录手机上加不了；连了它们的上级目录（比如装着本应用的 `~/code`）时，它们也不会顺带变成会话目录——除非你在配置文件里把它们显式写进 `WORKDIRS`。仓库 `.claude/worktrees/` 下的 worktree 不能单独添加，添加它所属的仓库即可。
- **手机上可以直接选、也可以断开**：新会话页点文件夹胶囊，或抽屉顶部「＋ 选择文件夹」——只浏览家目录里的目录名，不能加的会置灰并写明原因。「在这里开始会话」会先把它连上再开（已经连着的不重复加），就地新建的文件夹也直接连上、在里面开。抽屉里已连接的文件夹右侧「⋯」可以断开：只是不再显示、不能在里面新开，文件和会话记录都不动，开着的会话照常跑完。添加和断开都写回配置文件里的 `WORKDIRS` 并立即生效。两种情况手机上改不了：文件夹列表来自环境变量（下面那两个旧键）；没有 `ccm.config.json`（只用旧版 `.env`）——先在电脑上运行 `npm run config:migrate` 生成（保留原有 token，见[从旧版 `.env` 升级](#从旧版-env-升级)）。
- **无文件夹**：新会话也可以不放进任何文件夹，跑在应用自建的一次性目录里（macOS 在 `~/Library/Application Support/claude-chat-mobile/scratch-workspaces`，Linux 在 `${XDG_DATA_HOME:-~/.local/share}/claude-chat-mobile/scratch-workspaces`）。第一条消息发出时才建，删除会话时一并删除（目录里还有别的会话时保留）。

旧版的 `WORK_DIRS`（逗号分隔）与 `WORK_DIRS_FILE=workdirs.json`（外部文件）仍然可用。
优先级：shell `WORK_DIRS` > shell `WORK_DIRS_FILE` > 配置文件内联 `WORKDIRS`。
两个 env 都没设时才用配置文件里的 `WORKDIRS`。

</details>

## 4. 运行启动自检

```bash
node scripts/doctor.js
```

自检会检查令牌、Claude 路径、项目目录、端口和配置权限等。先处理输出中的失败项；未启用的可选功能可以稍后配置。
若已选择 Cloudflare，但还没配置公网入口，`ACCESS_PROFILE` 提示 `CF_ACCESS_*` 未配齐是待办项；可以先完成下一步的本机启动和健康检查，随后按部署指南补齐，公网验收前须消除这项告警。
若提示 3000 已被桌面端占用，不要再执行下一步的 `npm start`，从桌面端菜单里 server 一行点「重启」。

权限类问题可让 doctor 做最小修复：

```bash
node scripts/doctor.js --fix
```

`--fix` 会将配置和状态文件设为仅当前用户可读写；先确认自检提示需要修复权限。

## 5. 启动 server

在项目目录启动服务，保持这个终端打开：

```bash
npm start
```

默认监听 `3000` 端口。启动日志应显示：

- server 已监听；
- 脱敏后的 token 状态；
- 可在手机打开的局域网 URL；
- bridge 与待审批设备状态。

**另开一个终端，进入同一项目目录**，检查服务是否正常：

```bash
node scripts/service.js health --json
```

命令会从本地配置读取令牌并带鉴权请求 `/health`。返回 `ok: true`、`health.status: "ok"`，并在 `health.versions` 中显示 server、SDK 与 CLI 版本，才算 server 已正常响应。`AUTH_TOKEN` 等同本机 shell 入口密钥，不要把真实值贴到 issue、聊天记录或截图中。

如果桌面端或已有的 `npm start` 占着 3000，不要再起一个。桌面端菜单里 server 一行点「重启」，headless 在原终端重启。详见[部署指南的运维速查](deployment.md#运维速查)。

## 6. 从手机打开

### 同一 WiFi

推荐在电脑的项目目录生成二维码，用同一 WiFi 下的手机扫码：

```bash
node scripts/qr.js
```

二维码需要约 90 列 × 45 行的终端窗口；窗口太小时先放大。

手动输入时，用 `node scripts/config.js get AUTH_TOKEN --reveal` 在本机查看令牌，填入以下地址。`<lan-ip>` 使用启动日志里的局域网 IP；脱敏后的令牌不能用于登录。

```text
http://<lan-ip>:3000/#token=<AUTH_TOKEN>
```

首次登录后，浏览器会保存令牌并从地址栏移除。**二维码和完整地址都含访问令牌，请勿分享或在投屏时展示。**

### 临时 HTTPS

PWA 或 Web Push 需要 HTTPS。临时试用可在另一个终端运行：

```bash
cloudflared tunnel --url http://localhost:3000
```

然后打开：

```text
https://<random>.trycloudflare.com/#token=<AUTH_TOKEN>
```

随机隧道适合测试，域名每次启动都可能变化，也没有 Cloudflare Access；设备审批仍然生效。固定域名和 Access 登录配置见[部署指南](deployment.md)——**还没有 CF 账号或域名**（含免费域名怎么弄）从[前置条件](deployment.md#0-前置条件-cf-账号与域名)开始看；不想经过 Cloudflare 看下一节。

### Tailscale（不经 Cloudflare 的推荐路径）

不想让流量经过 Cloudflare、也不想买域名，可选 Tailscale。先按[官方入门步骤](https://tailscale.com/docs/how-to/quickstart)注册账号，在电脑与手机安装并登录同一账号，再在电脑上运行：

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

订阅了推送的话，新设备接入时还会收到一条「🔐 新设备请求接入」——通知不包含设备 ID/IP，请回到 app 核对；同一批请求 5 分钟内只提醒一次。

如批准错设备或设备丢失：

```bash
node scripts/device.js deny <ID>
```

默认配置下，本机直连和通过 Cloudflare Access 身份验证的连接无需再次审批；局域网手机和临时隧道通常需要。设置 `DEVICE_APPROVAL_SCOPE=all` 后，所有连接都需要审批。

本机识别还会检查请求的 Host，不能只看来源 IP。SSH / frp 等纯 TCP 转发的注意事项见[部署指南](deployment.md#架构)，具体实现见 `app/src/auth/rate-limiter.js` 的 `shouldBypassDeviceApproval`。

## 8. 完成首次验收

固定域名走 Cloudflare 时，先完成[部署指南的逐层验收](deployment.md#3b-逐层验收)：**本机健康 → 隧道转发 → Access 登录 → 实时连接**。看到 Access 登录页、隧道显示健康，都不能替代登录后进入 CCM 并建立实时连接。

能打开 CCM 只说明连接成功。**完成首次使用还要确认能收到模型回复：**

1. 首页选择目标项目文件夹，或使用「无文件夹」。
2. 新建会话，发送“只回复 OK”。确认回复逐步显示，最后结束运行。
3. 若出现 `Not logged in · Please run /login`，在电脑上登录 Claude；若出现网关 401、无法连接或模型不存在，检查 [CLI 的网关配置](#官方订阅与第三方网关)。先在同一项目目录用终端 `claude` 跑通，再回手机重试。
4. 在输入框下方的「模型 · 权限 · 思考」设置中确认所选配置。如已启用 Web Push，再发送一条测试推送。

收到 CLI 错误说明请求已经到达 CLI，**仍需解决错误并收到正常回复，才算完成安装验收**。服务状态可在「设置与状态 → 宿主机 → 服务状态」查看。

下面的功能均为可选，不影响从网页发起会话。

## 可选：手机推送通知

锁屏时也能收到审批、提问和回合完成的提醒。**开启前先看清你的手机走哪条路**——三条路的依赖方完全不同：

| 手机 | 推送承载方 | 中国大陆网络 |
| --- | --- | --- |
| Android（Chrome / Edge / 三星浏览器等 Chromium 系） | Google FCM | 订阅需要代理，见下 |
| iPhone / iPad（Safari 16.4+ 且已「添加到主屏幕」） | Apple `web.push.apple.com` | 直接可用，不经 Google |
| 任意设备 + ntfy | 你自建或指定的 ntfy 服务 | 不经 Google |

### 开启 Web Push

Web Push 默认关闭：要配齐 VAPID 公钥、私钥和联系方式三项才启用，缺一项 server 就不提供订阅（`doctor` 的 PUSH_VAPID 一项显示「未配置」）。在项目目录下生成一次密钥并写进配置：

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"   # 打印 publicKey / privateKey
node scripts/config.js set VAPID_PUBLIC_KEY=<publicKey> VAPID_PRIVATE_KEY=<privateKey> VAPID_SUBJECT=mailto:you@example.com
```

`VAPID_SUBJECT` 必须以 `mailto:` 或 `https:` 开头。重启 server 后，在手机的设置 → 通知页点「开启」订阅。密钥生成后就别再换：换了之后已订阅的设备都要重新订阅。

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

用 ntfy：server 直接 POST 到你指定的 ntfy 服务，全程不经 Google，手机装 ntfy app 订阅 topic 即收。配置见 [deployment.md](deployment.md) 的「通知」一节——注意 ntfy 正文不含消息内容，但**标题会带工作区目录名**，务必自托管或用私密 topic + `NTFY_TOKEN`。

## 可选：CLI statusline bridge

网页发起的会话默认提供 SDK 状态栏。只有当你还想在 Web **只读查看终端正在运行的会话**时同步 CLI 的模型、思考强度、上下文、成本和额度，才需要 statusline bridge。

```bash
npm run statusline:status
npm run statusline:install
```

- `status` 只读，不改 `~/.claude`。
- `install` 需要主动执行，会包装已有的 Claude CLI statusline 命令；未配置 statusline 时安装器会拒绝。
- 安装后重开终端里的 Claude CLI，并重启常驻 server。
- 卸载用 `npm run statusline:uninstall`，安装器会按 manifest 恢复原命令并不会覆盖安装后被手动修改的配置；`~/.claude/ccm/statusline-v1`（含快照）一并清掉，`~/.claude/ccm` 空了也会移除。

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
- `uninstall` 按 manifest 移除自己的 hook 条目，并清掉 `~/.claude/ccm/hooks-v1`（投递箱与回执）；`~/.claude/ccm` 空了也会移除。装、卸都不必重启 server。

手机端也可在“设置 → 🖥 宿主机 → 终端会话推送”中显式安装或卸载（与该页里的「📊 服务状态」按钮平级——
桥的装卸控件**不在**服务状态面板内部）。

## 可选：macOS 桌面控制台

只在 macOS 上可用，且完全可选 —— 手机端与命令行已经覆盖全部功能。

先运行 `xcode-select -p` 检查编译工具。若报未安装，运行下面的命令，在系统窗口完成安装后再继续；需要的是 Xcode Command Line Tools，无需安装完整 Xcode。详见 [Apple 安装说明](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools/)。

```bash
xcode-select --install
```

安装桌面控制台：

```bash
npm run app:install    # 首次编译并装进 /Applications —— 这是 macOS 那条入口
                       # Spotlight / Launchpad / Dock 都能找到
                       # 装过之后要升级，不用回终端：菜单里点「更新桌面端（重新编译）」

# 只想先看一眼、不装系统目录：
npm run app:build && open desktop/build/CCM.app
```

菜单栏图标显示服务状态。常用的安装、体检、日志和配置操作可在 app 内完成：

- **配置…**：一张表单，内容由 `config.js schema` 下发，改完点保存。服务尚未启动时也能修改配置。密钥只显示掩码，
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
图标被刘海挤掉、GUI 进程继承到的 `PATH` 和你终端里的不是同一份。前两类可能只影响控制台；
PATH 差异还可能让 server 因找不到 Claude 而启动失败。先确认服务本身是否健康，不能仅凭菜单栏图标判断。

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

本地编译能让应用与当前源码保持同一版本，也不会产生网页下载文件的 quarantine 标记。项目目前不提供经过 Apple 公证的预编译安装包。

### 菜单栏图标被刘海挡住了怎么办

MacBook Pro 的刘海会挤掉靠右的菜单栏图标。这个 app 默认没有 Dock 图标、也不进 Cmd+Tab，
所以图标一旦被挤掉就**没有任何入口**了（再次 `open CCM.app` 只是激活已在跑的实例）。

控制台窗口里有「在 Dock 中显示图标」开关，勾上之后 Dock 里会多一个图标，点它就能唤出控制台。
**建议在图标还找得到的时候先勾上它。**

已经被挤掉、进不去了的话，用命令行救一次再重开 app：

```bash
defaults write com.ccm.menubar CCMShowDockIcon -bool true
```

## 把安装交给模型

模型需要能读写项目文件、运行本机命令；只有聊天窗口、无法操作这台电脑时，只能提供指导。账号登录、验证码和付款信息由用户完成。

把项目目录和下面的提示词交给本机编程模型。源码归档也包含这份指南，不必依赖模型自动读取 `AGENTS.md`。要配置 Cloudflare 公网入口，再接着使用[Cloudflare 配置提示词](deployment.md#把-cloudflare-配置交给模型)。

<details>
<summary>复制本机首次安装提示词</summary>

```text
帮我首次安装并启动 claude-chat-mobile（把本机 claude CLI 接到手机 Web UI）。
这是全新环境首次安装，不是重启已经在跑的桌面端或 npm start。

按顺序做，每步确认结果再进入下一步：
1. 检查 node --version ≥ 20，which claude 能找到命令。官方订阅用户用 claude auth status 确认登录；
   API key / 网关用户核对现有 CLI 配置，不要求官方登录。缺少前置条件时，按 docs/getting-started.md §1
   协助安装；需要用户操作的登录或系统授权，给出具体步骤，完成后继续。不要重装已有的工具。
2. 运行 npm ci --omit=dev。
3. 先跟我确认要不要先连一个项目文件夹（要的话确认它的绝对路径；不连也行，以后在手机上选），
   以及是否安装 CLI hooks bridge。不要把整个家目录当工作区；hooks=on 会修改 ~/.claude/settings.json。
4. 你的 shell 没有 TTY，不要运行交互向导。先 unset AUTH_TOKEN WORK_DIR WORK_DIRS PORT CCM_DATA_DIR
   WORK_DIRS_FILE CF_ACCESS_HOSTNAME CF_ACCESS_TEAM CF_ACCESS_AUD LOG_TERMINAL，
   以免当前会话里已有的值压过刚写入的配置。然后：
   node scripts/setup.js --yes --work-dir=<确认后的绝对路径> --hooks=<on 或 off>
   （不连文件夹就去掉 --work-dir 这一项。）如果配置文件已存在就停下来，不要自行加 --force。
5. 在能找到 claude 的终端执行 node scripts/config.js set CLAUDE_BIN="$(command -v claude)"。
   再运行 node scripts/doctor.js；仅在需要修复文件权限时使用 --fix。
6. 确认 3000 没被桌面端或另一个 npm start 占用后，用 `npm start` 启动（headless）。
   另开终端进入同一项目目录，用 node scripts/service.js health --json 验证。
7. 告诉我启动日志中的局域网手机地址，但不要把 AUTH_TOKEN 写进任何会外传的文件或报告。
8. 等我的手机发起连接后，运行 node scripts/device.js list；让我核对设备，再执行 approve。
公网入口按 docs/deployment.md；启动只有 npm start 或 macOS 桌面端，不要擅自改系统服务。
```

</details>

## 命令速查

下表列出常用命令。完整参数以命令的帮助输出为准：

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
| `node scripts/config.js schema` | **列出全部配置项及其含义**，由程序的配置定义生成 |
| `node scripts/config.js get\|set\|unset` | 读写单项；secret 要明文须显式 `--reveal` |
| `npm run config:check` | 校验现有配置 |
| `npm run config:migrate` | 旧版 `.env` → `ccm.config.json` |
| `node scripts/doctor.js` | 启动自检。`--fix` 把配置文件权限收紧到 0600，`--env=<文件>` 诊断指定的那一份 |
| `node scripts/perf-report.js` | 汇总手机上报到 server 日志的性能记录（启动、打开会话、切回前台、掉帧、点击响应），按设备 / 网络 / 缓存等维度列 n·p50·p90·max；`--since 7d` 只看最近。只读 |

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

### macOS 桌面端与服务管理

| 命令 | 用途 |
|---|---|
| `npm run app:install` / `npm run app:build` | 编译并装进 `/Applications` / 只编译到 `desktop/build/` |
| `npm run service:status` | 各服务的运行状态与管理方式（`--json` 输出） |
| `npm run service:health` | 带鉴权检查服务健康 |
| `npm run service:install\|restart\|logs\|uninstall` | CCM 管理的服务操作 |
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

回到当初解压的**父目录**（也就是 `claude-chat-mobile-master/` 的上一级），先把归档下载成文件，下载成功再解压：

```bash
curl -fsSL -o ccm-master.tar.gz https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz \
  && tar xzf ccm-master.tar.gz && rm ccm-master.tar.gz
cd claude-chat-mobile-master
npm ci --omit=dev
node -p "require('./package.json').version"
```

**最后一行打印的版本号要和[最新发布](https://github.com/Ike-li/claude-chat-mobile/releases/latest)对上**，没变就是没更新到。
下载失败时停止，重试成功后再解压。GitHub 连接不稳时，可为 curl 配置代理（`https_proxy=…`）。

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

### 从 v1.13.0 升级：已连接的文件夹

v1.13.0 及更早的版本里，`WORKDIRS` 是一份精确白名单：会话目录必须恰好是其中一项（外加它下面
`.claude/worktrees/` 里的托管 worktree）。新版把它换成了「已连接的文件夹」，语义见
[第 3 步](#3-生成本地配置)末尾那段。**数据不用迁移，原有的 `WORKDIRS` 照常生效**；变的是同一份清单
放行得更多，以及几处从「悄悄纠正」改成了「直接拒绝」。

**范围变宽了，升级前先过一遍清单。** 子文件夹现在直接可用，连接互相嵌套时归最深的那一项。清单里连着
`~/code` 这种大父目录的，升级后整棵子树都能开会话，子树里以前在终端开过的会话也会出现在抽屉里，有会话的
子文件夹各占一节。只想开放其中几个项目，就把父目录换成那几个。`~/.claude` 与本应用的数据目录仍是禁区，
连着它们的上级也不会被顺带放行。

**hooks 桥推得更多。** 装了 CLI hooks bridge 的，子文件夹里终端会话的「需要你」和回合完成现在也会推到
手机上；旧版只推清单里那几个目录本身。

**手机上添加文件夹，要求清单写在 `ccm.config.json` 的 `WORKDIRS` 里**，否则点了只会提示改不了。下面两件事
都只在启动时生效，做完再重启 server：

- 还在用 `.env`（包括 `WORK_DIRS_FILE` 指向的 `workdirs.json`）的，跑 `npm run config:migrate`，它会把
  列表内联进去并保留原有的 `AUTH_TOKEN`（见[从旧版 `.env` 升级](#从旧版-env-升级)）。`ccm.config.json`
  里自己写着 `WORK_DIRS_FILE` 的，直接编辑文件：把那份列表填进 `WORKDIRS`，删掉 `WORK_DIRS_FILE`。
- shell 里 export 了 `WORK_DIRS` 或 `WORK_DIRS_FILE` 的，把它们去掉。环境变量压过配置文件，留着它们，
  手机上就只能看、不能加。

**平级 worktree 照旧要显式连接。** 仓库外的 `../repo-<分支>` 和旧版一样不随仓库放行：清单里列着的升级后
照常可用、自成一节，没列的也不会自己冒出来。只有一种情况会多一条提示：某个 worktree 条目已经落在别的连接
范围里（比如父目录整个连着），它仍然单独成一节，`node scripts/doctor.js` 会指出这条可以删，删掉之后它的
会话并回仓库那一节。

**越界请求改成直接拒绝。** 旧版遇到不在清单里的目录，会悄悄换成当前正在看的那个目录；新版直接拒绝。
最容易碰到的是离线队列：排队等发的消息要在某个文件夹里开会话，而那个文件夹在它发出去之前被移出了清单，
现在会提示「这个目录不在已连接的文件夹里，已停止重试」，不会再投进别的文件夹，需要的话手动重发。

**升级前没发出去的离线消息不会自动重发。** 它们记着旧版的会话句柄，升级重启后认不出，一律判「目标会话已关闭」，
不投进任何会话。刷新过的页面会把原文写在提示里，复制出来重发即可；升级时一直开着、没刷新的旧页面只在那条消息的
气泡上提示，页面一跳到别的会话就看不到了。所以升级前先让手机把离线消息发完，或者升级后刷新一次手机上的页面。

**会话中途走出范围，手机不跟。** 手机上开的会话运行中进入已连接的文件夹以外的目录（最常见的是
`EnterWorktree` 进了一个没连接的平级 worktree），手机这边停在原处，会话里会出现一条提示。这时切走就找不回
这个会话了；要接着用，先把那个文件夹连上。

**最后刷新一次手机页面。** 重启 server 后，手机上已经开着的页面跑的还是旧前端，刷新一次才有文件夹选择器
（新会话页的文件夹胶囊、抽屉顶部的「＋ 选择文件夹」）。从主屏幕图标打开的，彻底关掉再重新打开。

### 怎么知道有没有新版本

产品不主动检查上游版本。自己看：

```bash
git ls-remote --tags --refs --sort=-v:refname https://github.com/Ike-li/claude-chat-mobile.git | head -1
```

这条不要求本地是 git 仓库（它直接问远端），归档装的也能跑。`--sort=-v:refname` 不能省：远端按字典序列 tag，不排序取最后一行拿到的是 `v1.9.1`，而 `v1.10.0` 之后的版本都排在它前面。本地版本：

```bash
node -p "require('./package.json').version"
```

server 起来之后，`/health` 的 `versions.server` 报的是同一个值，`versions.cli` 与 `versions.sdk` 则是本机
`claude` 与 Agent SDK 的版本——升级后拿它做一次回归核对最省事。

## 卸载

```bash
npm run uninstall -- --dry-run   # 先看会做什么，不动任何东西
npm run uninstall -- --yes       # 卸载 CCM 管理的服务、桌面应用和 CLI 桥，清理相关设置
npm run uninstall -- --purge --yes  # 另删指定的应用数据、配置和服务日志
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
| agent 运行 setup 后什么都没写 | 非 TTY 环境用了交互模式；现在会直接拒绝。改用 `--yes --hooks=...`（要连文件夹再加 `--work-dir=...`） |
| doctor / server 读的不是刚生成的配置 | 当前 shell 里已有 `AUTH_TOKEN` / `WORK_DIRS` / `CF_ACCESS_*` 等会压过配置文件；先 `unset` 这些变量再跑 |
| `EADDRINUSE :3000` | 桌面端或另一个 npm start 占着端口；不要盲目再启动 |
| 手机一直等待审批 | 运行 `device.js list`，核对并批准正确 ID |
| 手机已进主壳，发消息却出现「Not logged in · Please run /login」 | 这是 **Claude CLI 未登录**，不是 CCM 令牌/设备门坏了。到主机终端跑 `claude auth status`；未登录则在 `claude` 里 `/login`，完成后再从手机重试。**用第三方网关则不会出现这条**——它不走 Anthropic 登录，配置没生效时报的是网关自己的错，见下面「第三方网关配置不生效」。前置条件见上文 §1 |
| 输错一次 token 后，紧接着用正确 token 也被拒（HTTP 429 `cooldown`） | 登录失败后会短暂限制重试：首次 0.5 秒，后续依次延长。429 `cooldown` 响应带 `Retry-After`，网页会自动等待重连；脚本应等到指定时间再试。连续 8 次失败会锁定 15 分钟，返回 `rate_limited`。 |
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
- 查看全部配置项及其含义：`node scripts/config.js schema`（由程序的配置定义生成）

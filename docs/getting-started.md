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
- 第三方网关：先在**将要启动 server 的 shell** 中导出网关要求的 `ANTHROPIC_*`，再启动项目。
- 不要把 `ANTHROPIC_*` 写进项目配置文件：启动时会主动剥除这些值，避免项目文件覆盖 CLI/provider 环境。剥除不是静默的——启动日志会逐个打印 `[config] 已忽略配置文件里的 ANTHROPIC_…`，`doctor` 的「网关环境一致性」一项也会提示。
- **网关用户请用 headless 终端入口（`npm start`）**：`ANTHROPIC_*` 只从启动进程的环境继承。macOS 桌面控制台拉起的常驻服务是干净的 GUI 血统环境，里面没有你终端里 export 的变量——网关配置在那条入口下不生效。
- 顺带说明：官方的 Remote Control 遥控在网关 / API key / 关遥测配置下整条不可用（要求 claude.ai 订阅并直连官方 API）；本项目对模型通路零假设，上述配置下全功能可用——这正是它存在的主要理由之一，见 [README「为什么需要它」](../README.md#为什么需要它)。

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

1. 生成随机 `AUTH_TOKEN` 并写入 `ccm.config.json`，文件权限设为 `0600`。
2. 询问「手机端要打开哪个项目目录」。必须填绝对路径（或 `~/` 路径）；空回车和家目录本身都会被拒绝。首个之后可以继续追加更多项目目录（回车结束）——全部写进 `WORKDIRS` 数组，第一个作为默认打开的 `WORK_DIR`。以后增删工作区直接改配置里的 `WORKDIRS` 即可，保存即热加载生效。
3. 询问「你打算怎么从手机访问」（仅局域网 / Cloudflare / 加密隧道 VPN / 自建反代）。回车可跳过；选了会写入 `ACCESS_PROFILE`，`doctor` 与手机端安全体检按它做针对性检查，向导结尾也会打印对应方案的文档指引。
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
  "WORK_DIR": "/Users/you/code/project-a",
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
> `AUTH_TOKEN`——所有已批准的设备都会失效，每台手机都得重新走一遍审批。已有配置时
> setup 会拒绝并指向 `migrate`，请照它说的做。

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
- `--access-profile` 只接受 `cloudflare` / `vpn` / `reverse-proxy` / `lan`，缺省不写（未声明，一切按 `CF_ACCESS_*` 推断）；非法值直接拒绝，不猜意图。
- 已有配置文件时命令会拒绝覆盖。只有确认要替换现有 token 与配置时才加 `--force`。
- 可用 `--config <path>` 指定配置文件位置。这条路径独立于仓库根已有的配置，不会因为旁边已有 `ccm.config.json` 而被拒。

多工作区在 `ccm.config.json` 里加 `WORKDIRS` 数组，每项是绝对路径或 `{path, sessionLimit}`：

```json
{
  "WORK_DIR": "/Users/you/code/project-a",
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
git worktree 也必须作为独立绝对路径显式加入；项目不会自动发现或放行。

旧版的 `WORK_DIRS_FILE=workdirs.json`（外部文件）与 `WORK_DIRS`（逗号分隔）仍然可用，
但优先级低于 `WORKDIRS`。三者同时存在时只有 `WORKDIRS` 生效。

## 4. 运行启动自检

```bash
node scripts/doctor.js
```

它会检查 token、CLI 路径、工作区、端口、网关环境、文件权限、bridge 状态和文档/前端一致性。
默认不跑单测覆盖率（要跑一遍完整单测，约一分钟）；那道门槛由 CI 守着，维护者本地想立刻看就加 `--full`。
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

### 临时 HTTPS

PWA 或 Web Push 需要 HTTPS。临时试用可在另一个终端运行：

```bash
cloudflared tunnel --url http://localhost:3000
```

然后打开：

```text
https://<random>.trycloudflare.com/#token=<AUTH_TOKEN>
```

随机隧道适合测试，域名每次启动都可能变化，也没有 Cloudflare Access；设备审批仍然生效。固定域名和 Access 2FA 见[部署指南](deployment.md)。

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
经 cloudflared / nginx / SSH 反代进来的请求 peer 同样是 `127.0.0.1`，但 Host 是公网域名，**仍需审批**；普通局域网和临时随机隧道也不跳过。判据见 `src/auth/rate-limiter.js` 的 `shouldBypassDeviceApproval`。

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
- 配置里设 `CLI_HOOKS_BRIDGE: false` 可让 server 暂停消费，不必卸载全局配置。

手机端也可在“设置 → 服务状态 → 终端会话推送”中显式安装或卸载。

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
2. 运行 npm install --omit=dev。
3. 先跟我确认 WORK_DIR 的绝对路径，以及是否安装 CLI hooks bridge。
   不要把整个家目录当 WORK_DIR；hooks=on 会修改 ~/.claude/settings.json。
4. 你的 shell 没有 TTY，不要运行交互向导。先 unset AUTH_TOKEN WORK_DIR PORT CCM_DATA_DIR
   WORK_DIRS WORK_DIRS_FILE CF_ACCESS_HOSTNAME CF_ACCESS_TEAM CF_ACCESS_AUD LOG_TERMINAL，
   以免当前会话里已有的值压过刚写入的配置。然后：
   node scripts/setup.js --yes --work-dir=<确认后的绝对路径> --hooks=<on 或 off>
   如果配置文件已存在就停下来，不要自行加 --force。
5. 运行 node scripts/doctor.js；只在输出明确要求且安全时使用 --fix。不要加 --full，除非我要求。
6. 确认 3000 没被桌面端或另一个 npm start 占用后，用 `npm start` 启动（headless）。
   用鉴权后的 /health JSON 验证，不要只看进程是否存在。
7. 告诉我启动日志中的局域网手机地址，但不要把 AUTH_TOKEN 写进任何会外传的文件或报告。
8. 等我的手机发起连接后，运行 node scripts/device.js list；让我核对设备，再执行 approve。
公网入口按 docs/deployment.md；启动只有 npm start 或 macOS 桌面端，不要擅自改系统服务。
```

</details>

## 卸载

```bash
npm run uninstall -- --dry-run   # 先看会做什么，不动任何东西
npm run uninstall -- --yes       # 卸安装面：launchd 受管服务、残留的菜单栏 app 进程、CCM.app、偏好域、两个 CLI 桥及 ~/.claude/ccm
npm run uninstall -- --purge --yes  # 追加删除数据目录（按白名单逐项）、ccm.config.json/.env、受管服务日志
```

只删本产品安装/运行产生的东西：不在 service manifest 里的 launchd unit（比如手工装的
cloudflared 隧道）、`~/.claude/projects`、`~/.cloudflared`、settings.json 里桥条目以外的内容一律不碰；
各工作区的 `.ccm-uploads/` 只报告不删除（历史消息的附件预览要读它）。数据目录里不认识的文件
（手动备份等）会保留并列出。浏览器/手机侧的站点数据和 PWA 需要手动清。

## 常见问题

| 现象 | 检查 |
|---|---|
| server 起不来，日志说没有 `AUTH_TOKEN` | 令牌是启动前提，不再降级绑本机。跑 `npm run setup` 生成一个后重启 |
| 启动日志只列了本机地址，没有手机地址 | `BIND_MODE=loopback` 只绑 `127.0.0.1`，那些局域网地址上没人在听。要手机直连改回默认或 `lan` |
| agent 运行 setup 后什么都没写 | 非 TTY 环境用了交互模式；现在会直接拒绝。改用 `--yes --work-dir=... --hooks=...` |
| doctor / server 读的不是刚生成的配置 | 当前 shell 里已有 `AUTH_TOKEN` / `WORK_DIR` / `CF_ACCESS_*` 等会压过配置文件；先 `unset` 这些变量再跑 |
| `EADDRINUSE :3000` | 桌面端或另一个 npm start 占着端口；不要盲目再启动 |
| 手机一直等待审批 | 运行 `device.js list`，核对并批准正确 ID |
| 输错一次 token 后，连正确 token 也返回 `{"status":"rate_limited"}` / HTTP 429 | 防暴破退避在生效，不是服务坏了。第 1 次失败就会武装一个 0.5 秒短锁，之后指数退避（1s → 2s → 4s…）。**等几秒再试**，正确 token 会自动恢复；不停重试反而一直落在锁里。15 分钟长锁需要连续 8 次失败、且每次都等过退避才触发 |
| 自己没输错，却被限速挡住 | 限速按来源分桶，同桶内的失败会累加。**IPv6 客户端按 /64 归桶**，所以同网段另一台设备连错也会连累你；反代终止在 loopback 时所有公网客户端更是共用一个桶（见[部署指南](deployment.md#换掉入口后ccm-侧的四处连带变化)）。等过锁定窗口，或重启 server 立即清零 |
| 第三方网关配置不生效 | `ANTHROPIC_*` 必须来自启动 server 的 shell，不是配置文件 |
| CLI 会话状态或通知缺失 | 分别检查 statusline bridge 与 hooks bridge；两者用途不同 |
| Android 安装后只是浏览器快捷方式 | Cloudflare Access 可能拦住 PWA 图标，见[部署指南](deployment.md#2b-android-pwa图标必须对匿名可达) |
| 启动日志刷「已读作数字/布尔」的类型转换提示 | `ccm.config.json` 里把数字或开关写成了字符串；改成 `3000` / `true` 而不是 `"3000"` / `"true"` |
| 桌面端菜单栏图标找不到了 | 刘海挤掉了；见[上面这节](#菜单栏图标被刘海挡住了怎么办)用 `defaults write` 救一次 |

## 下一步

- 长期公网使用：[部署与运维](deployment.md)
- 理解 Web/CLI 双通道：[架构说明](architecture.md)
- 理解模型、effort、statusline 展示来源：[展示契约](display-contracts.md)
- 维护者：n=1 硬性规则与技术债索引：[hard-rules.md](hard-rules.md)
- 查看全部配置项及其含义：`node scripts/config.js schema`（从 schema 生成，永不与代码分叉）

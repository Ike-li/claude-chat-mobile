# CLI statusline bridge 指南

CLI statusline bridge 是一个**可选、显式安装**的透明 wrapper。它把 Claude CLI 已提供给原 statusline renderer 的结构化状态写成按会话隔离的本机快照，供 Web 在只读镜像 CLI 会话时显示。

Web 自己驾驶的会话不依赖它：默认直接使用 Agent SDK 状态。bridge 也不读取提示词、回复或 transcript，不负责接管会话，只采集 CLI statusline 输入中的白名单字段。

## 一、数据源如何切换

每一帧状态只有一个事实源：

| 当前状态 | `status_line.payload.source.kind` | Web 显示 |
|---|---|---|
| Web 正在驾驶 | `sdk` | Agent SDK 的 usage、模型、成本等状态 |
| Web 只读镜像 CLI，或发现会话已被外部 CLI 改写 | `cli` | 同 session、同 cwd 且仍在 TTL 内的 CLI 快照 |
| CLI 应为权威，但快照缺失、过期或校验失败 | `cli-unavailable` | 明示“CLI 状态暂不可用”及原因 |

CLI 是权威时，server 不会拿旧 SDK 字段补空缺。除当前工作目录的本机 git 状态外，两条状态构建路径不做字段级混拼。

wrapper 会把原 renderer 的 stdin、stdout、stderr 和退出码保持透明。由 Web Agent SDK 启动的 CLI 子进程会带 `CCM_STATUSLINE_ORIGIN=web-sdk`；wrapper 此时仍运行原 renderer，但不写快照，避免 Web 子进程覆盖真实终端会话的状态。

两个开关的边界不同：

- `CLI_STATUSLINE_BRIDGE=off`：server 回滚为 SDK-only 状态栏；不卸载 wrapper，也不停止终端侧写快照。改后必须重启 server。
- `WEB_STATUSLINE=off`：关闭整个 Web 状态栏，不再发送或显示 `status_line`；bridge 安装状态不变。

## 二、安装前检查

安装器要求 `~/.claude/settings.json` 已有非空的 `statusLine.command`。它包装现有 renderer，不替你创建 renderer，也不改变 `refreshInterval`。

在仓库目录运行：

```bash
npm run statusline:status
```

`status` 是只读操作，不创建 manifest，也不改 Claude settings。输出状态含义：

| 状态 | 含义 | 下一步 |
|---|---|---|
| `not-installed` | 没有 bridge manifest | 确认现有 statusLine 正常后再安装 |
| `installed` | 当前 command 和 refreshInterval 都与 manifest 一致 | 无需重复安装 |
| `drifted` | 安装后 command 或 refreshInterval 被改过 | 先人工核对，勿强行覆盖 |

安装命令会把当前 Node 和仓库脚本的绝对路径写进 wrapper。移动仓库或更换 Node 路径前，先卸载；移动完成后再重新安装。

## 三、显式安装与启用

```bash
npm run statusline:install
npm run statusline:status
```

安装不会由 `npm install`、`npm start` 或 server 启动隐式触发。成功安装时会：

1. 把原 `statusLine.command` 与原 `refreshInterval` 记录到 `~/.claude/ccm/statusline-v1/install-manifest.json`。
2. 用透明 wrapper 替换 `statusLine.command`，保留其余 Claude settings。
3. 将 settings 与 manifest 原子写为 `0600`；重复安装幂等，不会再套一层 wrapper。

安装命令本身不会重载已打开的 Claude CLI，也不会重启 Web server。完成后：

1. **退出并重新打开 Claude CLI 会话。** 已打开的 CLI 是否热加载 `statusLine` 不作保证，只有重开后才能确定 wrapper 生效。
2. **重启正在运行的 server 进程。** 不要另起一个 `npm start` 与常驻服务争抢端口；按实际部署方式重启：

```bash
# macOS LaunchAgent
launchctl kickstart -k gui/$(id -u)/<your-server-label>

# Linux user systemd
systemctl --user restart <your-server-service>
```

常驻部署的完整命令见 [deployment.md](deployment.md#运维速查)。手工前台运行时，停止原进程后用原启动命令重新启动。

重开 CLI 后让该会话至少渲染一次 statusline，再从 Web 只读打开同一 session：

- CLI 驾驶时应显示 `source CLI`。
- Web 接管并发送消息后应切回 `source Web SDK`。
- 可用 `node scripts/doctor.js` 检查安装态；它不会替你安装或改写 settings。

## 四、自定义快照目录

默认目录是：

```text
~/.claude/ccm/statusline-v1/snapshots
```

同一操作系统用户启动 CLI 与 server 时通常不需要修改。若要自定义，必须使用**同一个绝对路径**，并同时放进两边的环境：

```bash
# server 的 .env
CLI_STATUSLINE_DIR=/absolute/private/path/ccm-statusline

# 启动 claude CLI 的 shell
export CLI_STATUSLINE_DIR=/absolute/private/path/ccm-statusline
claude
```

只写进项目 `.env` 不够：Claude CLI 不会自动读取本项目的 `.env`。同样，只在终端 `export` 也不够：常驻 server 可能拿不到该 shell 的环境。

修改目录后必须重开 CLI、重启 server。新目录会在 CLI 第一次产出有效 statusline 时创建；旧目录中的快照不会自动迁移或删除。不要使用相对路径、symlink、多人共享目录或宽权限网络目录。

## 五、TTL、权限与失败关闭

每个 session 使用 session ID 的 SHA-256 作为文件名，避免不同会话共用同一快照。写入使用唯一临时文件、`fsync` 和原子 `rename`，不会把半截 JSON 暴露给 reader。

在 macOS/Linux 上，安全边界是：

- 快照目录必须是普通目录且权限恰为 `0700`。
- 快照必须是普通文件且权限恰为 `0600`。
- 单个快照最大 64 KiB。
- 内容必须通过 schema、source、session ID、cwd 和时间校验。
- 目录或快照文件是 symlink 时拒绝读取。

TTL 根据原 statusline 刷新周期计算：

```text
TTL = min(180 秒, max(30 秒, 2 × refreshInterval + 5 秒))
```

未提供或提供非法刷新周期时按 60 秒计算，即 TTL 为 125 秒。超过 TTL 的快照标为 `stale`；server 明示 CLI 状态不可用，不回退到 SDK 陈值。

安装器对 dotfiles 也采用 fail-closed：若 `~/.claude`、安装目录、`settings.json` 或 manifest 路径中的受管节点是 symlink，`status`、`install`、`uninstall` 会报错而不是跟随链接或替换链接。使用 symlink 管理 dotfiles 时，不要为了安装而删除链接；保留 SDK-only 模式，或先自行审计并手工管理配置。

快照只保存 statusline 白名单字段，例如 session/cwd、模型、effort、thinking、上下文用量、成本、额度窗口和 CLI 版本；不保存提示词、回复正文或工具输入。

## 六、卸载与回滚

### 快速回滚 Web 数据源

在 server 环境或 `.env` 中设置：

```bash
CLI_STATUSLINE_BRIDGE=off
```

然后重启 server。Web 会立即回到 SDK-only 状态栏。这是运行时回滚，不修改 `~/.claude/settings.json`；终端 wrapper 仍会执行原 renderer 并继续写快照。

要重新启用，清空或删除该变量后再次重启 server。

### 完整卸载 wrapper

```bash
npm run statusline:status
npm run statusline:uninstall
```

卸载采用 CAS（compare-and-swap）保护：只有当前 `statusLine.command` **和** `refreshInterval` 都仍与安装态一致时，才恢复 manifest 中记录的原值。成功后会删除 manifest；原来没有 `refreshInterval` 时会恢复为没有该字段。

若状态是 `drifted`，卸载会拒绝覆盖并完整保留当前 settings 与 manifest。此时不要删除 manifest 或反复安装：先备份两份文件，比较 manifest 的 `originalCommand`、`originalRefreshInterval`、`installedCommand` 与当前 settings，再人工合并安装后产生的用户改动。安装器没有 `--force` 绕过 CAS。

卸载后重开 Claude CLI，才能确定恢复后的原 renderer 已生效。若 Web 还需要在 CLI 驾驶时保持旧的 SDK-only 行为，应同时保留 `CLI_STATUSLINE_BRIDGE=off` 并重启 server；否则 server 会在快照过期后正确显示 `cli-unavailable`。

卸载不会删除已有快照。确认所有 CLI 已重开、server 已完成回滚后，可自行核对并清理实际快照目录；不要在路径不确定时递归删除 `~/.claude/ccm`。

## 七、排错速查

| 现象 | 检查 |
|---|---|
| `status` 报 `not-installed` | 先确认 `~/.claude/settings.json` 有可用的 `statusLine.command`，再显式安装 |
| `status` 报 `drifted` | command 或 refreshInterval 已变化；保留 manifest，按 CAS 回滚步骤人工核对 |
| Web 显示 `CLI 状态暂不可用 (missing)` | 重开 CLI；让该 session 渲染一次 statusline；核对 CLI 与 server 的快照目录是否一致 |
| 显示 `stale` | 确认 CLI 仍在运行并持续刷新；若要调整 refreshInterval，先卸载、修改，再重新安装 |
| 显示 `insecure` | 检查目录 `0700`、文件 `0600`，并确认目录和文件都不是 symlink |
| 显示 `cwd-mismatch` / `session-mismatch` | 不要复制或改名快照；从 Web 打开与 CLI 相同的 session 和工作目录 |
| CLI 原 statusline 异常 | wrapper 会透传原 renderer 的 stderr 与退出码；先直接验证 manifest 中的 `originalCommand` |
| 改环境变量后无变化 | 自定义目录需重开 CLI；server 侧的 `CLI_STATUSLINE_BRIDGE`、`CLI_STATUSLINE_DIR`、`WEB_STATUSLINE` 都需重启 server |

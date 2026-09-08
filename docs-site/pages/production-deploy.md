# 生产部署
> LaunchAgent、命名隧道、Access 2FA、CCM_DATA_DIR。

- **Part**: 第六部分 · 部署与运维
- **Reading Time**: ~14 min
- **Estimated Tokens**: ~1121

---

生产形态是基于登录 Shell 托管的常驻守护进程与端到端安全网络通道：确保关掉终端终端后台不掉线，自动维持与电脑终端完全一致的 `PATH`、环境变量与登录凭据。

## 生产架构拓扑

```mermaid
flowchart LR
  Phone["手机端 PWA"] --> PublicEdge["公网边界 (Cloudflare / 反向代理)"]
  PublicEdge -->|"加密隧道 / 反代"| Local["localhost:3000"]
  Local --> CCMServer["CCM 常驻服务 (LaunchAgent / systemd)"]
  CCMServer --> NativeCLI["本机 claude CLI & 宿主环境"]
```

 通过 Cloudflare Access（2FA）或独立反向代理直连  
    局域网 / 本机  内网可直接通过 `http:// :3000/#token=...` 连入  
    常驻守护  通过 macOS LaunchAgent 或 Linux systemd，支持崩溃自愈与开机自启  
 

## macOS 生产常驻与菜单栏应用 (CCM.app)

在 macOS 上，推荐使用项目原生提供的两套生产管理入口：

1. 原生状态栏应用 CCM.app： ```
# 编译并安装原生 Swift 菜单栏应用至 /Applications/CCM.app
npm run app:install
``` 支持在系统顶部菜单栏一键查看 Server 状态、一键重启、一键扫码在手机打开当前会话，并支持工作区快速切换。
2. 标准常驻服务 CLI 驱动： ```
npm run service:install   # 渲染 plist 模板并注册入 launchd 系统服务
npm run service:status    # 检查服务运行态、PID 与日志位置
npm run service:restart   # 一键热重启常驻服务进程
```

> **WARNING:** macOS 常驻启动命令约束 — desktop/launchd/server.plist.template 中的启动命令为 exec   app/server.js，必须与 app/src/ops/service-units.js 解析常驻进程后缀的代码逐字严格一致，改动一侧必须同步另一侧。

## Linux 常驻部署 (systemd)

在 Linux 服务器或无头工作站上，建议注册为 systemd 用户服务（`~/.config/systemd/user/ccm.service`）：

```
[Unit]
Description=Claude Chat Mobile Service
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/code/claude-chat-mobile
ExecStart=%h/.nvm/versions/node/v20.x/bin/node app/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

## 运维铁律与管理边界

- 端口防撞： 常驻服务已经占用 3000 端口时，切勿在终端重复敲 npm start 。需要临时排查请在菜单栏点重启或执行 npm run service:restart 。
- 配置生效时机： 改动 ccm.config.json 中的 PORT 、 AUTH_TOKEN 或 ACCESS_PROFILE 必须重启服务；仅修改 WORKDIRS 工作区列表支持热加载生效。
- 反代安全配置： 公网反代必须显式设置 ACCESS_PROFILE=reverse-proxy 并声明 TRUSTED_PROXY ，严防客户端伪造 X-Forwarded-For 绕过鉴权。

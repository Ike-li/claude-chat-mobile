# 快速开始
> 安装、setup、doctor、局域网与临时隧道。

- **Part**: 第六部分 · 部署与运维
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1081

---

最短可跑路径：依赖安装、结构化配置、doctor 健康自检、启动服务。局域网访问必须配置 `AUTH_TOKEN`；公网暴露推荐使用临时隧道或生产拓扑。

> **NOTE:** English —  Install path for non-Chinese readers: English Quickstart（与 README.en.md 对齐）。

## 环境前置准备

- Node.js ≥ 20（通过 node --version 验证，要求纯 ESM 规范支持）。
- 本机已安装并且可正常登录交互的 claude CLI（ which claude 确认可寻址）。
- 平台支持：推荐 macOS（完整支持桌面菜单栏与 LaunchAgent）或 Linux（支持 systemd 与容器化部署）。

## 装机与运行四步走

1. 克隆仓库与确认依赖： ```
git clone https://github.com/Ike-li/claude-chat-mobile.git
cd claude-chat-mobile
npm install
```
2. 初始化结构化配置： ```
# 交互式装机向导：生成高强 AUTH_TOKEN、配置工作区、建立 ccm.config.json
npm run setup

# 或者使用非交互式配置 CLI 直接初始化：
node scripts/config.js init
```
3. 运行全量环境健康自检 (Doctor)： ```
# 检查端口可用性、工作区路径有效性、CLI 二进制、网络拓扑自洽性
node scripts/doctor.js

# 若权限不规范，执行自动修复收紧权限：
node scripts/doctor.js --fix
```
4. 启动服务： ```
npm start
# 启动成功后，终端将输出控制台日志及带授权 Token 的访问 URL：
# Local:   http://localhost:3000/#token=...
# Network: http://<lan-ip>:3000/#token=...
```

## 从移动端连接的场景方案

| 连接场景 | 配置与网络路径 | 关键注意事项 |
| --- | --- | --- |
| 同一 WiFi 局域网 | 配置有效 AUTH_TOKEN ，手机浏览器访问控制台输出的局域网 IP 带 Hash URL（ http:// :3000/#token=... ） | 未配置 Token 时服务恒定只绑定 127.0.0.1 ，手机无法连入；手机首次连接需在电脑端点击批准设备（TOFU） |
| 公网临时体验 / 开启 HTTPS PWA | 另开终端执行临时隧道： cloudflared tunnel --url http://localhost:3000 | 手机端打开 Cloudflare 分配的 HTTPS 临时域名，即可满足 iOS PWA 添加到主屏幕与 Web Push 的前置条件 |
| 常驻生产部署 | 搭配 Cloudflare 命名隧道 + 2FA Access，或使用 Nginx / Tailscale 纯反代；详见 生产部署 | 推荐使用 macOS 专属的 CCM.app 菜单栏应用或 systemd 常驻守护 |

## 常用日常维护指令

```
npm run dev          # 调试热加载开发：node --watch app/server.js
npm run check        # 快速门禁流水线（零 Token，极速检查规范、边界与契约）
npm run app:install  # (macOS 专属) 编译并安装 CCM.app 到 /Applications 目录
```

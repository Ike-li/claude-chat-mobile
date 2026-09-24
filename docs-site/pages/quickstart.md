# 快速开始
> 安装、setup、doctor、局域网与临时隧道。

- **Part**: 第六部分 · 部署与运维
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1941

---

最短可跑路径：下载源码归档、装运行依赖、用装机向导生成配置、启动自检、启动服务，再从手机打开并批准这台设备。`AUTH_TOKEN` 是启动前提，没有它服务直接拒绝启动；长期公网访问另见[生产部署](production-deploy.md)。

> **NOTE:** English —  Install path for non-Chinese readers: English Quickstart（与 README.en.md 对齐）。

## 环境前置准备

- Node.js ≥ 20（ node --version ）。
- 本机的 claude CLI 能在终端里正常跑完一轮会话。官方订阅要已 /login ；第三方网关不走 Anthropic 登录，要的是 ANTHROPIC_* 真的生效（推荐写在 CLI settings 文件的 env 块，见 外部集成 ）。项目不会替你安装或登录 claude。
- macOS 或 Linux。原生 Windows 属实验路径，推荐 WSL2。macOS 另有菜单栏应用 CCM.app。

## 装机与运行

1. 下载源码归档，安装运行依赖： ```
curl -fsSL https://github.com/Ike-li/claude-chat-mobile/archive/refs/heads/master.tar.gz | tar xz
cd claude-chat-mobile-master
npm ci --omit=dev
``` master 只在发版时前进，归档就是最新发布版；测试树与维护者门禁已按 .gitattributes 裁掉。要改代码或跑测试，改用 git clone 完整仓库，同样 npm ci --omit=dev ，需要跑测试时再执行一次不带参数的 npm ci 。
2. 生成配置： ```
# 交互式装机向导：生成高强度 AUTH_TOKEN、放行工作区、问你打算怎么从手机访问，写入 ccm.config.json
npm run setup

# 或者用非交互的配置 CLI 初始化：
node scripts/config.js init
```
3. 启动自检（doctor）： ```
# 端口、工作区、claude CLI、访问方案与配置是否自洽
node scripts/doctor.js

# 配置文件权限不规范时自动收紧：
node scripts/doctor.js --fix
```
4. 启动服务： ```
npm start
# 横幅只显示掩码后的令牌，按场景给出地址，例如：
#   本机:   http://localhost:3000/#token=<YOUR_TOKEN>
#   可访问: http://<lan-ip>:3000/#token=<YOUR_TOKEN>  ← 同 WiFi 或已连隧道时可用
# 完整令牌在 ccm.config.json 里；免手输用下一步的二维码
```
5. 手机打开，批准这台设备： ```
# 把地址和令牌打成终端二维码，手机扫码进入（二维码含凭据，投屏时勿用）
node scripts/qr.js

# 新设备首次进入要批准一次
node scripts/device.js list
node scripts/device.js approve <ID>
``` 也可以在跑着 npm start 的终端里按回车批准最新的新设备、在另一台已信任的设备上点「准入」，或用 macOS 菜单栏。令牌首次进入后存进浏览器，之后免带。

> **WARNING:** 起服 ≠ 能聊天 — 令牌与设备审批只决定手机能不能进主壳；电脑终端里的 claude 能不能正常跑完一轮，才决定手机上能不能真对话。首次验收时在手机上新建会话发一条消息：只要看到 CLI 透传上来的真实结果（正常回答，或一条具体的报错）就说明链路是通的。聊不通时，先在电脑终端、同一个工作区目录下把 claude 聊通一轮，再从手机重试。

## 从移动端连接的场景方案

| 连接场景 | 配置与网络路径 | 关键注意事项 |
| --- | --- | --- |
| 同一 WiFi 局域网 | 手机打开横幅里的局域网地址，或扫 node scripts/qr.js 的二维码 | 默认监听 0.0.0.0 ；没有令牌服务不会启动，不存在「未设令牌就只绑本机」的降级路径。首次连接要批准设备 |
| 临时公网 / 要 HTTPS 装 PWA | 另开终端跑 Cloudflare Quick Tunnel： cloudflared tunnel --url http://localhost:3000 不想经 Cloudflare：装 Tailscale 后 tailscale serve --bg 3000 | PWA 与 Web Push 需要 HTTPS；iOS 还要 16.4+ 并先添加到主屏幕 |
| 长期公网 | 固定域名 + Cloudflare Tunnel + Access，或 Tailscale / 其他加密隧道 / 自建反代；详见 生产部署 | 常驻只有两条入口：headless 终端 npm start （保活方式自定），macOS 菜单栏应用 CCM.app |

## 更新

归档装的，回到当初解压的**父目录**重跑同一条 `curl … | tar xz`，再 `npm ci --omit=dev`，然后重启服务。`ccm.config.json` 与 `data/` 不在归档里，覆盖不到。`git clone` 装的照常 `git pull`。

## 常用命令

```
node scripts/doctor.js            # 启动自检；改完配置先跑一遍
node scripts/config.js schema     # 打印当前全部配置项定义
node scripts/device.js list       # 待批与已信任的设备
node scripts/qr.js --public       # 公网地址的连接二维码（受 Access 保护的域名不带令牌）
npm run app:install               # macOS：编译并安装 CCM.app 到 /Applications
```

`npm run check`、`npm test`、`npm run lint` 引用的测试树与门禁不在归档里，只在 `git clone` 的完整仓库里可用。

# 部署与运维：公网入口 + 两条启动路径

> 启动只有两条入口，互不相关：
>
> 1. **headless**：终端里 `npm start`（各平台均可用）。可自行用 tmux、systemd 或 Docker 保持运行；项目不提供这些平台的服务配置。
> 2. **macOS desktop**：`CCM.app`。常驻、崩溃拉起、看日志、改配置、重启都在菜单里。
>
> Tunnel 负责公网转发，Access 负责登录验证；它们与 CCM 的启动方式分别配置。
>
> 占位符换成你自己的值：`<your-zone>` 是 Cloudflare 托管的域（如 `example.com`），`<your-domain>` 是 CCM 的完整访问域名（如 `ccm.example.com`）；两者可以相同。`<your-team>` 是 Access 团队名，`<UUID>` 是隧道 ID。

首次本地安装先看[首次使用指南](getting-started.md)；Web/CLI 双通道与单驾驶员边界见[架构说明](architecture.md)。

让本机编程模型代配时，使用[Cloudflare 配置提示词](#把-cloudflare-配置交给模型)。它与下面的手动步骤使用同一套配置和验收。

**新装按这个顺序走，每一段完成再继续：**

1. 按首次使用指南 §1–§5 安装依赖、生成本地配置、启动 CCM，并用 `node scripts/service.js health --json` 确认本机健康。`CCM.app` 已安装不代表 server 已启动。
2. 完成本页 §0 的域名前置条件，再按 §1 创建隧道、写入转发规则并启动 `cloudflared`。
3. 按 §2 配置 Access 应用，把三项 `CF_ACCESS_*` 写回 CCM，然后重启 **server**。
4. 按 §3 设置常驻。切换启动方式前，先停止前台试跑的进程；server 和 tunnel 各保留一个。
5. 用 [逐层验收](#3b-逐层验收)核对最终常驻状态：**本机健康 → 隧道转发 → Access 登录 → 实时连接**。

## 架构

```
手机 → <your-domain>  →  Cloudflare 边缘（Access 登录验证）  →  命名隧道  →  localhost:3000 → server
```

- **公网入口**：固定域名，Cloudflare Access 把守（邮箱验证码或已配置的身份提供商），公网**不带 `#token=`**。邮箱验证码本身不等于双因素验证（2FA）。
- **两个要一直跑着的进程**（桌面端会帮你拉；headless 自己保持）：
  - server：`node app/server.js`，桌面端**经登录 shell（`zsh -lc`）启动**，会读取 `.zprofile`，但不会读取交互式终端的 `.zshrc`；先按首次使用指南把 `CLAUDE_BIN` 设为绝对路径；headless 的 `npm start` 直接继承当前终端的环境。
  - tunnel：`cloudflared` 命名隧道，把 `:3000` 投到公网域名。
- **登录验证**：通过 Access 访问公网域名时，CCM 校验 Access 的登录凭据（JWT）；本机和局域网仍使用 `AUTH_TOKEN`。
- **设备审批**：默认情况下，Access 登录成功或本机直连后无需再次审批。要让所有连接都需要审批，设置 `DEVICE_APPROVAL_SCOPE=all` 并重启 server。
- **纯 TCP 转发**：使用 `ssh -R`、frp tcp、socat 等方式时也应设置 `DEVICE_APPROVAL_SCOPE=all`。远程请求可能带着 `Host: localhost` 被识别为本机连接。设置后，可通过菜单栏、`node scripts/device.js approve <ID>` 或启动服务的交互终端批准设备。详细规则见[架构说明](architecture.md#鉴权与范围边界)。

Cloudflare 可替换为 VPN 或其他反向代理。将 `CF_ACCESS_*` 三项同时留空即可关闭 CCM 的 Access 验证；其他配置见[不用 Cloudflare 的公网入口](#不用-cloudflare-的公网入口)。

## ⚠️ 最容易忘的一点

桌面端一旦把 server 拉起来，3000 就被占着，**不要再手动 `npm start`**。改了配置或拉了新代码后，从菜单里 server 一行点「重启」。

headless 没有桌面端：在跑 `npm start` 的那个终端里停掉再起。

💡 若已设 `DEV_MODE`（配置项说明见 `node scripts/config.js schema`），web 端齿轮面板会出现「重启服务」按钮，可免上电脑一键重启。按钮只在 server 由进程管理器托管（桌面端 launchd、systemd 等）时可点：前台 `npm start` 停了没人拉起，按钮是灰的。只适合本机调试，生产对外部署建议留空，避免误触。

## 从零搭建

### 0. 前置条件 CF 账号与域名

需要 Cloudflare 账号，以及已由 Cloudflare 托管的域名（控制台称为 zone）。已有这些条件可直接进入 §1；还没有则按本节准备。

#### 0.1 注册 Cloudflare 账号

打开 [Cloudflare 注册页](https://dash.cloudflare.com/sign-up)，填写邮箱和密码，完成邮箱验证，然后登录控制台。已有账号直接登录。步骤见[官方账号说明](https://developers.cloudflare.com/fundamentals/account/create-account/)。

网站托管在后面的步骤选 **Free**；Zero Trust 也需要单独开通，本页 §2 会说明。只想临时测试、无需固定域名时，使用文末[随机隧道](#最简替代仅测试用)，可跳过账号、域名和 Access。

#### 0.2 准备一个域名

`<your-zone>` 是你购买或申请的完整域名，例如 `example.com` 或 `example.dpdns.org`；CCM 的地址可以是它下面的 `ccm.example.com` 或 `ccm.example.dpdns.org`，后者就是 `<your-domain>`。不要把服务商的公共后缀 `dpdns.org` 当成自己的域名。

| 现状 | 操作 |
|---|---|
| 已有域名 | 确认服务商允许修改域名服务器（NS），再去 §0.3。能修改 A/CNAME 记录不代表能修改 NS |
| 愿意购买域名 | 按下方 Cloudflare Registrar 步骤购买 |
| 想申请或托管免费域名 | 按[免费域名托管指南](cloudflare-free-domain.md)完成申请、填写 NS 和生效检查，再回本页 §0.5 |

**购买：** 在 Cloudflare 控制台打开 **Domain Registration → Register Domains**，搜索想要的域名，选择可注册的名称，核对首年价、续费价和自动续费设置，填写真实联系资料并完成付款及注册邮箱验证。买成功后使用 Cloudflare 的 NS，无需去别处修改；直接到 §0.4 确认状态。详见[官方购买步骤](https://developers.cloudflare.com/registrar/get-started/register-domain/)。

免费域名的完整操作集中在上述指南，以 DigitalPlat 为例；服务方的名额、费用和审核以申请页面为准。下面 §0.3–§0.4 供已有域名、尚未托管到 Cloudflare 的用户使用。

#### 0.3 把域名添加到 Cloudflare

1. Cloudflare 控制台选择 **Add a domain / Onboard a domain**，填 `<your-zone>`，套餐选 **Free**。此操作是添加 DNS 托管，不会替你注册或购买域名。
2. 检查扫描出的 DNS 记录。新域名为空正常；已有网站或邮箱的域名，要保留它们需要的记录。
3. 继续到更换 NS 的页面，复制分配给此域名的**两个完整 NS 名称**，如 `xxx.ns.cloudflare.com`。不要照抄别人的地址。

对应的[官方 DNS 托管说明](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)包含各阶段界面与常见问题。

#### 0.4 填写 NS，等域名变为 Active

在域名服务方的 **Nameservers / 域名服务器** 中填入上一步的两个 NS，替换原有 NS 并保存；不是在 DNS 记录列表里新增两条 NS 记录。若原域名启用了 DNSSEC，先按[官方切换步骤](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/#33-turn-off-dnssec)处理旧签名，再更换 NS。

回 Cloudflare 的域名 **Overview** 页面检查状态。显示 **Active（已生效）** 才继续；**Pending nameserver update** 表示还没完成，核对服务方是否已保存这两个 NS、域名是否已获批，再等待生效。不要反复创建隧道解决 NS 问题。

也可以在终端检查：

```bash
dig +short NS <your-zone>
```

结果应与 Cloudflare 分配的两个 NS 相同；没有 `dig` 时直接使用控制台检查。DNS 生效可能需要数小时，以实际状态为准。

#### 0.5 装 cloudflared

`cloudflared` 是运行隧道的命令，不是部署 Workers 的 `wrangler`。macOS 先运行 `brew --version`；没有 Homebrew 时，按 [Homebrew 官网](https://brew.sh/)安装，并执行安装末尾 **Next steps** 中为这台电脑给出的 PATH 命令，再打开新终端。

```bash
brew install cloudflared      # macOS
cloudflared --version         # 装好了应当打印版本号
```

其他平台按 [Cloudflare 官方安装文档](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)走（apt/yum 源、二进制下载都有）。

#### 0.6 确认前置条件真的齐了

```bash
cloudflared tunnel login
```

浏览器里**能看到并选中 `<your-zone>`**，才算 §0 完成——这条命令就是 §1 的第一步，选中后会往 `~/.cloudflared/` 写 `cert.pem`。

看不到你的域名，说明 zone 还没 Active，或者你登的不是加了这个域名的那个 CF 账号。回 0.4，别往下走。

### 1. 隧道（Cloudflare Tunnel）

> 下面第一条命令要求你已有 CF 账号、有域名、且 zone 已 Active。没有的话先看 [§0 前置条件](#0-前置条件-cf-账号与域名)。

本节新装统一使用**本地配置文件**：把「公网域名转到本机哪个端口」写进 `~/.cloudflared/config.yml`，与 CCM 的隧道常驻模板一致。
Cloudflare 也支持把规则保存在控制台、用 tunnel token 启动连接器；那是另一套配置入口，不能把它的启动命令与本节的凭据文件混用。需要识别已有命令时，见 [Cloudflare 对两种方式的说明](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/)。

按本节运行 `cloudflared tunnel create` 就是在创建 Tunnel；无需再到控制台点一次创建。规则按下面的 YAML 填写，完整命令说明见[Cloudflare 本地隧道教程](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)。

**第一步：创建隧道和域名记录。** `<tunnel-name>` 是自选的隧道名，例如 `claude-chat-mobile`；后面始终用同一个名字。`<your-domain>` 是手机将要访问的完整域名，例如 `ccm.example.com`。

```bash
cloudflared tunnel login
cloudflared tunnel create <tunnel-name>
cloudflared tunnel route dns <tunnel-name> <your-domain>
```

记下 `create` 输出的 UUID 和凭据 JSON 的绝对路径。`login` 生成的 `cert.pem` 用于管理隧道；运行隧道还需要 `create` 生成的 `<UUID>.json`。

**第二步：实际创建 `~/.cloudflared/config.yml` 文件。** 下面是文件正文，不是终端命令；替换 UUID、凭据路径和域名。`credentials-file` 用绝对路径，不要在 YAML 里写 `~`。

macOS 可运行 `nano "$HOME/.cloudflared/config.yml"` 打开编辑器，粘贴并修改下面的正文；按 Ctrl+O、回车保存，Ctrl+X 退出。如果文件已有其他隧道配置，先停下来核对用途，不要整份覆盖。

```yaml
tunnel: <UUID>
credentials-file: /Users/you/.cloudflared/<UUID>.json

ingress:
  - hostname: <your-domain>
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Linux 用户把凭据路径换成自己的家目录。CCM 若改过 `PORT`，这里的 `3000` 也要一起改。末尾的 404 是未匹配域名的兜底，CCM 的域名必须命中它前面的转发规则。

**第三步：先校验规则，再前台启动。**

```bash
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" ingress validate
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" ingress rule https://<your-domain>
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run <tunnel-name>
```

前两条应校验通过，且该域名命中 `http://127.0.0.1:3000`。第三条在另一个终端里保持运行，日志出现 `Registered tunnel connection` 才说明连接器已连上 Cloudflare；若出现 `No ingress rules were defined`，先修正配置文件，继续下一节不会解决它。常驻安排在 §3。

> ⚠️ `~/.cloudflared/<UUID>.json` 与 `cert.pem` 是凭据，**勿提交/泄露**。

隧道地址要在手机上打开时，二维码可以省掉手输：

```bash
node scripts/qr.js --public              # 自动解析：CF Access 域名 / 已登录的 Tailscale
node scripts/qr.js --url https://<地址>  # Quick Tunnel 的随机域名、自建反代等手动指定
```

`--public` 只认得两种地址：配置里的 `CF_ACCESS_HOSTNAME`，以及 `tailscale status` 报告的 MagicDNS 名。Quick Tunnel 的随机域名只存在于 cloudflared 自己的输出里，产品不管那个进程，只能用 `--url`。

**开了 Cloudflare Access 时，二维码里不含令牌**——那条路只认 Access 的 JWT，`AUTH_TOKEN` 不参与鉴权（见 `app/src/auth/cf-access.js` 的 `isPublicHost`），带上它只是多印一份凭据。扫码后按提示完成 Access 登录即可。`--url` 指向同一域名时也遵循这条规则。

反过来，只填了 `CF_ACCESS_HOSTNAME` 而没填 `CF_ACCESS_TEAM` / `CF_ACCESS_AUD` 时，Access 整层是关闭的、公网仍由 `AUTH_TOKEN` 独自把守——这时二维码**会**带令牌，并额外打一行告警。

token 走 URL fragment（`/#token=`），**不进 HTTP 请求行**，所以不会落进 Cloudflare 或任何中间层的访问日志。但公网二维码泄露的后果与局域网码差一个量级：局域网码还要求对方在你的 WiFi 里，公网码是全世界任何人都能接入。投屏或有旁人时不要打印。

### 2. Access（Cloudflare Zero Trust 控制台）

本节使用邮箱验证码（One-time PIN，简称 OTP），不需要另外注册 Google/Microsoft 登录应用。Cloudflare 调整菜单时，以各步链接的官方文档为准。

**第一步：开通 Zero Trust，记下团队名。**

在 Cloudflare 控制台进入 **Zero Trust**。首次进入会要求自选一个唯一团队名、选择套餐并填写付款信息；本项目选 **Zero Trust Free**，官方说明免费套餐也需要完成付款信息步骤。由用户在官方页面填写，先核对最终套餐与金额。已有组织直接使用，不必重建。详见[官方开通步骤](https://developers.cloudflare.com/learning-paths/secure-internet-traffic/initial-setup/create-zero-trust-org/)。

到 **Zero Trust → Settings → Team name and domain** 查看团队域名，例如 `myteam.cloudflareaccess.com`。后面 `CF_ACCESS_TEAM` 只填 `myteam`，不填邮箱、账号 ID 或整个网址。

**第二步：启用邮箱验证码。**

进入 **Zero Trust → Integrations → Identity providers → Add new identity provider → One-time PIN**，按页面保存。新建组织不一定已启用 OTP，不能跳过这一步；已有 One-time PIN 则直接使用。详见[官方 OTP 设置](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)。

**第三步：创建 CCM 的 Access 应用。**

1. 进入 **Zero Trust → Access controls → Applications → Create new application**，选择 **Self-hosted and private**（旧界面为 **Access → Applications → Add → Self-hosted**）。应用名可填 `Claude Chat Mobile`。
2. 选择 **Add public hostname**，填与 §1 完全相同的 `<your-domain>`。例如访问地址为 `ccm.example.com` 时，子域填 `ccm`、域选 `example.com`，路径留空，让整个站点都受保护。
3. 添加访问策略：名称自选，**Action = Allow**，**Include → Emails** 填自己要用来收验证码的完整邮箱。这里填写的是获准访问 CCM 的邮箱，不要求与 Cloudflare 管理账号相同。
4. 应用登录方式选择刚才添加的 **One-time PIN**。选择 Session Duration（登录有效期），保存应用。具体界面见[官方自托管应用步骤](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

**第四步：把三个值写回 CCM。**

在应用列表编辑刚建好的 CCM 应用，打开 **Additional settings**，复制 **Application Audience (AUD) Tag**。这是这个 Access 应用的标识，不是 Tunnel UUID、Cloudflare API token 或 CCM 的 `AUTH_TOKEN`。位置见[官方 AUD 获取说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag)。

| CCM 配置项 | 从哪里获取 | 填写格式 |
|---|---|---|
| `CF_ACCESS_HOSTNAME` | Access 应用的公网域名，与隧道规则一致 | `ccm.example.com`，不带 `https://` 或路径 |
| `CF_ACCESS_TEAM` | Zero Trust Settings 中的团队域名 | `myteam.cloudflareaccess.com` 只取 `myteam` |
| `CF_ACCESS_AUD` | CCM Access 应用的 Additional settings | 完整复制 AUD Tag |

在**项目目录**替换占位符后执行，保留原有其他配置：

```bash
node scripts/config.js set CF_ACCESS_HOSTNAME=<your-domain> CF_ACCESS_TEAM=<your-team> CF_ACCESS_AUD=<aud-tag> ACCESS_PROFILE=cloudflare
node scripts/config.js check
```

`check` 应无配置错误。这三项必须一起配置；`ACCESS_PROFILE=cloudflare` 只声明访问方案，不会在 Cloudflare 创建资源或代填参数。然后重启 **CCM server**：前台运行的在原终端按 Ctrl+C 再 `npm start`；桌面服务用菜单里的 server「重启」。

再运行 `node scripts/doctor.js`，确认不再提示 Cloudflare 三项未配齐；其他失败项也要处理。

**第五步：验证登录。**

新开无痕窗口访问 `https://<your-domain>`，输入策略允许的邮箱，收到验证码后完成登录。必须进入 **CCM 首页**才算通过；看到验证码页只说明到达了 Cloudflare。没有收到验证码时，先核对 Allow 策略邮箱、应用是否启用 OTP，再查垃圾邮件；页面说已发码不代表邮箱已获准。完整检查见 §3b。

换浏览器、无痕窗口或清除站点数据后需重新登录。以后要调整免重复登录时长，编辑此应用的 **Session Duration**。

Android 用户先完成上述连接；需要安装到主屏幕时，再按下一节给图标开 Bypass。

### 2b. Android PWA：图标必须对匿名可达

装到 Android 主屏有两种结果，差别很大：

| | WebAPK（真应用） | Shortcut（快捷方式） |
|---|---|---|
| 长按图标 | 有 ⓘ 应用信息 | 只有「移除」 |
| 系统设置里 | 独立条目 | 点进去是 Chrome |
| 通知 / 存储 | 独立管理 | 全归 Chrome 名下 |

**WebAPK 不是本地生成的**：Chrome 把 manifest 和**图标 URL** 交给 Google 的云端 minting server，由它打包签名一个真 APK 再装回来。这台服务器是匿名的、不可能有 `CF_Authorization` cookie——所以只要 Access 拦住了 `/icons/*`，它抓到的就是一张 HTML 登录页而非 PNG，打包失败，Chrome **静默回退**成 shortcut，不报任何错。

判断当前处于哪种状态（这比看长按菜单权威）：

```bash
# 部署机上跑，模拟 Google 服务器视角。要的是 image/png；
# 返回 text/html 就是被 Access 拦了 → 现在装出来必然是 shortcut
curl -sSL -o /dev/null -w "%{http_code} %{content_type}\n" https://<your-domain>/icons/icon-192.png
```

手机侧：Chrome 地址栏输 `chrome://webapks`，列表里有本应用才是 WebAPK。

**修法**——给图标建一条 Bypass 应用（Access 按最长路径优先，它会覆盖根应用的登录策略，其余路径不受影响）：

Zero Trust → Access → Applications → Add → Self-hosted，Domain 填 `<your-domain>`、Path 填 `icons`，策略选 **Bypass / Everyone**。路径应用自动覆盖其下所有子路径，不用写 `/*`。

> 策略生效有**传播延迟**：刚建完立刻 `curl` 多半还是 `text/html`，等几十秒到一两分钟再测。别据此以为没配对。

> **暴露面**：公网能拿到的只有那几张图标（外加你若一并放行 manifest（`manifest-light.webmanifest` / `manifest-dark.webmanifest`）时的应用名与主题色）。不涉及任何数据、会话或 API 通道。代价是站点用途对外可见——域名本身已能从 CT log 查到，实际增量很小。
>
> manifest 一般**不必**放行：Chrome 读它时带 cookie（`index.html` 里 `<link rel="manifest" crossorigin="use-credentials">` 就是干这个的），只有图标是服务器去抓的。先只放行 `icons`，仍失败再补。

改完必须**删掉主屏图标重新安装**——Chrome 缓存了失败结果，不会自己重试。

### 3. 让 server 一直跑着

**macOS 走桌面端。** 先在原终端用 Ctrl+C 停掉前台试跑的 server 和 tunnel，再设置常驻：

1. 先按[桌面控制台安装说明](getting-started.md#可选macos-桌面控制台)准备编译工具，再用 `npm run app:install` 把 `CCM.app` 装进 `/Applications`；打开它，在控制台安装并启动 **server 服务**。
2. 在项目终端安装并启动本节的 **tunnel 服务**（替换隧道名）：
   ```bash
   npm run service:install -- tunnel --tunnel=<tunnel-name> --cloudflared="$(command -v cloudflared)"
   npm run service:status
   node scripts/service.js health --json
   ```
3. 确认 server 与 tunnel 都在运行、本机健康检查通过，再继续逐层验收。

server 服务会随用户登录启动，并在退出后由 launchd 拉起。需要菜单栏图标也随登录出现时，再勾「开机自启（菜单栏）」；这个开关只负责图标，不能替代 server / tunnel 服务的安装。
本节由 CCM 管理隧道常驻，不要再为同一个隧道另装一份 Cloudflare 系统服务。下面的 `service:install` 是桌面端背后的同一条 CLI。

**headless**（Linux，或 Mac 上不用 GUI）：终端里 `npm start`，窗口别关。要关终端也能活，用你自己的保活方式。

桌面端和 `npm start` 都要用户登录后的会话。开机未登录就跑，不在这两条入口里。

<details>
<summary>桌面端背后的 CLI（一般不用手敲）</summary>

菜单里的安装 / 启停调的就是这些命令。SSH 上机器、人不在 GUI 前时才直接跑。

```bash
npm run service:install -- server      # node app/server.js，RunAtLoad + KeepAlive
# tunnel 与 menubar 必须带参数，光敲下面这两条会被 precheck 拒绝：
npm run service:install -- tunnel --tunnel=<隧道名> --cloudflared=<绝对路径>
npm run service:install -- logrotate   # 每天 03:47 轮转日志
npm run service:install -- menubar --app=<CCM.app 绝对路径>   # 桌面控制台随登录自启
npm run service:status
```

装出来的 label 固定是 `com.ccm.<unit>`。

</details>

<details>
<summary>手工渲染 plist（想自己掌控内容时）</summary>

仓库 `desktop/launchd/` 下有四份占位符模板，是桌面端 / `service.js` 的数据源（`scripts/service.js` 直接读它们渲染），不是可以删掉的附件。

- [`desktop/launchd/server.plist.template`](../desktop/launchd/server.plist.template) —— `node app/server.js`，经 `zsh -lc 'cd <repo> && exec <node> app/server.js'` 登录 shell 启动（`.zshrc` 里的 PATH 不会自动带入，Claude 路径用 `CLAUDE_BIN` 固定），`RunAtLoad`+`KeepAlive`，stdout/stderr 合并到 `~/Library/Logs/`。
- [`desktop/launchd/tunnel.plist.template`](../desktop/launchd/tunnel.plist.template) —— `cloudflared tunnel run <tunnel-name>`（读 §1 写好的 `~/.cloudflared/config.yml`）。
- [`desktop/launchd/log-rotate.plist.template`](../desktop/launchd/log-rotate.plist.template) —— 每天 03:47 跑 `scripts/rotate-logs.sh` 做日志轮转（copy-truncate：launchd 持 O_APPEND fd，rename 式的 newsyslog/logrotate 转出来的新文件永远是空的，机制见脚本头注；默认超 20MB 才转、gzip 保留 5 份）。
- [`desktop/launchd/menubar.plist.template`](../desktop/launchd/menubar.plist.template) —— `/usr/bin/open CCM.app`。刻意不设 `KeepAlive`（设了的话用户从菜单点「退出」会被 launchd 立刻拉起，再也关不掉）。

模板顶部列出了占位符和 `node scripts/render-plist.js` 用法。请用该脚本替换，避免路径中的空格、引号或 `&` 破坏 plist。生成后加载：

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccm.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ccm.tunnel.plist
```

⚠️ **label 一定要用 `com.ccm.<unit>`。** `service:status`、`adopt`、桌面控制台**只扫 `com.ccm.*`
前缀**，使用其他前缀的服务不会出现在这些工具中——手工装完再用工具装一次，就是两个 LaunchAgent
抢同一个端口，而工具只报告得出其中一个。手工装好之后跑一次
`npm run service:adopt -- server` 让工具接管（只写 manifest，一个字节都不碰 plist）。

</details>

#### 配置与运行数据放在仓库外

`CCM_DATA_DIR` 是受支持的状态根目录；不设置时仍兼容 `./data`。长期跑着的实例建议把它设为绝对路径，避免切分支、清理仓库或测试脚本碰到生产状态：

```bash
mkdir -p "$HOME/Library/Application Support/claude-chat-mobile/data"
chmod 700 "$HOME/Library/Application Support/claude-chat-mobile" \
  "$HOME/Library/Application Support/claude-chat-mobile/data"

# 写进项目配置（示例值请换成你的绝对路径）
# ccm.config.json: { "CCM_DATA_DIR": "/Users/you/Library/Application Support/claude-chat-mobile/data" }
```

目录保存 CCM 的会话指针/偏好、设备信任、审批、审计、推送和缓存，文件应保持 `0600`。Claude 原始 transcript 仍在 `~/.claude/projects/`，不会迁入这里；手机上传的附件落在本目录的 `uploads/<工作区桶>/` 下（2026-09-06 起——此前落在各工作目录的 `.ccm-uploads/`，那批文件不迁移也不删除，历史消息预览会自动回落过去读）。迁移前先停掉 server（桌面端菜单或 headless 那个终端）并备份，迁完跑 `node scripts/doctor.js` 再按原入口拉起。`scripts/device.js`、server 与 doctor 都读取同一 `CCM_DATA_DIR`。

### 3b. 逐层验收

按顺序检查，前一层失败先修前一层。验证常驻部署时，使用已经常驻的进程，不要临时再起一份。

#### 第一层：本机健康

在项目目录运行：

```bash
node scripts/service.js health --json
```

**通过：** `ok` 为 `true`，`health.status` 为 `ok`，`versions` 中可看到 server、SDK 与 Claude CLI 版本。这条命令读取本地配置并带鉴权请求 `/health`，无需复制令牌。
连不上先检查 server；401 检查配置与进程是否一致并重启 server。后台日志报找不到 `claude` 时，在能运行 Claude 的终端设置 `CLAUDE_BIN` 的绝对路径后重启（见首次使用指南 §3）。本机通过前，先不用查 Cloudflare。

#### 第二层：隧道转发

重跑 §1 的 `ingress validate` 和 `ingress rule`：域名必须命中 CCM 的本机地址，不能命中末尾的 `http_status:404` / `503`。再确认正在运行的连接器日志有 `Registered tunnel connection`，没有空 ingress 告警。

**本层先通过配置与连接检查；实际公网转发在下一层登录后确认。** Cloudflare 的「健康」仅说明连接器在线；Access 登录页由 Cloudflare 边缘提供，也可能在本机 server 没运行时出现。两者都不能单独证明请求已到 CCM。

改了本节的 `config.yml`，要重启 **tunnel**，server 重启不会让隧道重读文件。CCM 管理的隧道可用：

```bash
npm run service:restart -- tunnel
```

#### 第三层：Access 登录与 HTTP 转发

在手机或浏览器无痕窗口打开 `https://<your-domain>`，先完成允许邮箱的 OTP / 已配置的身份登录，再观察登录后的结果。

**通过：** 回到自己的域名并显示 **Claude Chat Mobile 首页**。仅看到验证码页不算通过。登录后若出现 503，回查第二层的规则、运行实例与日志；502 回查第一层的本机服务及转发端口；1033 检查隧道连接。不要为排错关闭 Access。

#### 第四层：实时连接

在 CCM 首页确认连接状态稳定，并出现能更新的延迟数值；文件夹与会话列表能正常加载。

**通过：** 页面加载后，实时连接也已完成鉴权，不再停在连接中或反复重连。若首页能开但一直连不上，检查 server 的 Access JWT 鉴权日志、`CF_ACCESS_TEAM/AUD`，以及中间代理是否允许 WebSocket。

这四层通过，说明手机已连接到本机 CCM。是否能正常调用模型，继续按[首次使用指南 §8](getting-started.md#8-完成首次验收)在目标工作区发送一条无副作用的消息验证；不要把页面连通当成模型调用成功。

### 把 Cloudflare 配置交给模型

模型需要能操作本机命令；配置 Cloudflare 页面还需要浏览器或相应 API 工具。缺少这些工具时，由用户按 §0、§2 完成页面操作，再让模型继续。账号注册、验证码、付款资料及手机上的检查由用户完成。

把项目目录和下面的提示词交给模型，补上已知的值；尚未拥有域名可以注明“需要申请”。

```text
帮我首次安装 claude-chat-mobile，并配置 Cloudflare 固定域名、Tunnel 和 Access 登录。
手机网址：https://<your-domain>
已有或待申请的域名：<your-zone，或“需要申请”>
允许登录的邮箱：<email>
要连接的项目文件夹：<绝对路径，或“暂不连接”>
是否设置常驻：<是/否>

先读 docs/getting-started.md 和 docs/deployment.md。检查现状，只询问缺失的信息。
按顺序完成，每步验证成功后再继续：
1. 按首次使用指南准备 Node、Claude，安装 CCM 并生成配置；没有 TTY 时使用指南中的非交互命令。
   保存 CLAUDE_BIN 的绝对路径。不要覆盖已有配置、重新生成已有 AUTH_TOKEN，或启动重复 server。
2. 先用 node scripts/service.js health --json 确认本机健康，再配置 Cloudflare。
3. 按部署指南 §0 注册账号、获取域名、配置 NS，确认域名在 Cloudflare 为 Active。
   注册、验证码或付款信息需要我操作时，告诉我具体页面、要做的操作和完成标志；完成后继续。
4. 新建隧道采用 §1 的本地 config.yml 和 UUID.json 方式；不要另建控制台 token 隧道或混用两套命令。
   若已有同名隧道、DNS 记录或配置文件，先核对用途和管理方式，不要直接覆盖。
   校验域名命中本机实际端口，启动连接器并检查日志；不以“隧道健康”代替转发验收。
5. 按 §2 初始化 Zero Trust、启用 OTP、创建只允许指定邮箱的 Access 应用。
   获取 HOSTNAME、TEAM 和应用 AUD，写入 CCM 配置并检查，重启 server。
6. 若要求常驻，按 §3 配置；切换前先停前台进程，只保留一份 server 和 tunnel。
   macOS 使用 CCM 的服务工具，不另装第二份 cloudflared 系统服务。
7. 按 §3b 逐层检查：本机健康 → 隧道转发 → Access 登录 → 实时连接。
   浏览器或手机必须在 Access 登录后进入 CCM，且实时延迟更新。需要设备审批时让我核对设备。
8. 最后告诉我网址、启动方式、日志位置，以及每一层实测通过还是待验证。
   模型对话由我按首次使用指南 §8 验证；未经验证不要报告“能正常聊天”。

本任务只配置，不修改项目源码。不要为排错关闭鉴权、Access 或扩大邮箱放行范围。
令牌、隧道凭据和证书保存在本机，不写入报告或提交到仓库。
```

### 4. 通知（可选：ntfy + 深链）

ntfy 是可选的另一套通知服务，不影响安装与聊天。还没部署 ntfy 时，先按[官方安装文档](https://docs.ntfy.sh/install/)准备服务，再填写下面的连接信息；只用 CCM 的 Web Push 可以跳过本节。

移动端锁屏 / 息屏时，Web Push 在 iOS 上受限（须先"添加到主屏幕"、且局域网 http 下不可用）。配 ntfy 可绕开：server 端一行 POST 到 ntfy 服务，手机装 ntfy app 订阅 topic 即收锁屏通知。全在启动 shell 或配置文件注入：

```
NTFY_URL=https://ntfy.example.com   # 你自托管的 ntfy 实例
NTFY_TOPIC=<私密-topic>
NTFY_TOKEN=<可选：私有实例的访问令牌>
PUBLIC_URL=https://<your-domain>    # 点通知深链回该会话；留空回退 CF_ACCESS_HOSTNAME
```

- 不配 ntfy 则优雅缺席，只剩 Web Push；Web Push 本身也要先配 VAPID 才启用，见 [getting-started.md](getting-started.md#开启-web-push)。
- ⚠️ ntfy 的**正文恒最小化**（不含命令、参数、问题正文或 summary——`previewBody` 只发给 Web Push，见 `app/src/server/app.js` 的 `emitNotify`）；**标题只有「事件 · 项目」两段**，不带会话标题——没有 AI 生成标题时，会话标题就是你某条消息的原文。Web Push 端到端加密，标题照旧带会话标题（「事件 · 项目 · 会话」三段，`formatNotifyIdentity`），方便分辨同一项目的多条会话。工作区目录名仍会明文经第三方，故仍务必**自托管 ntfy 或用私密 topic + `NTFY_TOKEN`**，勿用公共 `ntfy.sh` 的裸 topic。
- 改这些 env 后须**重启 server** 才生效（见下「运维速查」）。

## 运维速查

按你用的那条入口操作，不要手敲 `launchctl`。

```bash
# headless：停掉当前 npm start，再起
# 桌面端：菜单里 server 一行点「重启」；日志用「查看日志」

# 人在 SSH 里、服务却是桌面端装的（不是第三条入口）
npm run service:status
npm run service:restart -- server
npm run service:logs -- server
node scripts/service.js stop server
node scripts/service.js start server
```

<details>
<summary>service.js 失灵时（直接问 launchd）</summary>

工具自己坏了才走这里。label 必须是 `com.ccm.<unit>`，见上面手工装那节。

```bash
launchctl print gui/$(id -u)/com.ccm.server
launchctl kickstart -k gui/$(id -u)/com.ccm.server
launchctl bootout    gui/$(id -u)/com.ccm.server
launchctl bootstrap  gui/$(id -u) ~/Library/LaunchAgents/com.ccm.server.plist
```

</details>

## 排错速查

| 现象 | 处理 |
|---|---|
| Cloudflare 拒绝添加域名 / 提示不是可注册域 | 后缀不在 Public Suffix List 里，免费版加不了（CF 的子域独立成 zone 是 Enterprise）。按 §0.2 的 `grep` 查一下，换一个在表里的后缀 |
| zone 一直停在 Pending Nameserver Update | NS 没生效：`dig +short NS <your-domain>` 看返回的是不是 CF 那两个。仍是旧值就回域名服务方后台核对填没填对，再等传播（几分钟到几十分钟） |
| `cloudflared tunnel login` 浏览器里看不到你的域名 | zone 没 Active（见上一行），或登错了 CF 账号——换账号重登。**别跳过这步往下配**，后面每步都会失败且看不出原因 |
| `cloudflared tunnel route dns` 报权限 / zone 不存在 | 该域名的 zone 不在当前账号下。`cert.pem` 是 `tunnel login` 时写的，换过账号要删掉 `~/.cloudflared/cert.pem` 重新 login |
| 隧道显示健康，Access 登录后却返回 503 | 连接器在线但可能没有加载 CCM 的转发规则。按 §1 检查规则命中与空 ingress 告警，修改本地配置后重启 tunnel；按[逐层验收](#3b-逐层验收)定位 |
| 公网 502 / 1033 | 502 先确认本机 CCM 健康、规则里的地址和端口正确；1033 检查连接器是否仍连接 Cloudflare。见[逐层验收](#3b-逐层验收) |
| OTP 登录后首页能开，但实时连接失败 | 检查 WebSocket 和 JWT：server 日志搜 `[http-auth] 鉴权失败（access_jwt）`（socket 握手侧是 `[conn] … 握手鉴权`），核对 `CF_ACCESS_TEAM/AUD` 与 CF 应用是否一致 |
| 手机进不去登录页 | 检查 DNS / 隧道日志有无 `Registered tunnel connection` |
| Android 装的 PWA 长按只有「移除」、系统设置点进去是 Chrome | 装成了 shortcut 而非 WebAPK：Access 拦了 `/icons/*`，Google 打包服务器抓不到图标。见 §2b，给图标加 Bypass 后删图标重装 |
| PWA 仍装成 shortcut（长按只有「移除」），但 §2b 的 `curl` 已返回 `image/png` | 安装那一刻手机连不上 Google：WebAPK 由 Google 服务器打包、再经 Google Play 装回手机，任一步连不上，Chrome 都会退回 shortcut 且不报错。在 Google 服务受限的网络里，先开代理（Chrome、Google Play 商店、Google Play 服务都要走代理），再删图标重装 |
| 开着代理装，Chrome 通知一直停在「正在安装」 | Chrome 已把安装交给 Google Play，Play 还在忙别的下载（实测是正在更新 Chrome 本身），这次安装一直轮不到。到 Play 的「管理应用和设备」停掉或等完进行中的更新，再从 Chrome 重新安装 |
| 改了配置不生效 | `ccm.config.json` 中需重启的项要重启 server；本节 `config.yml` 的转发规则要重启 tunnel。两者是独立进程 |
| 公网 1033 且部署机开着全局代理/VPN | 代理的 TUN 模式劫持了 `cloudflared` 到 Cloudflare edge 的出站连接：先临时关闭系统代理/VPN 复测确认；长期共存则在代理软件里给 `cloudflared` 进程或 `*.trycloudflare.com` / `*.cloudflareaccess.com` / 你的隧道域名配置直连(bypass)规则 |
| 经第三方网关报 `model_not_found` | 模型名可能需后缀（如 `<model>[1m]`）：在工作区 `.claude/settings.local.json` 的 `env` 块写 `"ANTHROPIC_MODEL": "<带后缀名>"`（或在启动 shell `export` 后重启），或 web 端 `/model <带后缀名>` 切换（本项目配置文件里的 `ANTHROPIC_*` 启动期被剥除） |
| 回复只有工具卡片、无正文 | 网关可能不流式 → `app/src/agent/agent.js` `map()` 已有全文兜底；仍复现则带 `LOG_STDERR=1` 看子进程日志 |


## 不用 Cloudflare 的公网入口

`CF_ACCESS_HOSTNAME/TEAM/AUD` 三项留空时，`app/src/auth/cf-access.js` 整层关闭（`isPublicHost` 恒 false），
无需修改 CCM 代码。本节说明 CCM 需要调整的配置，各工具的安装方法见其官方文档。

选定方案后设置 `ACCESS_PROFILE`，让 `doctor` 和手机安全自检检查相应配置。它仅用于自检，不改变访问规则，可在装机向导、手机设置或 `node scripts/config.js set` 中修改。

- 加密 VPN：`vpn`。
- 反向代理，以及 ngrok、Quick Tunnel、Tailscale Funnel 等公开隧道：`reverse-proxy`。
- 公网 IP 加端口转发，或服务直接监听公网地址：`direct`。
- 仅局域网：`lan`；Cloudflare Tunnel + Access：`cloudflare`。

### 限制监听地址：BIND_MODE / BIND_HOST

默认监听 `0.0.0.0`，同一 WiFi 的手机可访问。所有模式都需要 `AUTH_TOKEN`，缺少时服务拒绝启动。
若你打算「本机只开 loopback，公网入口完全由自己转发」（SSH `-L`、Tailscale Serve、反代等），可以显式收窄：

| 配置 | 实际监听 | 适用 |
|---|---|---|
| 不设（默认） | `0.0.0.0` | 绝大多数情况（`AUTH_TOKEN` 是启动前提，没有它 server 直接拒绝启动） |
| `BIND_MODE=loopback` | `127.0.0.1` | 自己用 SSH/Tailscale/反代转发，不想让端口出现在局域网上 |
| `BIND_MODE=lan` | `0.0.0.0` | 显式声明要对外监听（等价于默认，但意图写在配置里） |
| `BIND_MODE=custom` + `BIND_HOST=::` | `::`（IPv4/IPv6 双栈） | 需要 IPv6 访问（默认的 `0.0.0.0` 只监听 IPv4） |
| `BIND_MODE=custom` + `BIND_HOST=<网卡地址>` | 该地址 | 只对某一块网卡开放 |

`AUTH_TOKEN` 在所有模式下都必填，包括 `loopback`。`BIND_MODE` 无效、或 `custom` 未提供 `BIND_HOST` 时，服务也会拒绝启动。修改监听配置后需重启，可用 `doctor` 核对实际地址。

### 各拓扑的明文可见方

现状下 TLS 在 Cloudflare 边缘终止，那一跳能看到明文对话与代码。若这是要消除的暴露点：

| 拓扑 | 中间节点能看到明文 | 机制 |
|---|---|---|
| Cloudflare Tunnel + Access（现状） | 能：Cloudflare | TLS 在边缘终止后回源 |
| 加密隧道 / VPN（WireGuard、Tailscale tailnet、ZeroTier、Netbird、Headscale…） | 不能 | 端到端加密；中继只转发密文，协调节点只交换公钥 |
| 自建反代（VPS + nginx / Caddy / Traefik，打洞用 frp、SSH `-R`、WireGuard 等） | 能：VPS 主机商 | TLS 在你租的那台机器上终止 |
| 托管隧道（ngrok、Cloudflare Quick Tunnel、Tailscale Funnel、localtunnel…） | **看 TLS 在哪终止**，见下节 | 服务商托管入口，本机跑一个 agent 回连 |
| 公网直连（公网 IP + 端口转发 / DMZ，或云主机绑公网口） | 无中间节点 | 客户端直接连到这台机器 |
| 不做公网，只用局域网 | 无中间节点 | 手机与 server 同网段直连 |

自建反代那行是事实陈述而非取舍建议：它**更换**了信任对象（Cloudflare → 主机商），不**消除**中间节点。
若目标是消除，只有加密隧道 / VPN、公网直连、局域网三类做得到——但公网直连是拿"没有中间节点"
换"没有前置防线"，见下文「公网直连」。

### 托管隧道（ngrok / Quick Tunnel / Funnel…）归哪一档

托管隧道选择 `ACCESS_PROFILE=reverse-proxy`。CCM 仍需令牌和设备审批；请求经本机连接器转发时，默认可能共用同一个登录限速计数。要按真实来源限速，需确认服务商会追加 `X-Forwarded-For`，再配置 `TRUSTED_PROXY=loopback`。

服务商能否看到对话内容，取决于 TLS 在哪里解密：在服务商处解密，服务商就能看到明文；端到端加密的 VPN 中，中继只转发密文。具体行为以对应工具的官方说明为准。

**Tailscale 一个产品名对应两种语义相反的拓扑，需要按实际用法区分：**

| 用法 | 手机怎么连上 | 声明成 | 有没有公网面 |
|---|---|---|---|
| 设备加入 tailnet | 手机也装 Tailscale，走隧道内地址（`100.64/10`） | `vpn` | 无——未入网的设备根本触达不到 |
| Tailscale Funnel | 任何浏览器打开公开 URL | `reverse-proxy` | **有，全公网可达** |

Funnel 是公开入口，应选择 `reverse-proxy`。误选 `vpn` 会让安全自检漏掉公网文件编辑提示。

#### Tailscale 五分钟配方（`vpn` 档，不经 Cloudflare 的推荐路径）

PWA 与 Web Push 需要 HTTPS；这里由 `tailscale serve` 提供证书。CCM 提供配置说明和检测，不负责安装或启动 Tailscale。

1. 按 [Tailscale 官方入门步骤](https://tailscale.com/docs/how-to/quickstart)注册账号，在电脑与手机安装并登录**同一个账号**。手机入网后就能触达电脑的隧道内地址（`100.x.y.z`）。
2. 在电脑上看 MagicDNS 名：`tailscale status`，形如 `<机器名>.<tailnet>.ts.net`。
   `node scripts/doctor.js` 的 TAILSCALE 项会直接打印 `https://` 地址与下一步命令。
3. 拿 HTTPS：`tailscale serve --bg 3000`（端口换成你的 `PORT`）。电脑上只跑一次，之后
   `https://<机器名>.<tailnet>.ts.net` 就指向本机的 3000。若提示 HTTPS 未启用，去管理台 DNS 页打开
   「HTTPS Certificates」再跑。
4. 手机打开 `https://<机器名>.<tailnet>.ts.net/#token=<AUTH_TOKEN>`，批准设备审批，装 PWA。
5. 配置里声明 `ACCESS_PROFILE=vpn`；要收通知就把 `PUBLIC_URL` 设成上面那个 `https://` 地址。

**别顺手开 Funnel。** `tailscale funnel` 会把这个地址暴露到全公网，那是另一档拓扑（`reverse-proxy`，见上表）；
`serve` 只在 tailnet 内可达，未入网的设备根本触达不到端口。

设备审批照常：Host 是 MagicDNS 名而不是 localhost，不会触发本机免审；`CF_ACCESS_*` 留空，自动启用设备审批。
登录限速在 `tailscale serve` 下**合桶**：Serve 是跑在 tailscaled 里的本地反代，固定把请求代理到 `127.0.0.1:<PORT>`，
CCM 看到的连接 IP 是 127.0.0.1，整个 tailnet 的设备共用一个限速桶（一台输错几次会把另一台一起锁住；
桶里只有你自己的设备，通常可接受）。别为此开 `TRUSTED_PROXY`：Serve 虽然会覆盖写 `X-Forwarded-For`、采信本身安全，
但那个开关只对 `reverse-proxy` 档放行，`vpn` 档下 doctor 会对它告警。要逐设备分桶就让手机直连裸隧道地址
`http://100.x.y.z:<PORT>`，代价是没有 HTTPS。

**托管隧道特有的一条：URL 会漂。** Quick Tunnel 和 ngrok 免费档每次启动分配的域名可能不同。
`PUBLIC_URL` 是通知深链的来源（见下节），域名一变就指向失效地址——通知照常送达，点开却打不开。
要长期用，选带固定域名的档位；临时用则每次改 `PUBLIC_URL`，或干脆别配通知。
另外这类入口**没有入网门槛**：URL 泄露即全公网可达，上一段说的"限速桶全塌"在这里比自建反代更值得在意
（自建反代至少还能在入口层加一道认证）。

### 换掉入口后，CCM 侧的四处连带变化

这四条对**所有**非 Cloudflare 方案共通，与选哪种拓扑无关。默认验证方式是 **`AUTH_TOKEN` + 逐设备审批**，
对所有拓扑相同；Cloudflare Access 可用于验证公网身份：开着时它管的公网 Host 改认 Access 身份（替代 `AUTH_TOKEN`，
缺省也替代设备审批），关着时回到基线、自动启用设备审批，两种方式都保留访问验证。下表说明各自使用的凭据、设备审批和限速方式。

| | Access 验证开启 | `CF_ACCESS_*` 留空后 |
|---|---|---|
| Cloudflare Access（可选的身份验证） | 公网 Host 强制 Access JWT，fail-closed | **不生效**；基线不变。想再加一层可在入口层自行补（反代类拓扑） |
| `AUTH_TOKEN` | LAN/本机走它 | 不变，全部请求走它 |
| 设备审批 | 被 Access 跳过 | **需要审批**，每台新设备批准一次 |
| 登录限速粒度 | per 真实来源（`CF-Connecting-IP`，IPv6 按 /64） | 反代类**默认按连接 IP 合桶**；反代自己追加 `X-Forwarded-For` 时可声明 `TRUSTED_PROXY=loopback` 按末跳分桶。direct 与直连裸隧道地址的 vpn 天然分桶；经 `tailscale serve` 这类本地反代的 vpn 同反代档合桶 |

后两行需要展开：

**关闭 Access 验证后，新设备需要审批。** `shouldBypassDeviceApproval`（`app/src/auth/rate-limiter.js`）先判 `deviceApprovalScope === 'all'` 返回 false，
紧接着 `if (accessEnabled) return true`——**缺省**下 Access 与设备审批是替代关系而非叠加
（声明 `DEVICE_APPROVAL_SCOPE=all` 可让两者叠加）。失去 Access 不等于防护归零。
反代进来的请求也会被正确判成「非本机」：peer 虽是 `127.0.0.1`，但 Host 是公网域名，不满足 bypass 条件。

**限速桶默认会合并，拆桶要显式声明。** `shouldTrustCfConnectingIp` 要求 `publicHost` 为真，而该条件在
三项留空时恒 false，于是 `rlSourceKey` 回落到连接 IP。**反代终止在 loopback 后，所有公网客户端的连接 IP
都是 `127.0.0.1`，默认共用同一个限速桶**——一个来源试错触发的退避会波及其余客户端。

要按真实来源分桶，设 `TRUSTED_PROXY=loopback`：此时 CCM 取反代**追加**的 `X-Forwarded-For` **末跳**作为
限速来源（`xff:` 前缀；IPv6 同样按 /64 归桶）。两个前提缺一不可，缺了就回落合桶，不会报错：

- 反代必须 `proxy_pass` 到 `127.0.0.1`（peer 不是 loopback 时不采信）；
- **反代必须自己追加/改写该头**（nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，
  Caddy / Traefik 默认就是这样）。

**这项不是「反代就能开」**：没配转发头的 nginx 会把客户端自带的 `X-Forwarded-For` 原样转发，
`ssh -R`、frp tcp 之类纯 TCP 转发同理——那时整条头都是客户端写的，开了等于让攻击者自己填限速桶，
限速形同虚设，比合桶更糟。服务端分不出「反代追加的」和「客户端自带的」，所以它只能是你确认过
反代行为后的显式 opt-in，不随 `ACCESS_PROFILE=reverse-proxy` 自动打开。`doctor` 的 D21 会在
反代档未开时提示合桶、在别的档开着或写错值时告警。

手机直连裸隧道地址的 VPN 与公网直连两类不受影响：连接 IP 就是客户端本身（隧道内地址 / 真实公网 IP），天然分桶——
公网直连甚至是全部拓扑里限速粒度最准的一个，代价见下节。VPN 若经 `tailscale serve` 这类本地反代接入
（它固定代理到 127.0.0.1），则与反代档一样合桶，见上文「Tailscale 五分钟配方」。

限速桶还有第二个合并维度，与选哪种拓扑无关：**IPv6 客户端按 /64 前缀归桶**（`ipRateBucket`）。
终端用户拿到的最小分配就是一整个 /64，逐地址计桶等于换个源地址就重置失败计数、暴破限速形同虚设。
代价是同一 /64 内的多台设备共用一个桶——一台连错到阈值会连累同网段其他设备锁 15 分钟。
IPv4 不受影响，仍按整地址分桶。

### 通用落地要点

**共通前提**（所有非 Cloudflare 拓扑都适用）：

- 必须设 `AUTH_TOKEN`。未设时 server **拒绝启动**（hard-rules §1「鉴权是启动前提」），
  不是降级绑 `127.0.0.1`——任何拓扑都得先有令牌。
- PWA 与 Web Push 需要安全上下文（HTTPS，或 `localhost`）。裸 IP 的 `http://` 能正常聊天，
  但装不了 PWA、收不到 Web Push，通知只能退回 ntfy（见上节）。
- 将 `CF_ACCESS_*` 三项同时留空。配置面板会要求确认关闭 Access 验证；换好入口后再确认，并更新 `ACCESS_PROFILE`。

- **要用通知就必须显式设 `PUBLIC_URL`。** 深链地址是 `PUBLIC_URL` 优先、回落 `CF_ACCESS_HOSTNAME`
  （`app/src/ops/notify-channels.js` 的 `publicUrl`）——两个都没有时通知仍正常送达，但**不带 click，点了不跳转**。
  该项的配置说明写的是「留空回退到 CF_ACCESS_HOSTNAME」，对本节场景等同于「留空即没有」。
- **启动日志的「可访问」几行会列出隧道内地址。** 地址枚举（`app/src/shared/net-addr.js` 的 `reachableIPv4s`）
  按**地址段**判定、不看接口名，所以 macOS 上 WireGuard / Tailscale 的 `utun*` 地址会和局域网地址
  一起列出。TUN 代理占用的 RFC 2544 假段（198.18/15）与 link-local 仍被排除。
  隧道地址没出现，说明隧道本身没起来，不是日志不显示它。

**加密隧道 / VPN 类**：server 照常跑在 3000，手机经隧道内地址访问
`http://<隧道内 IP>:3000/#token=<AUTH_TOKEN>`。入网资格由隧道本身承担，未入网的设备根本触达不到端口。
要 PWA / Web Push 则需给隧道内主机名配证书——部分方案自带签发能力，其余需自行处理。

**反向代理类**：Mac 侧用任意方式把 3000 暴露给反代所在主机（frp、SSH `-R`、VPN 内网互通均可），
反代对外终止 TLS。CCM 对反代只有两项配置要求：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;

    # 保留原始 Host，供 CCM 判断访问域名；不要留空或写死为 localhost
    proxy_set_header Host $host;

    # 允许 WebSocket 升级，保持 Socket.io 实时连接
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";

    # 长连接，读超时别设过短（Socket.io 有心跳，但空闲会话仍可能被过短的超时切断）
    proxy_read_timeout 3600s;

    # 可选：要让登录限速按真实来源分桶，让 nginx **追加**（不是透传）X-Forwarded-For，
    # 再在 CCM 配 TRUSTED_PROXY=loopback。只配这一行、不开开关 = CCM 照旧不读，无副作用
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

单个 `location /` 全量代理即可，不必为 `/socket.io/` 另开一段。Caddy / Traefik 等价配置同理，
关键仍是前两条。`X-Forwarded-For` **默认不读**；只有反代自己追加它、且你显式声明
`TRUSTED_PROXY=loopback` 时才用于限速分桶（前提与反例见上节「限速桶默认会合并」）。

反向代理入口仍使用 `AUTH_TOKEN` 和设备审批。需要在请求到达 CCM 前验证身份时，可另配 mTLS、OIDC / forward auth 或 Basic Auth。

**托管隧道类**（同属 `reverse-proxy` 档，分类见上文）：不用写上面这段配置——Host 透传与
WebSocket 升级由服务商那端负责，主流几家默认就满足。本机只需 `<工具> http://localhost:3000` 之类的一条命令。
需要额外做的只有两件：`PUBLIC_URL` 填分配到的地址（换了地址要跟着改），以及尽量在入口层加一道
该服务商提供的认证（多数家有 Basic Auth / OAuth 选项，免费档常常没有）——没有的话公网就只剩
`AUTH_TOKEN` + 设备审批，而这个 URL 是任何人打开浏览器就能触达的。

**公网直连**（`ACCESS_PROFILE=direct`）：公网 IP + 路由器端口转发 / DMZ，或云主机直接绑公网口，
中间没有任何节点。它与上面几类的差别集中在两点，且方向相反：

- **暴露面最大。** 端口直接挂在公网上，扫描器会持续敲。**没有前置认证层**——Access 没有、
  反代层也没有，`AUTH_TOKEN` + 设备审批就是全部防线。因此日志里偶尔出现登录限速锁定属于正常现象，
  不是有人一定攻进来了；真要收紧就回头选一种带前置认证的拓扑，而不是在这一档上加固。
- **限速粒度最准，且不用配。** 连接 IP 就是真实客户端（IPv6 按 /64 归桶），不像反代那样默认塌成
  `127.0.0.1` 一个桶、要靠 `TRUSTED_PROXY` 拆，所以暴破退避天然逐来源生效——这是它唯一强过反代的地方。

另外三条配置注意：`BIND_MODE` **不要**设成 `loopback`（端口转发会没有转发目标，外部一台也连不上；
`doctor` 与手机端体检会把这个矛盾当场报出来）；TLS 得自己解决（没有反代替你终止，裸 `http://`
能聊天但装不了 PWA、收不到 Web Push）；`PUBLIC_URL` 填对外那个地址，家宽 IP 会漂的话得跟着更新。

**只用局域网**：不配任何入口，手机与电脑同 Wi-Fi 时访问 `http://<lan-ip>:3000/#token=<AUTH_TOKEN>`。
无中间节点，代价是离开这张网就用不了。同样别把 `BIND_MODE` 设成 `loopback`——那样同网段的手机
也连不上（这个矛盾 `doctor` 也会报）。

<details>
<summary>把入口选型与配置交给编程 agent</summary>

在仓库目录中把下面内容交给 Claude Code、Codex CLI 或其他本机编程 agent：

```text
帮我给 claude-chat-mobile 配一个不经过 Cloudflare 的公网入口。
先做选型，再落地，不要跳过选型直接开始配。

第一步，先问我这几件事，等我回答后再继续：
- 我有没有可用的 VPS / 公网 IP / 域名？
- 我需不需要 PWA 安装和 Web Push（需要就必须有 HTTPS）？
- 我能不能在手机上装客户端 app（VPN 类方案需要）？
- 我要消除中间节点，还是只要换掉 Cloudflare 就行？这两者结论不同。

第二步，基于回答在这五类拓扑里选一类，说明理由和代价，不要默认选最流行的：
- 加密隧道 / VPN（无中间节点能看到明文）
- 自建反向代理（TLS 终止在我的 VPS 上，主机商能看到明文）
- 托管隧道 ngrok / Quick Tunnel / Tailscale Funnel 等（零运维，但入口在服务商手里，
  免费档地址还会漂；明文可见方看 TLS 在哪终止，去对应文档确认，别假定）
- 公网直连，公网 IP + 端口转发（无中间节点，但也没有任何前置认证层，端口会被持续扫描）
- 只用局域网（无中间节点，出门用不了）

第三步，落地。以下是 CCM 的硬约束，配置必须满足，不满足就是错的：
1. server 监听 3000。AUTH_TOKEN 是启动前提，没设它 server 直接拒绝启动（不是降级绑 127.0.0.1）。
2. 反代必须原样透传 Host 头（nginx 里是 proxy_set_header Host $host;）。
   设备审批会检查这个请求头；不要留空或写死为 localhost。
3. 反代必须支持 WebSocket 升级（Upgrade / Connection 头），Socket.io 依赖它。
4. X-Forwarded-For 默认不读。只有反代自己追加它（nginx 的 $proxy_add_x_forwarded_for，Caddy / Traefik 默认）
   且 proxy_pass 到 127.0.0.1 时，才可在 CCM 配 TRUSTED_PROXY=loopback 让登录限速按真实来源分桶；
   ssh -R、frp tcp、没配转发头的 nginx 这类透传路径绝不能开这项——开了等于关掉限速。
5. CF_ACCESS_* 三项要留空，此时 Cloudflare Access 这层可选的身份验证不生效、自动启用设备审批；
   公网基线（AUTH_TOKEN + 设备审批）不变。如果选了反代类拓扑，提醒我可以在反代层再加一层认证。
6. PWA 与 Web Push 需要 HTTPS 或 localhost，裸 IP 的 http 下不可用。
7. 如果我要用通知，PUBLIC_URL 必须显式设成入口地址。它平时回落 CF_ACCESS_HOSTNAME，
   而这个场景下没有该值，不设就会变成「通知能收到、点击不跳转」。
8. 启动日志里「可访问」那几行会列出所有可达地址，隧道内地址（WireGuard、Tailscale）也在其中。
   如果隧道地址没出现在那里，是隧道没起来，不要绕过它去别处找地址。
9. 配完提醒我声明 ACCESS_PROFILE（vpn / reverse-proxy / direct / lan，托管隧道也是
   reverse-proxy），doctor 与手机端安全体检按它做针对性检查。注意 Tailscale 分两种：设备进
   tailnet 是 vpn，用 Funnel 暴露到公网是 reverse-proxy，按产品名对号入座会声明错。
10. 选 direct 或 lan 时 BIND_MODE 不能是 loopback（端口转发会没有转发目标），
    选 reverse-proxy 则 loopback 恰好是推荐形态。

护栏：
- 不要修改本仓库任何源码，这件事纯配置即可完成。
- 不要改 ~/.claude 下的任何文件。
- 不要把 AUTH_TOKEN 写进任何会外传的文件、日志或报告。
- 涉及安装系统级服务、改防火墙、开端口时，先告诉我要做什么，等我确认。
- 配完用鉴权后的 /health JSON 验证连通性，不要只看进程存在或端口监听。
- 第一次从新设备连接后，运行 node scripts/device.js list，让我核对再 approve。

配置说明见 docs/deployment.md 的「不用 Cloudflare 的公网入口」一节。
```

</details>

## 最简替代（仅测试用）

不想搭固定域名时，用随机隧道临时对外（每次地址变、官方仅测试用）：

> 这条路不需要域名、不需要 CF 账号、不用读 §0–§2，但**仍然需要 cloudflared**。没装过先看 [§0.5 装 cloudflared](#05-装-cloudflared)，否则下面这条命令就是 `command not found`。

```bash
cloudflared tunnel --url http://localhost:3000
# 手机打开 https://<随机域名>.trycloudflare.com/#token=<你的 AUTH_TOKEN>
```

此时不启用 Access（`CF_ACCESS_*` 留空），鉴权纯靠 `AUTH_TOKEN`。

## 看日志的两条路（都可选，都只在 macOS）

两种日志窗口的区别如下：

| | `LOG_TERMINAL`（下面这节） | 桌面控制台的「查看日志」 |
|---|---|---|
| 由谁开 | **server 自己**，每次启动时 | 你在 app 里点的时候 |
| 窗口是什么 | 真的 Terminal.app 窗口，里面跑 `tail -f` | app 内嵌的滚动视图，2 秒刷新读文件尾 |
| 需要授权 | 要，系统「自动化」控制终端 | 不要 |
| server 挂了还能用吗 | 不能（它靠 server 启动时去开） | 能，日志文件还在就读得到 |

想要「一开机就有个窗口在滚日志」用 `LOG_TERMINAL`；只是偶尔查一下用桌面控制台。

### `LOG_TERMINAL`：server 启动时自动开 Terminal 窗口

桌面端把日志写进文件（`~/Library/Logs/ccm-server.log`）；headless 默认打到终端。要文件尾跟随，在配置里设
`LOG_TERMINAL` 后，server 每次启动会自动开一个 Terminal 窗口跟随该日志，停止/重启时自动关掉它：

```bash
node scripts/config.js set LOG_TERMINAL=on    # 默认关闭
node scripts/config.js set LOG_FILE=/绝对/路径 # 只告诉日志窗口和 doctor 去哪读；不设 = ~/Library/Logs/ccm-server.log
```

窗口只是跟随那个文件，server 不会因为设了 `LOG_FILE` 就往里写。headless 直接 `npm start` 时输出留在终端，窗口会是空的；
要用它，先把输出重定向到文件（如 `npm start 2>&1 | tee -a /绝对/路径`），再让 `LOG_FILE` 指向同一个文件。

也可直接在 `ccm.config.json` 中设置 `"LOG_TERMINAL": true`。

- **仅 macOS**（靠 osascript 驱动 Terminal.app）；Linux 留空即可，设了会打一行"已跳过"。
- **首次会弹系统「自动化」授权框**，需允许控制「终端」；拒绝后 server 照常跑，只是开不出窗口（日志会提示怎么开）。
- 只关自己开的那个窗口（按窗口 id 记在 `<CCM_DATA_DIR>/log-terminal.json`），绝不碰你自己的终端窗口。
- 窗口里带一个看门狗：server 被 `kill -9` 或崩掉时，窗口内的 `tail` 会自行退出并留一行「server 已停止」，
  不会假装还在跑；那个窗口会在下次启动时被清掉。

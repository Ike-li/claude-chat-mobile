# 运维与排错
> 按入口重启、看日志、两种体检、常见故障。

- **Part**: 第六部分 · 部署与运维
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~1660

---

常驻服务的日常运维速查、高频故障排查与两种体检。改了配置不生效，绝大多数情况是没有重启服务。

## 常用运维指令速查

```
# 1. 配置查看与修改
node scripts/config.js get PORT
node scripts/config.js set ACCESS_PROFILE reverse-proxy
node scripts/config.js schema

# 2. 启动自检
node scripts/doctor.js

# 3. 重启：按你用的那条入口
#    headless：在跑 npm start 的那个终端里停掉再起
#    macOS 桌面端：菜单里 server 一行点「重启」，日志用「查看日志」
#    人在 SSH 里、服务却是桌面端装的：
npm run service:status
npm run service:restart -- server
npm run service:logs -- server

# 4. 设备
node scripts/device.js list
node scripts/device.js approve <DEVICE_ID>
```

## 高频故障排错表

| 故障现象 | 最可能根因 | 排查与修复 |
| --- | --- | --- |
| npm start 立即退出，提示缺令牌 | 没有 AUTH_TOKEN ，它是启动前提 | npm run setup 生成；不存在「不设令牌先绑本机」的路径 |
| 服务起来了，手机打不开 | 地址或监听面不对 | 同 WiFi 用横幅里的局域网地址，或 node scripts/qr.js 扫码； BIND_MODE=loopback 时手机无法直连，横幅会写明，要自己转发 |
| 能进页面，但聊不通 | 电脑终端里的 claude 本身跑不通 | 手机上收到的是 CLI 透传的具体报错，说明链路是通的。先在电脑终端、同一工作区目录下把 claude 聊通一轮：官方订阅要 /login ；第三方网关检查 ANTHROPIC_* 写在哪一层，再看 doctor 的 MODEL_SETTINGS |
| 新手机一直停在待审批 | 设备审批 | node scripts/device.js approve   ，或在跑 npm start 的终端按回车、用菜单栏、在另一台已信任设备上点「准入」 |
| 公网 502 / 1033 | server 没跑，或隧道挂了 | 看 server 日志并重启；隧道日志里有没有 Registered tunnel connection ；部署机开着全局代理 / VPN 时，给 cloudflared 配直连规则 |
| OTP 登录过了，但应用连不上 | Access JWT 校验失败 | server 日志搜 [http-auth] 鉴权失败（access_jwt） （socket 握手侧是 [conn] … 握手鉴权 ），核对 CF_ACCESS_TEAM / CF_ACCESS_AUD 与 Cloudflare 应用是否一致 |
| 改了配置不生效 | 没重启 | 只有 WORKDIRS 热加载，其余都要重启 |
| Android 收不到推送 | Chromium 系推送经 Google FCM | 订阅那一刻开代理重试；宿主机要能长期访问 Google（失败会出现在抽屉「服务」小节）；不想依赖 Google 就用 ntfy |
| 第三方网关报 model_not_found | 模型名需要后缀（如  [1m] ） | 在工作区 .claude/settings.local.json 的 env 块写 ANTHROPIC_MODEL ，或在 Web 端 /model   切换 |
| 回复只有工具卡、没有正文 | 网关可能不流式 | 服务端已有全文兜底；仍复现就带 LOG_STDERR=1 看子进程日志 |
| 长时间无输出被判挂死 | IDLE_TIMEOUT_MS （默认 10 分钟） | 后台任务运行期间在途轮有看门狗豁免（有上限）；确实需要更长的静默时调大该值 |

## 两种体检的分界

 
   
    
#### CLI doctor（scripts/doctor.js）

    
启动前在电脑上跑：配置文件是否自洽、`claude` 路径、工作区与过宽根、端口、配置文件权限（`--fix` 自动收紧）、访问方案与公网配置是否矛盾、Tailscale 检测等硬条件。

   
   
    
#### 手机端安全体检（doctor-runtime.js）

    
服务启动后在「设置 → 排查」里跑，输出脱敏视图：令牌、监听面、claude 路径、工作区、配置权限、Cloudflare Access、访问方案、Tailscale、设备闸、文件编辑、推送、设备数、模型设置、被环境变量覆盖的键，以及权限放行规则里的危险项。

   
 

## 看日志

- 手机上： 「设置 → 排查」能读 server 进程日志（整段脱敏后再切行）、会话日志与安全日志；服务状态面板里有判定化告警与重启记录。
- 电脑上： headless 就是 npm start 那个终端；桌面端用菜单「查看日志」，或 npm run service:logs -- server 。

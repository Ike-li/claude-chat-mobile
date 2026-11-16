# 把免费域名托管到 Cloudflare

目标：申请或使用一个免费域名，让它在 Cloudflare 中显示 **Active（已生效）**，再用于 CCM 的固定公网地址。

这里的“托管”指由 Cloudflare 管理 DNS（域名解析）；域名仍需在申请服务商处管理和续期。本页以 [DigitalPlat](https://domain.digitalplat.org/) 为例，其他服务商也须允许修改域名服务器（NS）。

[返回首次使用指南](getting-started.md) · [继续配置 Tunnel 与 Access](deployment.md#1-隧道cloudflare-tunnel)

## 1. 准备账号，选好域名

1. 在 [Cloudflare](https://dash.cloudflare.com/sign-up) 注册账号并完成邮箱验证；已有账号直接登录。
2. 从 DigitalPlat 官网进入 Dashboard 注册账号，完成页面要求的资料和验证。步骤见[官方账号教程](https://github.com/DigitalPlatDev/FreeDomain/blob/main/documents/tutorial/platform/1.1-account-registration.md)。
3. 阅读 Dashboard 公告，进入 **Register**，输入名称、选择后缀，点 **Check availability**。检查完整域名、名额、费用和条款。申请界面见[官方注册教程](https://github.com/DigitalPlatDev/FreeDomain/blob/main/documents/tutorial/platform/1.2-domain-registration.md)。

若注册表要求填写 NS，先保留待申请的名称，完成下面第 2 步，再回来提交。**已经申请到域名的用户，直接从第 2 步开始。**

全文使用以下示例，操作时换成自己的值：

| 用途 | 示例 | 在哪里用 |
|---|---|---|
| 自己申请的完整域名 | `example.dpdns.org` | 添加到 Cloudflare；部署指南中的 `<your-zone>` |
| 手机将要访问的地址 | `ccm.example.dpdns.org` | 稍后配置 Tunnel 和 Access；部署指南中的 `<your-domain>` |
| 服务商提供的公共后缀 | `dpdns.org` | 仅用于选择后缀，不能当成自己的域名添加 |

免费名额、可选后缀、审核及续期政策以申请页面为准；不要把旧教程中的“免费、立即成功”当作承诺。

## 2. 在 Cloudflare 添加域名，复制 NS

1. 登录 Cloudflare 控制台，选择 **Add a domain / Onboard a domain**。
2. 填自己申请的完整域名，例如 `example.dpdns.org`，套餐选择 **Free**。
3. 检查扫描出的 DNS 记录。新域名为空正常；已有网站或邮箱的域名，须保留它们需要的记录。
4. 继续到更换域名服务器的页面，复制 Cloudflare 为这个域名分配的**两个 NS 名称**。以后也可以在域名的 **Overview** 页面找回。

NS 形如 `xxx.ns.cloudflare.com`，必须使用自己页面上的值。此处成功的标志是**拿到了该域名的两个 NS**；域名暂时显示 Pending 正常。对应界面见[Cloudflare 官方托管步骤](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)。

若 Cloudflare 拒绝添加，先看本页的常见问题，不要跳到 Tunnel 配置。

## 3. 回域名服务商填写 NS

在 DigitalPlat 的注册表或域名管理页找到 **Nameservers / 域名服务器**，填入刚复制的两个 NS；已有值时替换原有值，然后保存或提交申请。具体位置见[官方 NS 设置教程](https://github.com/DigitalPlatDev/FreeDomain/blob/main/documents/tutorial/platform/1.3-connect-nameservers.md)。

填写时核对：

- 每一栏是一个完整 NS 名称，不加 `https://`、路径或端口。
- 两个值都与 Cloudflare 页面一致；不要填网站 IP、`1.1.1.1` 或别人的 NS。
- 修改的是服务商的域名服务器设置，不是在 Cloudflare 的 DNS 记录列表中新增两条 NS 记录。

提交后打开 **Domain List**，确认完整域名、申请状态和到期日。待审核或被拒绝时，先按页面原因处理；仅在 Cloudflare 添加域名不会完成域名注册。

## 4. 等待 Cloudflare 显示 Active

回到 Cloudflare，打开这个域名的 **Overview** 页面：

- **Active（已生效）**：域名托管完成，可以继续。
- **Pending nameserver update**：还没完成。确认服务商已保存两个 NS、域名申请已获批，再等待生效。

也可以在终端辅助检查，先把命令中的示例域名换成自己的：

```bash
dig +short NS example.dpdns.org
```

结果应包含 Cloudflare 给你的两个 NS，顺序不限，末尾多一个 `.` 正常。没有 `dig` 时直接查看控制台；以 Cloudflare 的 **Active** 状态作为本页完成标志。

此时直接打开网址可能还没有网页：本页只完成域名托管，CCM 的转发将在下一步配置。

## 5. 用到 CCM 项目

继续[部署指南 §0.5：安装 cloudflared](deployment.md#05-装-cloudflared)，然后按顺序完成：

1. 创建 Tunnel，并把 `ccm.example.dpdns.org` 转到 CCM 的本机端口。
2. 为同一访问域名创建 Access 应用，将 `HOSTNAME / TEAM / AUD` 写回项目。
3. 设置常驻，再按[本机健康 → 隧道转发 → Access 登录 → 实时连接](deployment.md#3b-逐层验收)验收。

域名生效、隧道在线和能正常聊天是不同的检查结果，后面的验收也要完成。

## 常见问题

| 现象 | 处理 |
|---|---|
| Cloudflare 提示域名未注册或不是根域名 | 核对是否填了自己申请的 `example.dpdns.org`，以及服务商的注册状态。后缀也必须受支持；详见[Cloudflare 添加失败说明](https://developers.cloudflare.com/dns/zone-setups/troubleshooting/cannot-add-domain/) |
| 注册表先要 NS，Cloudflare 又拒绝尚未注册的名称 | 按服务商当前说明确认如何完成注册及初始 NS；不要随便填写别人的 NS。无法满足 Cloudflare 添加条件时，先解决域名申请或更换可托管的域名 |
| 服务商只允许改 A/CNAME，找不到 NS 设置 | 这类域名不适用于本文流程，需要换成允许修改 NS 的服务 |
| Cloudflare 一直 Pending | 核对服务商保存的 NS 是否正是此域名、此 Cloudflare 账号分配的两个值，确认注册已获批。仍未生效时按[官方 Pending 排查](https://developers.cloudflare.com/dns/zone-setups/troubleshooting/pending-nameservers/)处理 |
| 修改 NS 后解析失败或返回 SERVFAIL | 已有域名若启用了 DNSSEC，须按[Cloudflare 的 DNSSEC 切换步骤](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/#33-turn-off-dnssec)处理旧签名 |
| 已经 Active，但手机打不开 CCM | 继续部署指南配置 Tunnel 和 Access；本页完成不代表 CCM 已对外提供服务 |

保留申请账号，并按服务商要求续期。域名失效后，原网址也会失效。

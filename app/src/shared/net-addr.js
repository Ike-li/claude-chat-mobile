// net-addr.js —— 本机对外可达地址的枚举。叶子层，只依赖 node:os。
//
// 【为什么从 server/http.js 搬到这里】原先它只被启动横幅（server/app.js）一个消费者用，住在
// server 域没问题。scripts/qr.js 要拿同一份地址生成连接二维码时才暴露出位置不对：server 是
// 组装根、只该被 app/server.js 引用，而两处各写一份枚举逻辑必然漂移——这个仓库对同类问题的
// 处理范式见 scripts/doctor.js:126 的那条注释（要被两边用就下沉，别复制）。

import { networkInterfaces } from 'node:os';

// 手机可达的 IPv4（同 WiFi 直连，或经 WireGuard/Tailscale 之类的加密隧道）。排除：
// link-local（169.254.*）、RFC 2544 基准段（198.18/15，TUN 代理常用假网段）。
//
// 判据是**地址段**，不是接口名。曾按 /^(utun|tun|tap|ppp)/ 排除整个接口，前提是「虚拟网卡上的
// 地址手机不可达」——该前提对 VPN 类入口恰好是反的：走隧道时那个地址是手机唯一可达的。
// 且接口名是 OS 实现细节，同一个 WireGuard 在 macOS 叫 utun0、Linux 叫 wg0，旧判据只滤掉前者。
// 真正要挡的 TUN 代理假地址（198.18/15）由下面的地址段规则独立挡住，与接口名无关。
// 名字用 reachable 而非 lan：结果里可能有隧道内地址（Tailscale 的 100.x、WireGuard 的自定义段），
// 那些不是局域网地址，调用点的日志文案也不能再写「同 WiFi」。
// interfaces 可注入（默认 os.networkInterfaces()）便于单测。
export function reachableIPv4s(interfaces = networkInterfaces()) {
  return Object.values(interfaces)
    .flatMap(addrs => addrs || [])
    .filter(i => i?.family === 'IPv4' && !i.internal
      && !i.address.startsWith('169.254.')
      && !/^198\.1[89]\./.test(i.address))
    .map(i => i.address);
}

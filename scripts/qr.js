// scripts/qr.js —— 把连接地址（含 AUTH_TOKEN）打成终端二维码，省掉手机上手输 64 位 token。
//
// 【token 为什么可以进二维码】它走的是 URL fragment（`/#token=`），与 server 启动横幅同一条
// 形态。fragment 不进 HTTP 请求行，所以哪怕这个地址经过 Cloudflare、反代或任何中间层，
// token 都不会落进它们的访问日志。
//
// 【为什么必须是显式命令，不塞进启动横幅】二维码没有「安全的默认档」——不含 token 的码毫无
// 用处，所以这个命令本质上就是一次 reveal 操作（口径同 scripts/config.js:22「secret 明文绝不
// 默认离开进程」）。塞进每次启动的横幅意味着无人主动要求它也会打印，而它的暴露面比明文更糟：
// 投屏或录屏时人会本能地遮挡一串明文 token，却不会去遮一个「看起来无害」的二维码，
// 旁人手机一拍就是完整凭据。
//
// 【为什么是全块字符而不是更紧凑的半块】2026-09-09 真机实测：半块渲染（`▀` 单字符法与
// 「全黑/全白用 █ 和空格、仅混合格用 ▀▄」的四字符法）两版都扫不出来，同一个矩阵改成全块
// 立刻能扫。根因是一行文字承载两行模块做不到像素精确——终端行距会在模块之间留下横缝，
// 破坏扫码器的网格识别。代价是高度翻倍（23 行 → 45 行）且要求 90 列宽，没有别的选择。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeEnvironment } from '../app/src/ops/config.js';
import { DEFAULT_PORT } from '../app/src/ops/env-schema.js';
import { reachableIPv4s } from '../app/src/shared/net-addr.js';
import { resolveBindPlan } from '../app/src/shared/bind-host.js';
import { encodeQr } from '../app/src/shared/qrcode.js';
import { encodePng } from '../app/src/shared/png.js';
import { accessConfigured } from '../app/src/auth/cf-access.js';
import { resolvePublicTarget, protectedByAccess } from '../app/src/shared/public-target.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// 与 scripts/device.js 同一条加载路径：读错源的后果是对着一个空 token 工作，
// 而「没设 token」和「读错配置文件了」长得一模一样。
loadRuntimeEnvironment(process.env, { dir: ROOT, quiet: true });

// quiet zone 取标准值 4。逐档实测（2026-09-09，macOS Vision 解码）：2 检不出、3 和 4 可解——
// 真机扫通的那一次也是 4。为省 4 列 2 行去赌单个解码器对 3 的宽容度不划算，扫不出来的成本
// 全在用户那边，而他没有任何线索能判断是边距不够。
const QUIET = 4;
const CELL = 2;    // 每个模块占 2 列：1 列会把码压成 1:2 的竖条，扫不出来
// --png-stdout 的每模块像素数。原生窗口不受列宽约束，取够手机在屏幕上一次对焦扫到的尺寸。
const PNG_SCALE = 10;

function printHelp() {
  console.log(`
CCM 连接二维码

用法:
  node scripts/qr.js                 - 用本机可达地址生成（自动枚举）
  node scripts/qr.js --public        - 自动解析公网地址（CF Access 域名 / Tailscale MagicDNS）
  node scripts/qr.js --url <地址>    - 指定地址，如 Cloudflare Quick Tunnel 的随机域名
  node scripts/qr.js --help          - 显示此帮助
  node scripts/qr.js --png-stdout    - 输出 PNG 字节到 stdout（桌面端菜单栏用，不落盘）

二维码里含 AUTH_TOKEN。投屏、录屏或有旁人时不要打印——拍一张就是完整凭据。
`);
}

// 用 ANSI 背景色而不是前景色画方块：不依赖终端的配色方案。深色主题下用前景色画「暗模块」
// 会得到一张反色的码，部分扫码器不接受。
function render(matrix, size) {
  const n = size + QUIET * 2;
  const grid = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) grid[r + QUIET][c + QUIET] = matrix[r][c];
  const dark = '\x1b[48;2;0;0;0m' + ' '.repeat(CELL);
  const light = '\x1b[48;2;255;255;255m' + ' '.repeat(CELL);
  return grid.map(row => row.map(v => (v ? dark : light)).join('') + '\x1b[0m').join('\n');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const token = process.env.AUTH_TOKEN;
if (!token) {
  console.error('未配置 AUTH_TOKEN，无法生成连接二维码。');
  console.error('鉴权是启动前提，先跑 npm run setup 或 node scripts/config.js init 生成 token。');
  process.exit(1);
}

const urlFlag = args.indexOf('--url');
let base;
let alternatives = [];
// 默认带令牌：局域网与自建入口都由 AUTH_TOKEN 独自把守。只有确认「这个 Host 归 CF Access 管」
// 时才去掉——那条路只认 JWT、不回退令牌（cf-access.js:113），带上纯属多印一份公网可用的凭据。
let includeToken = true;
const notes = [];
const warnings = [];
const accessOpts = { cfHostname: process.env.CF_ACCESS_HOSTNAME, accessEnabled: accessConfigured() };

if (urlFlag !== -1) {
  base = args[urlFlag + 1];
  if (!base || base.startsWith('-')) {
    console.error('--url 需要一个地址，如 --url https://example.trycloudflare.com');
    process.exit(1);
  }
  base = base.replace(/\/+$/, '');
  // docs/deployment.md 教给 CF Access 用户的就是这条命令，所以它同样要过这道判据
  if (protectedByAccess(base, accessOpts)) {
    includeToken = false;
    notes.push('该域名受 Cloudflare Access 保护：公网只认 Access 的 JWT，二维码因此不含令牌。'
      + '扫码后按提示完成 2FA 登录即可。');
  }
} else if (args.includes('--public')) {
  // 只在这条分支探测 Tailscale：它要 spawn 一个进程（3s 超时），默认路径不该为此变慢。
  const { probeTailscale } = await import('../app/src/ops/doctor-runtime.js');
  const { execFileSync } = await import('node:child_process');
  // 注入一个丢弃 stderr 的 execFile：Tailscale 没装或没登录时 CLI 会往 stderr 吐
  // 「failed to connect to local Tailscale service」，而那对这条路径是纯噪音——
  // 探测不到就是探测不到，resolvePublicTarget 自会回落到别的地址或返回 null。
  const ts = probeTailscale({
    execFile: (bin, argv, opts) => execFileSync(bin, argv, { ...opts, stdio: ['ignore', 'pipe', 'ignore'] }),
  });
  const target = resolvePublicTarget({
    ...accessOpts,
    // 「在线」的判据与 doctor-checks.js 的 tailscaleDiagnostic 同源：Running 且拿得到 DNSName
    tailscaleDns: ts.found && ts.backendState === 'Running' ? ts.dnsName : '',
    port: process.env.PORT || DEFAULT_PORT,
  });
  if (!target) {
    console.error('没有可自动解析的公网地址。');
    console.error('能自动认出的只有两种：配置里的 CF_ACCESS_HOSTNAME，以及已登录的 Tailscale MagicDNS。');
    console.error('Cloudflare Quick Tunnel 的随机域名与自建反向代理请用 --url 指定——');
    console.error('那些地址只存在于隧道进程自己的输出里，产品不管那个进程，无从得知。');
    process.exit(1);
  }
  base = target.url;
  includeToken = target.includeToken;
  alternatives = target.alternatives;
  notes.push(target.note);
  if (target.warning) warnings.push(target.warning);
} else {
  const port = process.env.PORT || DEFAULT_PORT;
  // 【地址必须按 server 真正的监听计划来选】这条默认路径此前直接取第一个非回环网卡，完全不看
  // BIND_MODE / BIND_HOST。BIND_MODE=loopback 时 server 只在 127.0.0.1 上听，印出去的却是一个
  // 根本没人监听的局域网地址——扫了必然连不上，而失败现象（转圈、超时）与「手机不在同一个 WiFi」
  // 一模一样，几乎无从归因。桌面端菜单栏的「连接二维码」走的也是本脚本，同样受影响。
  const plan = resolveBindPlan({
    authToken: token,
    bindMode: process.env.BIND_MODE,
    bindHost: process.env.BIND_HOST,
  });
  if (plan.refuse) {
    console.error(`绑定配置不可用：${plan.refuse.detail}`);
    process.exit(1);
  }
  if (!plan.publiclyReachable) {
    console.error('server 只监听回环地址（BIND_MODE=loopback），局域网里没有任何地址在听它。');
    console.error('这时二维码印出来也连不上。改用隧道并 `--url <地址>` 指定，或把 BIND_MODE 换成 lan（留空同义）后重启 server。');
    process.exit(1);
  }
  if (plan.host === '0.0.0.0' || plan.host === '::') {
    // 通配绑定：每块网卡都在听，才轮得到「挑一个局域网地址」。
    const [first, ...rest] = reachableIPv4s();
    if (!first) {
      console.error('没有找到对外可达的 IPv4 地址（只有回环）。');
      console.error('手机与电脑连同一个 WiFi 后重试，或用 --url 指定隧道地址。');
      process.exit(1);
    }
    base = `http://${first}:${port}`;
    alternatives = rest.map(ip => `http://${ip}:${port}`);
  } else {
    // 绑到某一个具体地址（BIND_MODE=custom）：只有它在听，不能拿网卡枚举里的别的地址充数。
    base = `http://${plan.host.includes(':') ? `[${plan.host}]` : plan.host}:${port}`;
    alternatives = [];
  }
}

const url = includeToken ? `${base}/#token=${encodeURIComponent(token)}` : base;

let qr;
try {
  qr = encodeQr(url);
} catch (err) {
  console.error(`无法生成二维码：${err.message}`);
  console.error(`当前地址长度 ${url.length} 字节。换一个更短的域名，或直接在手机上打开该地址。`);
  process.exit(1);
}

// 说明与告警一律走 stderr：--png-stdout 那条路的 stdout 必须只有图像字节，
// 而字符渲染那条路 stderr 同样打在终端上，用户照样看得见。
for (const n of notes) console.error(`  ℹ️  ${n}`);
for (const w of warnings) console.error(`  ⚠️  ${w}`);

// --png-stdout：把 PNG 字节写到 stdout 给调用方（桌面端菜单栏）显示，不落盘、不进剪贴板。
// **这条路径下 stdout 必须只有图像字节**——混一个换行进去，NSImage 就解不出来了，
// 所以提示与错误一律走 stderr（上面那几处 console.error 已经是）。
// 原生窗口没有终端的列宽/行距约束，于是也不需要下面那道尺寸自检。
if (args.includes('--png-stdout')) {
  // 刻意不调 process.exit()：stdout 接管道时是异步的，显式 exit 可能在缓冲 flush 之前就
  // 退出、把图截断成半张。当前这张 5.6KB 恰好一次写完所以看不出来，但 PNG_SCALE 调大或
  // 地址变长就会踩上——那种 bug 的表现是「桌面端偶尔显示不出二维码」，极难归因。
  // 让进程自然结束，Node 在事件循环排空时会把缓冲写完。
  process.stdout.write(encodePng(qr.matrix, { scale: PNG_SCALE, quiet: QUIET }));
} else {
  // 宽度不够就明确拒绝，不打印一个必然扫不出来的码——给一张扫不动的图比不给更浪费时间，
  // 用户会反复对焦、换角度、换扫码 App，而问题从一开始就不在他那边。
  const needed = (qr.size + QUIET * 2) * CELL;
  const cols = process.stdout.columns || 0;
  if (cols && cols < needed) {
    console.error(`终端宽度不足：需要 ${needed} 列，当前 ${cols} 列。`);
    console.error('把窗口拉宽后重试，或用 --url 换一个更短的地址（地址越短，码越小）。');
    process.exit(1);
  }

  console.log('');
  console.log(render(qr.matrix, qr.size));
  console.log('');
  console.log(`  ${base}`);
  // 不带令牌时这句是假话——受 Access 保护的码里根本没有 token，照打会让用户以为扫了就能进
  if (includeToken) {
    console.log(`  token 已含在二维码里（fragment 形态，不会进任何中间层的访问日志）`);
  }
  if (alternatives.length) {
    console.log(`  其他可达地址：${alternatives.join('  ')}`);
    console.log('  上面的扫不通时用 --url 指定其中一个');
  }
  console.log('');
}

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
import { encodeQr } from '../app/src/shared/qrcode.js';

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

function printHelp() {
  console.log(`
CCM 连接二维码

用法:
  node scripts/qr.js                 - 用本机可达地址生成（自动枚举）
  node scripts/qr.js --url <地址>    - 指定地址，如 Cloudflare 隧道或 Tailscale 域名
  node scripts/qr.js --help          - 显示此帮助

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
if (urlFlag !== -1) {
  base = args[urlFlag + 1];
  if (!base || base.startsWith('-')) {
    console.error('--url 需要一个地址，如 --url https://example.trycloudflare.com');
    process.exit(1);
  }
  base = base.replace(/\/+$/, '');
} else {
  const port = process.env.PORT || DEFAULT_PORT;
  const [first, ...rest] = reachableIPv4s();
  if (!first) {
    console.error('没有找到对外可达的 IPv4 地址（只有回环）。');
    console.error('手机与电脑连同一个 WiFi 后重试，或用 --url 指定隧道地址。');
    process.exit(1);
  }
  base = `http://${first}:${port}`;
  alternatives = rest.map(ip => `http://${ip}:${port}`);
}

const url = `${base}/#token=${encodeURIComponent(token)}`;

let qr;
try {
  qr = encodeQr(url);
} catch (err) {
  console.error(`无法生成二维码：${err.message}`);
  console.error(`当前地址长度 ${url.length} 字节。换一个更短的域名，或直接在手机上打开该地址。`);
  process.exit(1);
}

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
console.log(`  token 已含在二维码里（fragment 形态，不会进任何中间层的访问日志）`);
if (alternatives.length) {
  console.log(`  其他可达地址：${alternatives.join('  ')}`);
  console.log('  上面的扫不通时用 --url 指定其中一个');
}
console.log('');

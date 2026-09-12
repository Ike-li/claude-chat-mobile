// qrcode.js —— QR 码编码器（字节模式 / 纠错 L / V1–V6），纯函数：字符串进，布尔矩阵出。
//
// 【为什么自己写】唯一消费者是 scripts/qr.js 的终端二维码。装机走 `npm ci --omit=dev`，加一个
// 运行时依赖等于每个用户都多拉一个包，而这里要的只是编码本身——不需要 PNG/canvas/样式那一整套。
//
// 【为什么只到 V6】V6-L 装得下 134 字节，覆盖实际会编码的全部形态：局域网 URL（~99）、
// Tailscale MagicDNS（~110）、Cloudflare Quick Tunnel 的随机域名（~128）。V7 起还要额外放
// version information 块（18 bit BCH），为一个尚未出现的场景加那段代码不值。超限直接抛错，
// 不静默降级——静默截断出来的码扫得出内容但内容是错的，比扫不出来更坏。
//
// 【format info 的位序踩过一次】按几何顺序放置时承载的是 bit14→bit0（MSB first）。写成
// LSB first 的症状极具欺骗性：三个定位角、时序、alignment 全都正常，肉眼完全看不出问题，
// 但任何解码器都读不出来——因为解码器先读 format 拿掩码，位序反了就等于拿错掩码去解整张图。
// 当时是靠 CoreImage 生成的同参数标准码逐模块 diff + BCH 校验才定位到的，不是靠读规范。

// GF(256)，本原多项式 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// 版本参数（纠错 L）。cap 是字节模式容量，恒等于 dataCodewords - 2（4 bit 模式指示 + 8 bit
// 字符计数 = 12 bit，占 2 个码字）——这个恒等式是这张表的自检，改表时先验它。
const SPEC = [
  { v: 1, size: 21, align: [], blocks: [{ n: 1, data: 19 }], ec: 7, cap: 17 },
  { v: 2, size: 25, align: [6, 18], blocks: [{ n: 1, data: 34 }], ec: 10, cap: 32 },
  { v: 3, size: 29, align: [6, 22], blocks: [{ n: 1, data: 55 }], ec: 15, cap: 53 },
  { v: 4, size: 33, align: [6, 26], blocks: [{ n: 1, data: 80 }], ec: 20, cap: 78 },
  { v: 5, size: 37, align: [6, 30], blocks: [{ n: 1, data: 108 }], ec: 26, cap: 106 },
  { v: 6, size: 41, align: [6, 34], blocks: [{ n: 2, data: 68 }], ec: 18, cap: 134 },
];

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function genPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = genPoly(ecLen);
  const res = new Array(data.length + ecLen).fill(0);
  data.forEach((b, i) => { res[i] = b; });
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gmul(gen[j], coef);
  }
  return res.slice(data.length);
}

function buildCodewords(bytes, spec) {
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(0b0100, 4);        // 字节模式
  push(bytes.length, 8);  // 字符计数指示符：V1–9 的字节模式固定 8 bit
  for (const b of bytes) push(b, 8);

  const totalData = spec.blocks.reduce((s, g) => s + g.n * g.data, 0);
  for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0); // 终止符
  while (bits.length % 8) bits.push(0);
  const dataBytes = [];
  for (let i = 0; i < bits.length; i += 8) dataBytes.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const PAD = [0xec, 0x11];
  while (dataBytes.length < totalData) dataBytes.push(PAD[(dataBytes.length - bits.length / 8) % 2]);

  const dataBlocks = [];
  const ecBlocks = [];
  let off = 0;
  for (const g of spec.blocks) {
    for (let i = 0; i < g.n; i++) {
      const blk = dataBytes.slice(off, off + g.data);
      off += g.data;
      dataBlocks.push(blk);
      ecBlocks.push(rsEncode(blk, spec.ec));
    }
  }
  // 多块时按列交错（单块退化成原样）
  const out = [];
  const maxData = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < spec.ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

function formatBits(mask) {
  const data = (0b01 << 3) | mask; // 纠错 L = 01
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

// 两份 format info 的几何顺序。第 k 个位置承载 bit(14-k)——见文件头那条踩坑记录。
function formatSlots(size) {
  const first = [];
  for (let i = 0; i <= 5; i++) first.push([8, i]);
  first.push([8, 7], [8, 8], [7, 8]);
  for (let i = 5; i >= 0; i--) first.push([i, 8]);
  const second = [];
  for (let i = 0; i <= 6; i++) second.push([size - 1 - i, 8]);
  for (let i = size - 8; i <= size - 1; i++) second.push([8, i]);
  return [first, second];
}

function buildBase(spec) {
  const { size } = spec;
  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = v; fixed[r][c] = true; };

  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = fr + r, cc = fc + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6))
        || (c >= 0 && c <= 6 && (r === 0 || r === 6))
        || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      set(rr, cc, on ? 1 : 0);
    }
  }
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
  // alignment：所有中心的组合，扣掉与三个定位角重叠的那三处
  const last = spec.align.at(-1);
  for (const ar of spec.align) for (const ac of spec.align) {
    if ((ar === 6 && ac === 6) || (ar === 6 && ac === last) || (ar === last && ac === 6)) continue;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) {
      set(ar + r, ac + c, Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0);
    }
  }
  set(4 * spec.v + 9, 8, 1); // 固定暗模块
  for (const slots of formatSlots(size)) for (const [r, c] of slots) fixed[r][c] = true;
  return { m, fixed };
}

function placeData(m, fixed, size, codewords) {
  const bitAt = i => ((i >> 3) < codewords.length ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0);
  let idx = 0, dir = -1, row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 跳过时序列
    for (;;) {
      for (let k = 0; k < 2; k++) {
        const cc = col - k;
        if (!fixed[row][cc]) m[row][cc] = bitAt(idx++);
      }
      row += dir;
      if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
    }
  }
}

function penalty(m, size) {
  let p = 0;
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map(r => r[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
  }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c];
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
  }
  const PAT = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const RPAT = [...PAT].reverse();
  const hit = (line, i, pat) => pat.every((v, k) => line[i + k] === v);
  for (let i = 0; i < size; i++) {
    const rowLine = m[i], colLine = m.map(r => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      for (const line of [rowLine, colLine]) {
        if (hit(line, j, PAT)) p += 40;
        if (hit(line, j, RPAT)) p += 40;
      }
    }
  }
  const dark = m.flat().filter(v => v === 1).length;
  p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return p;
}

/**
 * 编码为 QR 矩阵。
 * @param {string} text 待编码文本
 * @param {{mask?: number}} [opts] mask 显式指定掩码（0–7）。缺省按惩罚分自动选，
 *   传入是为了让测试能与外部实现逐模块对齐——两个实现选不同掩码时码都合法但矩阵不同。
 * @returns {{matrix: number[][], size: number, version: number, mask: number}} 1=暗模块，不含 quiet zone
 */
export function encodeQr(text, opts = {}) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const spec = SPEC.find(s => bytes.length <= s.cap);
  if (!spec) {
    throw new Error(`内容过长：${bytes.length} 字节，本编码器上限 ${SPEC.at(-1).cap} 字节（V6-L）`);
  }
  const codewords = buildCodewords(bytes, spec);
  const { size } = spec;

  const candidates = opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
  if (!candidates.every(k => Number.isInteger(k) && k >= 0 && k <= 7)) {
    throw new Error(`掩码必须是 0–7 的整数，收到 ${opts.mask}`);
  }

  let best = null;
  for (const mask of candidates) {
    const { m, fixed } = buildBase(spec);
    placeData(m, fixed, size, codewords);
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!fixed[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
    }
    const f = formatBits(mask);
    for (const slots of formatSlots(size)) {
      slots.forEach(([r, c], k) => { m[r][c] = (f >> (14 - k)) & 1; });
    }
    const score = penalty(m, size);
    if (!best || score < best.score) best = { score, matrix: m, mask };
  }
  return { matrix: best.matrix, size, version: spec.v, mask: best.mask };
}

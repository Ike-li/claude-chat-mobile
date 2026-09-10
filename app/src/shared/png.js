// png.js —— 最小 PNG 编码器（8 位灰度、无隔行），纯函数：0/1 矩阵进，PNG 字节出。
//
// 【为什么要它】桌面端菜单栏要显示连接二维码。终端里的全块字符渲染需要 90 列 × 45 行，
// 而原生窗口没有这个约束——但要把图交给 NSImage，就得是真正的图片字节。
//
// 【为什么自写而不是加依赖】只需要「一张纯黑白、无透明、无调色板的位图」这一种形态，
// 压缩交给内置 zlib。为这点功能让每个装机用户多拉一个包（`npm ci --omit=dev`）不划算。
//
// 【为什么是灰度而不是 RGB / 1 位深】二维码只有两种颜色，8 位灰度每像素 1 字节、
// 扫描线不需要按位打包，代码少一层易错的位运算；大片同色区域 deflate 后体积差别可忽略。
//
// 【与 desktop 的分工】token 明文只活在本进程：Node 侧把图渲染完，经 stdout 把 PNG 字节
// 交给菜单栏进程。这是为了保住 ccm-menubar.swift:141 那条「明文不进本进程内存」——
// 那条红线只写在注释里、没有门禁守着，改这一带时先读它。

import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC-32（IEEE 802.3，PNG 规范指定）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// chunk = 长度(4) + 类型(4) + 数据 + CRC(4)。CRC 覆盖「类型 + 数据」，不含长度字段。
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 把 0/1 矩阵编码成 PNG。
 * @param {number[][]} matrix 1=暗模块（黑），0=亮（白）
 * @param {{scale?: number, quiet?: number}} [opts] scale 每模块边长像素数；quiet 四周留白模块数
 * @returns {Buffer} PNG 字节
 */
export function encodePng(matrix, { scale = 8, quiet = 4 } = {}) {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`scale 必须是 ≥1 的整数，收到 ${scale}`);
  }
  if (!Number.isInteger(quiet) || quiet < 0) {
    throw new Error(`quiet 必须是 ≥0 的整数，收到 ${quiet}`);
  }
  const modules = matrix.length;
  const side = (modules + quiet * 2) * scale;

  // 每行 = 1 字节 filter 类型 + side 字节像素。先全填白，再涂暗模块。
  // 漏掉那个 filter 字节的话所有解码器都会把像素读错位（图像看起来是斜的）。
  const stride = side + 1;
  const raw = Buffer.alloc(stride * side, 0xff);
  for (let y = 0; y < side; y++) raw[y * stride] = 0; // filter type 0 = None

  for (let my = 0; my < modules; my++) {
    const row = matrix[my];
    for (let mx = 0; mx < modules; mx++) {
      if (!row[mx]) continue;
      const x0 = (mx + quiet) * scale;
      for (let dy = 0; dy < scale; dy++) {
        const lineStart = ((my + quiet) * scale + dy) * stride + 1;
        raw.fill(0x00, lineStart + x0, lineStart + x0 + scale);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;  // 位深
  ihdr[9] = 0;  // 颜色类型 0 = 灰度
  ihdr[10] = 0; // 压缩方法（规范只允许 0）
  ihdr[11] = 0; // 滤波方法（规范只允许 0）
  ihdr[12] = 0; // 非隔行

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

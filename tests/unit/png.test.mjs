// tests/unit/png.test.mjs —— 最小 PNG 编码器的外部契约。
//
// 【为什么在 unit/ 而不是 invariants/】PNG 字节正确性不在 tests/README.md 的编号表里：
// 它不是产品红线，错了只会让桌面端显示不出图。按 docs/testing.md 判断一，查不到编号
// 就进 unit/ 且不写「守护：」行。
//
// 【怎么保证不是自说自话】三档独立判据，都不依赖本实现自己的输出：
//   ① 文件签名与 IEND 的 CRC 是 PNG 规范里的**固定常量**（0xAE426082 全世界一样），
//      CRC32 写错了这条立刻红——不需要另写一个 CRC 实现来对照；
//   ② IDAT 用 node:zlib 的 inflateSync 解回来（zlib 是外部实现），逐像素比对原矩阵；
//   ③ 每条扫描线的首字节必须是 filter 类型 0，漏写会让所有解码器把像素读错位。
// 端到端「这张 PNG 真能被扫出原文」由 macOS Vision 验过一次，证据在 commit 的 Tested:。

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { encodePng } from '../../app/src/shared/png.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 把 PNG 拆成 chunk 列表：[{type, data, crcOk}]
function parseChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    chunks.push({ type, data, crc });
    off += 12 + len;
  }
  return chunks;
}

// 2x2 的最小矩阵：左上/右下为暗
const M = [[1, 0], [0, 1]];

test('encodePng：文件签名是 PNG 规范的 8 字节魔数', () => {
  const png = encodePng(M, { scale: 1, quiet: 0 });
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
});

test('encodePng：chunk 顺序为 IHDR → IDAT → IEND，且 IEND 的 CRC 是规范固定值', () => {
  const chunks = parseChunks(encodePng(M, { scale: 1, quiet: 0 }));
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  // 空 IEND 的 CRC32 是 PNG 规范里的常量，与本实现无关——CRC 算错了这条必红
  assert.equal(chunks[2].crc, 0xae426082, 'IEND 的 CRC 必须是 0xAE426082');
  assert.equal(chunks[2].data.length, 0);
});

test('encodePng：IHDR 声明的尺寸含 quiet zone 且按 scale 放大', () => {
  const chunks = parseChunks(encodePng(M, { scale: 3, quiet: 2 }));
  const ihdr = chunks[0].data;
  const expected = (2 + 2 * 2) * 3; // (模块数 + 两侧 quiet) * scale
  assert.equal(ihdr.readUInt32BE(0), expected, '宽');
  assert.equal(ihdr.readUInt32BE(4), expected, '高');
  assert.equal(ihdr[8], 8, '位深应为 8');
  assert.equal(ihdr[9], 0, '颜色类型应为 0（灰度）');
  assert.equal(ihdr[12], 0, '不使用隔行扫描');
});

test('encodePng：IDAT 解压后逐像素还原出矩阵，扫描线首字节均为 filter 0', () => {
  const scale = 2, quiet = 1;
  const chunks = parseChunks(encodePng(M, { scale, quiet }));
  const raw = inflateSync(chunks[1].data);
  const side = (2 + 2 * quiet) * scale;
  assert.equal(raw.length, side * (side + 1), '每行应是 1 字节 filter + side 字节像素');

  // 期望像素：quiet zone 全亮，模块区按矩阵放大
  const expectAt = (px, py) => {
    const mx = Math.floor(px / scale) - quiet;
    const my = Math.floor(py / scale) - quiet;
    if (mx < 0 || my < 0 || mx >= 2 || my >= 2) return 0xff; // quiet zone = 白
    return M[my][mx] ? 0x00 : 0xff;
  };
  for (let y = 0; y < side; y++) {
    const rowStart = y * (side + 1);
    assert.equal(raw[rowStart], 0, `第 ${y} 行的 filter 字节必须为 0`);
    for (let x = 0; x < side; x++) {
      assert.equal(raw[rowStart + 1 + x], expectAt(x, y), `像素 (${x},${y}) 不符`);
    }
  }
});

test('encodePng：非法 scale 被拒绝', () => {
  for (const bad of [0, -1, 1.5, 'a']) {
    assert.throws(() => encodePng(M, { scale: bad }), /scale/, `scale=${bad} 应被拒绝`);
  }
});

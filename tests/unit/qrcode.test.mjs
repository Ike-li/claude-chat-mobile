// tests/unit/qrcode.test.mjs —— QR 编码器的外部契约。
//
// 【为什么在 unit/ 而不是 invariants/】编码正确性不在 tests/README.md 的编号表里：它不是产品
// 红线（错了不会伤到用户数据或安全边界，只会让二维码扫不出来）。按 docs/testing.md 判断一，
// 查不到编号就进 unit/ 且不写「守护：」行。
//
// 【快照的来源与为什么不跟另一个实现逐模块比】REF_V5_MASK0 是本实现的输出，但它经 macOS
// Vision 框架（独立解码器）解码验证过、逐字节还原出 REF_URL 才被固化下来，不是盲拍的 snapshot。
// 一开始我拿 CoreImage 的 CIQRCodeGenerator 输出当期望值，结果对不上——原因不是哪边有 bug，
// 是 QR 标准允许不同的分段策略，两个都合法的编码器对同一输入可以产出不同的合法矩阵。
// 「能解码回原文」才是契约，「与某个实现逐模块相同」把实现自由度误当成了契约。
//
// 【这些用例抓得住什么】把 format info 的位序写成 LSB first（真踩过一次），码的三个定位角、
// 时序、alignment 全都正常、肉眼挑不出毛病，但任何解码器都读不出来——快照与 format 自洽两条
// 都会红。红侧注入验证见 commit 的 Tested: trailer。

import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../../app/src/shared/qrcode.js';

const REF_URL = `http://192.168.1.1:3000/#token=${'a'.repeat(64)}`;

// 掩码固定为 0：把「编码 + 纠错 + 放置 + format」与「掩码自动选择」拆成两条独立的用例，
// 否则动了惩罚分算法就会连带这条一起红，红的原因还看不出是哪一环。
const REF_V5_MASK0 = [
  '1111111000100011001100110011001111111',
  '1000001001000101110111011101101000001',
  '1011101010010000100010001000101011101',
  '1011101001001011001100110011001011101',
  '1011101001001011001100110011001011101',
  '1000001000111101110111011101101000001',
  '1111111010101010101010101010101111111',
  '0000000010010111011101110111100000000',
  '1110111110001100110011001101011000100',
  '0100010010011100110011001100001100111',
  '0001011001011010001000100010100111001',
  '1010110110001111011101110110111101011',
  '1100101110010100110011001101101100000',
  '0101010110010100110011001100101100101',
  '1011001111100010001000100010001001001',
  '1000100101010111011101110111101011010',
  '1001011110001100110011001100101001001',
  '0110010011011100110011001100101101001',
  '0100111011111010001000100010001111111',
  '1101110001101111011101110110010101010',
  '1110011110110100110011001101101101011',
  '1110000100010100110011001100101101101',
  '1010101110000010001000100010001001111',
  '0100110010110111011101110110110011010',
  '0000111111001100110011001101101001011',
  '0011100010111100110011001100101101001',
  '1000101110111010001000100010101010011',
  '0100010110101111011101110111110111010',
  '1011111000110100110011001100111110000',
  '0000000010110100110011001100100010111',
  '1111111010000010001000100011101010011',
  '1000001011010111011101110110100011001',
  '1011101010101100110011001100111111010',
  '1011101001111100110011001100110011000',
  '1011101010011010001000100010100011111',
  '1000001011101111011101110111101111010',
  '1111111011111010110011001100110111011',
];

test('encodeQr：V5 输出与经解码器验证过的基准逐行一致', () => {
  const { matrix, version, size, mask } = encodeQr(REF_URL, { mask: 0 });
  assert.equal(version, 5);
  assert.equal(size, 37);
  assert.equal(mask, 0);
  const got = matrix.map(row => row.join(''));
  for (let r = 0; r < REF_V5_MASK0.length; r++) {
    assert.equal(got[r], REF_V5_MASK0[r], `第 ${r} 行不一致`);
  }
});

// 解码器是先读 format info 拿到掩码、再据此还原整张图的。所以「声明的掩码」与「实际应用的
// 掩码」一旦不一致，码就彻底读不出来——而这恰恰是肉眼完全看不出的一类错。
function readFormat(matrix) {
  const slots = [];
  for (let i = 0; i <= 5; i++) slots.push([8, i]);
  slots.push([8, 7], [8, 8], [7, 8]);
  for (let i = 5; i >= 0; i--) slots.push([i, 8]);
  const v = slots.reduce((acc, [r, c], k) => acc | (matrix[r][c] << (14 - k)), 0);
  const raw = v ^ 0x5412;
  const data = (raw >>> 10) & 0x1f;
  // BCH(15,5) 余数自校验：位序或编码错了这里就对不上，不必信任 data 本身
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  return { ecBits: (data >> 3) & 3, mask: data & 7, bchOk: rem === (raw & 0x3ff) };
}

test('encodeQr：format info 的 BCH 校验通过，纠错等级恒为 L，声明掩码等于实际掩码', () => {
  for (let m = 0; m < 8; m++) {
    const { matrix, mask } = encodeQr(REF_URL, { mask: m });
    const f = readFormat(matrix);
    assert.ok(f.bchOk, `掩码 ${m}：format info 的 BCH 校验失败`);
    assert.equal(f.ecBits, 0b01, `掩码 ${m}：纠错等级位应为 L(01)`);
    assert.equal(f.mask, mask, `掩码 ${m}：format 声明的掩码与实际应用的不符`);
  }
});

test('encodeQr：两份 format info 内容相同（解码器只要能读到一份就能工作）', () => {
  const { matrix, size } = encodeQr(REF_URL, { mask: 3 });
  const second = [];
  for (let i = 0; i <= 6; i++) second.push([size - 1 - i, 8]);
  for (let i = size - 8; i <= size - 1; i++) second.push([8, i]);
  const v2 = second.reduce((acc, [r, c], k) => acc | (matrix[r][c] << (14 - k)), 0);
  const first = readFormat(matrix);
  const raw2 = v2 ^ 0x5412;
  assert.equal((raw2 >>> 10) & 0x7, first.mask, '第二份 format 的掩码与第一份不符');
  assert.equal(((raw2 >>> 10) >> 3) & 3, 0b01, '第二份 format 的纠错等级位应为 L(01)');
});

test('encodeQr：版本随内容长度升档', () => {
  // 左边是各版本纠错 L 下字节模式的容量上限，取自 QR 规格表
  const cases = [[17, 1], [32, 2], [53, 3], [78, 4], [106, 5], [134, 6]];
  for (const [len, expected] of cases) {
    assert.equal(encodeQr('a'.repeat(len)).version, expected, `${len} 字节应落在 V${expected}`);
    // 边界另一侧：多一个字节就该升档（V6 已是上限，单独由抛错那条覆盖）
    if (expected < 6) {
      assert.equal(encodeQr('a'.repeat(len + 1)).version, expected + 1, `${len + 1} 字节应升到 V${expected + 1}`);
    }
  }
});

test('encodeQr：超出 V6-L 容量抛错，不静默截断', () => {
  // 失败方向：宁可不给码，也不给一个扫得出内容但内容被截断的码——后者比扫不出来更坏，
  // 因为用户会拿着一个「看起来成功了」的二维码去连一个错的地址。
  assert.throws(() => encodeQr('a'.repeat(135)), /内容过长/);
  assert.doesNotThrow(() => encodeQr('a'.repeat(134)));
});

test('encodeQr：非法掩码被拒绝', () => {
  for (const bad of [-1, 8, 1.5, 'a']) {
    assert.throws(() => encodeQr('hello', { mask: bad }), /掩码必须是/, `mask=${bad} 应被拒绝`);
  }
});

test('encodeQr：三个定位角与时序图案就位', () => {
  const { matrix, size } = encodeQr(REF_URL);
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    assert.equal(matrix[fr][fc], 1, '定位角外框');
    assert.equal(matrix[fr + 1][fc + 1], 0, '定位角内圈应为亮');
    assert.equal(matrix[fr + 3][fc + 3], 1, '定位角中心应为暗');
  }
  // 时序图案：第 6 行/列在两个定位角之间必须严格明暗交替，坐标为偶即暗
  for (let i = 8; i < size - 8; i++) {
    assert.equal(matrix[6][i], i % 2 === 0 ? 1 : 0, `横向时序在第 ${i} 列错位`);
    assert.equal(matrix[i][6], i % 2 === 0 ? 1 : 0, `纵向时序在第 ${i} 行错位`);
  }
});

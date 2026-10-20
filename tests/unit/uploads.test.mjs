// tests/unit/uploads.test.mjs —— 附件校验给人看的提示文案
// 上限本身、清洗与落盘安全是 SCOPE-02 / FILES-2 / FILES-4，在 tests/invariants/uploads.test.mjs；这里只管提示怎么写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttachments, MAX_FILE_BYTES } from '../../app/src/files/uploads.js';

// 验收 O69：10MiB+1 字节被拒时提示「过大（10.0MB，单文件上限 10MB）」——四舍五入到一位小数后和上限一样，
// 读起来像没超也被拒。超了就得显示得比上限大：向上取整。
test('超限提示里的大小向上取整：刚超一个字节也不显示成和上限一样', () => {
  const justOver = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
  assert.match(validateAttachments([{ name: 'big.bin', mimeType: 'application/octet-stream', data: justOver }]), /过大（10\.1MB，单文件上限 10MB）/);
  const tenMiB = Buffer.alloc(MAX_FILE_BYTES).toString('base64');
  const oneByte = Buffer.alloc(1).toString('base64');
  assert.match(validateAttachments([
    { name: '1.bin', mimeType: 'application/octet-stream', data: tenMiB },
    { name: '2.bin', mimeType: 'application/octet-stream', data: tenMiB },
    { name: '3.bin', mimeType: 'application/octet-stream', data: oneByte },
  ]), /总量过大（20\.1MB，上限 20MB）/);
});

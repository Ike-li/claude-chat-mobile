// 「产出」tab 一行怎么显示。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputRowView, outputsOutsideText } from '../../app/public/js/logic/session-outputs.js';

const NOW = 1793990000000;
const item = over => ({ path: '/w/out/a.mp4', name: 'a.mp4', dir: 'out', at: NOW - 120000, media: 'video', size: 4, state: 'ok', ...over });

test('图标跟服务端判的媒体类型走', () => {
  assert.equal(outputRowView(item(), NOW).icon, '🎬');
  assert.equal(outputRowView(item({ media: 'image' }), NOW).icon, '🖼️');
  assert.equal(outputRowView(item({ media: 'audio' }), NOW).icon, '🎵');
  assert.equal(outputRowView(item({ media: null }), NOW).icon, '📄');
});

test('正常文件：能点，副标题是目录和时间', () => {
  assert.deepEqual(outputRowView(item(), NOW), { icon: '🎬', name: 'a.mp4', meta: 'out · 2 分钟前', openable: true });
});

test('在项目根下的文件不留孤零零的分隔符', () => {
  assert.equal(outputRowView(item({ dir: '' }), NOW).meta, '2 分钟前');
});

test('已删除：不能点，副标题说明原因', () => {
  const row = outputRowView(item({ state: 'missing' }), NOW);
  assert.equal(row.openable, false);
  assert.equal(row.meta, 'out · 已删除');
});

test('范围外数量：没有就不显示这一行', () => {
  assert.equal(outputsOutsideText(0), '');
  assert.equal(outputsOutsideText(3), '另有 3 个文件不在已连接的文件夹里');
});

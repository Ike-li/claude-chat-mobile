// tests/unit/transcript-image.test.mjs —— transcript-image.js 单测：哪些图片块可显示、引用怎么造怎么解、取图载荷怎么验。
// 这些判据被 live（agent.js）、历史（history.js）、按引用读盘（sessions/transcript-images.js）三处共用，
// 任何一处自己另写一份都会让「列表里说有图」和「取图时说没有」对不上。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_MEDIA_TYPES, IMAGE_MAX_BYTES, base64DecodedBytes, imageRefsOf, toolImageRef, userImageRef,
  parseImageRef, nthImageBlock, checkImagePayload, stripImageBlocks,
} from '../../app/src/shared/transcript-image.js';

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6X2Xb0AAAAASUVORK5CYII=';
const img = (mediaType, data = PNG_1PX) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });

test.describe('imageRefsOf', () => {
  test('工具结果里的截图：只出引用、不出 base64', () => {
    const refs = imageRefsOf([{ type: 'text', text: '截图如下' }, img('image/png')], n => toolImageRef('toolu_1', n));
    assert.equal(refs.length, 1);
    assert.deepEqual(refs[0], { ref: 't:toolu_1:0', mediaType: 'image/png', bytes: base64DecodedBytes(PNG_1PX) });
    assert.ok(!JSON.stringify(refs).includes(PNG_1PX.slice(0, 20)), '引用里带了 base64 = 又把图内联进事件了');
  });

  test('白名单外的 media_type 一律不显示（svg 能带脚本，bmp/tiff 手机浏览器未必认）', () => {
    for (const mt of ['image/svg+xml', 'image/bmp', 'image/tiff', 'text/html', '', undefined]) {
      assert.deepEqual(imageRefsOf([img(mt)], n => userImageRef('u-1', n)), [], `${mt} 不该出现在可显示列表里`);
    }
    for (const mt of IMAGE_MEDIA_TYPES) {
      assert.equal(imageRefsOf([img(mt)], n => userImageRef('u-1', n)).length, 1, `${mt} 应可显示`);
    }
  });

  test('序号按「第几个图片块」数，被拒的块也占位——取图时按同一序号回找', () => {
    const refs = imageRefsOf([img('image/svg+xml'), { type: 'text', text: 'x' }, img('image/jpeg')], n => userImageRef('u-1', n));
    assert.deepEqual(refs.map(r => r.ref), ['u:u-1:1']);
    assert.equal(nthImageBlock([img('image/svg+xml'), { type: 'text', text: 'x' }, img('image/jpeg')], 1)?.mediaType, 'image/jpeg');
  });

  test('非 base64 来源（url / file）不显示：服务端不替前端去外网取图', () => {
    const urlImg = { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } };
    assert.deepEqual(imageRefsOf([urlImg], n => userImageRef('u', n)), []);
  });

  test('超过单张上限：仍列出（前端显示占位），并标 tooLarge', () => {
    const big = 'A'.repeat(Math.ceil((IMAGE_MAX_BYTES + 3) / 3) * 4);
    const [r] = imageRefsOf([img('image/png', big)], n => toolImageRef('toolu_2', n));
    assert.equal(r.tooLarge, true);
    assert.ok(r.bytes > IMAGE_MAX_BYTES);
  });

  test('非数组 content（纯字符串结果）没有图片', () => {
    assert.deepEqual(imageRefsOf('plain text', n => userImageRef('u', n)), []);
    assert.deepEqual(imageRefsOf(null, n => userImageRef('u', n)), []);
  });
});

test.describe('base64DecodedBytes', () => {
  test('按填充位扣减', () => {
    assert.equal(base64DecodedBytes('AAAA'), 3);
    assert.equal(base64DecodedBytes('AAA='), 2);
    assert.equal(base64DecodedBytes('AA=='), 1);
    assert.equal(base64DecodedBytes(''), 0);
    assert.equal(base64DecodedBytes(PNG_1PX), Buffer.from(PNG_1PX, 'base64').length);
  });
});

test.describe('引用', () => {
  test('构造与解析互逆（含子代理提示）', () => {
    assert.deepEqual(parseImageRef(toolImageRef('toolu_01AB', 2)), { kind: 'tool', id: 'toolu_01AB', index: 2, agent: null });
    assert.deepEqual(parseImageRef(toolImageRef('toolu_x', 0, 'toolu_parent')), { kind: 'tool', id: 'toolu_x', index: 0, agent: 'toolu_parent' });
    const uuid = '1f0c2a4e-8b7d-4c1a-9e3f-0a1b2c3d4e5f';
    assert.deepEqual(parseImageRef(userImageRef(uuid, 1)), { kind: 'user', id: uuid, index: 1, agent: null });
  });

  test('畸形引用一律 null（引用来自客户端，按不可信输入处理）', () => {
    for (const bad of [
      null, 42, '', 't', 't:a', 'x:a:0', 't:../etc:0', 't:a/b:0', 't:a:-1', 't:a:1.5', 't:a:01x',
      't:a:0:', 'u:a:0:agent', `t:${'a'.repeat(300)}:0`, 't:a:100000', 't:a:0:b:c', 't: a:0',
    ]) {
      assert.equal(parseImageRef(bad), null, `${JSON.stringify(bad)} 应被拒`);
    }
  });
});

test.describe('checkImagePayload', () => {
  test('合法 png 放行并报字节数', () => {
    assert.deepEqual(checkImagePayload({ mediaType: 'image/png', data: PNG_1PX }), { ok: true, bytes: base64DecodedBytes(PNG_1PX) });
  });
  test('白名单外拒绝', () => {
    assert.equal(checkImagePayload({ mediaType: 'image/svg+xml', data: PNG_1PX }).code, 'unsupported');
  });
  test('超上限拒绝', () => {
    const big = 'A'.repeat(Math.ceil((IMAGE_MAX_BYTES + 3) / 3) * 4);
    assert.equal(checkImagePayload({ mediaType: 'image/png', data: big }).code, 'too_large');
  });
  test('非 base64 字符拒绝（会被拼进 data: URL）', () => {
    for (const data of ['abc"onerror=x', 'AAAA AAAA', '<svg>', '', 42]) {
      assert.equal(checkImagePayload({ mediaType: 'image/png', data }).code, 'malformed', JSON.stringify(data));
    }
  });
});

test.describe('stripImageBlocks（有图时的工具摘要口径）', () => {
  test('文字 + 图：只留文字，不再是一段带「base64 已省略」的 JSON', () => {
    assert.equal(stripImageBlocks([{ type: 'text', text: '第一行' }, img('image/png'), { type: 'text', text: '第二行' }]), '第一行\n第二行');
  });
  test('只有图：空串', () => {
    assert.equal(stripImageBlocks([img('image/png')]), '');
  });
  test('还有别的结构化块：保留数组，只去掉图', () => {
    const doc = { type: 'document', source: { type: 'text', data: 'x' } };
    assert.deepEqual(stripImageBlocks([doc, img('image/png')]), [doc]);
  });
  test('字符串原样', () => {
    assert.equal(stripImageBlocks('ok'), 'ok');
  });
});

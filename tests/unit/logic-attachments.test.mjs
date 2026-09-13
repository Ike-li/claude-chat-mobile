// tests/unit/logic-attachments.test.mjs —— attachments.js 纯函数单测（粘贴图片 · data URL · MIME 猜测 · 附件 chip）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAttachmentChipLabel,
  pickPasteImageFiles,
  attachmentDataUrl,
  guessImageMime,
} from '../../app/public/js/logic/attachments.js';
import { setLang } from '../../app/public/js/i18n.js';

// formatAttachmentChipLabel 内部走 t('附件')，而 setLang 是模块级全局状态、同进程内别的测试文件会改它。
// 每个 test 前重置，避免受执行顺序影响（惯例同 logic-format.test.mjs）。
test.beforeEach(() => setLang('zh'));

test.describe('formatAttachmentChipLabel —— 附件 chip 标签格式化', () => {
  test('典型输入：仅提供文件名（默认 occurrence=1，不传 sizeBytes）', () => {
    assert.equal(formatAttachmentChipLabel('screenshot.png'), 'screenshot.png');
    assert.equal(formatAttachmentChipLabel('data.csv'), 'data.csv');
  });

  test('典型输入：occurrence > 1 时追加序号 (n)', () => {
    assert.equal(formatAttachmentChipLabel('screenshot.png', 2), 'screenshot.png (2)');
    assert.equal(formatAttachmentChipLabel('photo.jpg', 5), 'photo.jpg (5)');
  });

  test('典型输入：occurrence <= 1 不追加序号', () => {
    assert.equal(formatAttachmentChipLabel('doc.pdf', 1), 'doc.pdf');
    assert.equal(formatAttachmentChipLabel('doc.pdf', 0), 'doc.pdf');
    assert.equal(formatAttachmentChipLabel('doc.pdf', -1), 'doc.pdf');
  });

  test('典型输入：不同 sizeBytes 分档格式化', () => {
    // < 1024B：输出 NB
    assert.equal(formatAttachmentChipLabel('file.txt', 1, 0), 'file.txt · 0B');
    assert.equal(formatAttachmentChipLabel('file.txt', 1, 512), 'file.txt · 512B');
    assert.equal(formatAttachmentChipLabel('file.txt', 1, 1023), 'file.txt · 1023B');

    // < 1MB (1024B ~ 1048575B)：输出 NKB，且 Math.max(1, ...) 至少 1KB
    assert.equal(formatAttachmentChipLabel('img.png', 1, 1024), 'img.png · 1KB');
    assert.equal(formatAttachmentChipLabel('img.png', 1, 1500), 'img.png · 1KB');
    assert.equal(formatAttachmentChipLabel('img.png', 1, 2048), 'img.png · 2KB');
    assert.equal(formatAttachmentChipLabel('img.png', 1, 500 * 1024), 'img.png · 500KB');
    assert.equal(formatAttachmentChipLabel('img.png', 1, 1024 * 1024 - 1), 'img.png · 1024KB');

    // >= 1MB：输出 N.NMB（保留 1 位小数）
    assert.equal(formatAttachmentChipLabel('video.mp4', 1, 1024 * 1024), 'video.mp4 · 1.0MB');
    assert.equal(formatAttachmentChipLabel('video.mp4', 1, 1.5 * 1024 * 1024), 'video.mp4 · 1.5MB');
    assert.equal(formatAttachmentChipLabel('video.mp4', 1, 10 * 1024 * 1024), 'video.mp4 · 10.0MB');
  });

  test('典型输入：同时带有序号和大小', () => {
    assert.equal(formatAttachmentChipLabel('chart.png', 3, 2048), 'chart.png (3) · 2KB');
    assert.equal(formatAttachmentChipLabel('report.pdf', 2, 2.5 * 1024 * 1024), 'report.pdf (2) · 2.5MB');
  });

  test('边界：名称为空、空白串、null、undefined 时回落到 t("附件")', () => {
    assert.equal(formatAttachmentChipLabel(''), '附件');
    assert.equal(formatAttachmentChipLabel('   '), '附件');
    assert.equal(formatAttachmentChipLabel(null), '附件');
    assert.equal(formatAttachmentChipLabel(undefined), '附件');
    // 回落且有序号和大小
    assert.equal(formatAttachmentChipLabel('', 2, 1024), '附件 (2) · 1KB');
    assert.equal(formatAttachmentChipLabel(null, 1, 500), '附件 · 500B');
  });

  test('边界：名称首尾有空白字符时应 trim', () => {
    assert.equal(formatAttachmentChipLabel('  test.png  '), 'test.png');
    assert.equal(formatAttachmentChipLabel('\nfile.txt\t', 2), 'file.txt (2)');
  });

  test('边界：非字符串类型的名称自动转为字符串处理', () => {
    assert.equal(formatAttachmentChipLabel(12345), '12345');
    assert.equal(formatAttachmentChipLabel(true), 'true');
  });

  test('边界：occurrence 的非数字与边界值转换', () => {
    assert.equal(formatAttachmentChipLabel('a.png', '3'), 'a.png (3)');
    assert.equal(formatAttachmentChipLabel('a.png', null), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', undefined), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', NaN), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', 'invalid'), 'a.png');
  });

  test('边界：sizeBytes 为 null、undefined、非有限数或无法转为数字的对象时不添加大小段', () => {
    assert.equal(formatAttachmentChipLabel('a.png', 1, null), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', 1, undefined), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', 1, NaN), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', 1, Infinity), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', 1, -Infinity), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', 1, 'not-a-number'), 'a.png');
    assert.equal(formatAttachmentChipLabel('a.png', 1, {}), 'a.png');
  });

  test('边界：sizeBytes 为 0 或可转为有限数值的输入（空串/布尔/数字字符串）添加对应大小段', () => {
    assert.equal(formatAttachmentChipLabel('a.png', 1, 0), 'a.png · 0B');
    assert.equal(formatAttachmentChipLabel('a.png', 1, '0'), 'a.png · 0B');
    assert.equal(formatAttachmentChipLabel('a.png', 1, '500'), 'a.png · 500B');
    assert.equal(formatAttachmentChipLabel('a.png', 1, ''), 'a.png · 0B'); // Number('') 为 0，是有限数
    assert.equal(formatAttachmentChipLabel('a.png', 1, false), 'a.png · 0B'); // Number(false) 为 0
  });

  test('i18n：en 语言下空名称回落到 attachment', () => {
    setLang('en');
    try {
      assert.equal(formatAttachmentChipLabel(''), 'attachment');
      assert.equal(formatAttachmentChipLabel(null, 2, 1024), 'attachment (2) · 1KB');
    } finally {
      setLang('zh');
    }
  });
});

test.describe('pickPasteImageFiles —— 从粘贴剪贴板筛选图片文件', () => {
  test('典型输入：包含一个或多个 image/* 文件', () => {
    const file1 = { name: 'pasted-image.png' };
    const file2 = { name: 'photo.jpeg' };
    const clipboardData = {
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => file1 },
        { kind: 'file', type: 'image/jpeg', getAsFile: () => file2 },
      ],
    };
    const res = pickPasteImageFiles(clipboardData);
    assert.deepEqual(res, [file1, file2]);
  });

  test('典型输入：混合文本、非图片文件、图片文件，只挑选图片文件', () => {
    const imgFile = { name: 'test.png' };
    const clipboardData = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'application/pdf', getAsFile: () => ({ name: 'doc.pdf' }) },
        { kind: 'file', type: 'image/png', getAsFile: () => imgFile },
        { kind: 'file', type: 'text/csv', getAsFile: () => ({ name: 'data.csv' }) },
      ],
    };
    const res = pickPasteImageFiles(clipboardData);
    assert.deepEqual(res, [imgFile]);
  });

  test('典型输入：纯文本粘贴或无图片时返回空数组 []', () => {
    const clipboardData = {
      items: [
        { kind: 'string', type: 'text/plain' },
        { kind: 'string', type: 'text/html' },
      ],
    };
    assert.deepEqual(pickPasteImageFiles(clipboardData), []);
  });

  test('边界：clipboardData 为 null、undefined 或空对象', () => {
    assert.deepEqual(pickPasteImageFiles(null), []);
    assert.deepEqual(pickPasteImageFiles(undefined), []);
    assert.deepEqual(pickPasteImageFiles({}), []);
  });

  test('边界：items 属性缺失、非对象或 items.length 不是数字', () => {
    assert.deepEqual(pickPasteImageFiles({ items: null }), []);
    assert.deepEqual(pickPasteImageFiles({ items: undefined }), []);
    assert.deepEqual(pickPasteImageFiles({ items: 'not-array' }), []);
    assert.deepEqual(pickPasteImageFiles({ items: {} }), []);
  });

  test('边界：items 内部包含 null/undefined 或异常条目', () => {
    const img = { name: 'valid.png' };
    const clipboardData = {
      items: [
        null,
        undefined,
        {},
        { kind: 'file', type: null },
        { kind: 'file', type: 'image/png', getAsFile: () => img },
      ],
    };
    assert.deepEqual(pickPasteImageFiles(clipboardData), [img]);
  });

  test('边界：getAsFile() 缺失、不是函数或返回 null/undefined 时跳过', () => {
    const clipboardData = {
      items: [
        { kind: 'file', type: 'image/png' }, // 无 getAsFile
        { kind: 'file', type: 'image/png', getAsFile: 'not-a-func' },
        { kind: 'file', type: 'image/png', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => undefined },
      ],
    };
    assert.deepEqual(pickPasteImageFiles(clipboardData), []);
  });

  test('边界：type 非 image/ 开头（如以 image 结尾或其它格式）不被当成图片', () => {
    const clipboardData = {
      items: [
        { kind: 'file', type: 'x-image/png', getAsFile: () => ({}) },
        { kind: 'file', type: 'not-image/jpg', getAsFile: () => ({}) },
      ],
    };
    assert.deepEqual(pickPasteImageFiles(clipboardData), []);
  });
});

test.describe('attachmentDataUrl —— 附件 data URL 构造', () => {
  test('典型输入：合法的 image/* MIME 与 base64 字符串', () => {
    const att = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' };
    assert.equal(attachmentDataUrl(att), 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');

    const attJpeg = { mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg==' };
    assert.equal(attachmentDataUrl(attJpeg), 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');

    const attSvg = { mimeType: 'image/svg+xml', data: 'PHN2Zz48L3N2Zz4=' };
    assert.equal(attachmentDataUrl(attSvg), 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
  });

  test('失败方向：非 image/* MIME 必须返回 null（拿不准就不预览，防把 PDF/二进制当图打开）', () => {
    assert.equal(attachmentDataUrl({ mimeType: 'application/pdf', data: 'JVBERi0xLjQK' }), null);
    assert.equal(attachmentDataUrl({ mimeType: 'text/plain', data: 'aGVsbG8=' }), null);
    assert.equal(attachmentDataUrl({ mimeType: 'application/octet-stream', data: 'AAAA' }), null);
    assert.equal(attachmentDataUrl({ mimeType: 'video/mp4', data: 'AAAA' }), null);
  });

  test('失败方向：data 为空字符串、非字符串或缺失时必须返回 null', () => {
    assert.equal(attachmentDataUrl({ mimeType: 'image/png', data: '' }), null);
    assert.equal(attachmentDataUrl({ mimeType: 'image/png', data: null }), null);
    assert.equal(attachmentDataUrl({ mimeType: 'image/png', data: undefined }), null);
    assert.equal(attachmentDataUrl({ mimeType: 'image/png', data: 12345 }), null);
    assert.equal(attachmentDataUrl({ mimeType: 'image/png', data: {} }), null);
    assert.equal(attachmentDataUrl({ mimeType: 'image/png' }), null);
  });

  test('边界：att 为 null、undefined、非对象类型', () => {
    assert.equal(attachmentDataUrl(null), null);
    assert.equal(attachmentDataUrl(undefined), null);
    assert.equal(attachmentDataUrl(''), null);
    assert.equal(attachmentDataUrl(123), null);
    assert.equal(attachmentDataUrl(true), null);
  });

  test('边界：mimeType 缺失、null、undefined 或非字符串', () => {
    assert.equal(attachmentDataUrl({ data: 'abc' }), null);
    assert.equal(attachmentDataUrl({ mimeType: null, data: 'abc' }), null);
    assert.equal(attachmentDataUrl({ mimeType: undefined, data: 'abc' }), null);
    assert.equal(attachmentDataUrl({ mimeType: 123, data: 'abc' }), null);
  });
});

test.describe('guessImageMime —— 根据文件名扩展名猜测图片 MIME 类型', () => {
  test('典型输入：标准常见图片格式扩展名查表', () => {
    assert.equal(guessImageMime('photo.png'), 'image/png');
    assert.equal(guessImageMime('photo.jpg'), 'image/jpeg');
    assert.equal(guessImageMime('photo.jpeg'), 'image/jpeg');
    assert.equal(guessImageMime('animated.gif'), 'image/gif');
    assert.equal(guessImageMime('banner.webp'), 'image/webp');
    assert.equal(guessImageMime('picture.avif'), 'image/avif');
    assert.equal(guessImageMime('apple.heic'), 'image/heic');
    assert.equal(guessImageMime('apple.heif'), 'image/heif');
    assert.equal(guessImageMime('bitmap.bmp'), 'image/bmp');
    assert.equal(guessImageMime('vector.svg'), 'image/svg+xml');
  });

  test('典型输入：大小写不敏感', () => {
    assert.equal(guessImageMime('PHOTO.PNG'), 'image/png');
    assert.equal(guessImageMime('Image.JPG'), 'image/jpeg');
    assert.equal(guessImageMime('IMAGE.JPEG'), 'image/jpeg');
    assert.equal(guessImageMime('ANIM.GIF'), 'image/gif');
    assert.equal(guessImageMime('Vector.SVG'), 'image/svg+xml');
    assert.equal(guessImageMime('Apple.Heic'), 'image/heic');
  });

  test('典型输入：带完整路径或多个点的文件名', () => {
    assert.equal(guessImageMime('/path/to/folder/image.png'), 'image/png');
    assert.equal(guessImageMime('archive.tar.gz.webp'), 'image/webp');
    assert.equal(guessImageMime('my.photo.final.v2.jpg'), 'image/jpeg');
  });

  test('失败方向：未知扩展名、非图片扩展名返回 null（不可预览，防把任意字节当图打开）', () => {
    assert.equal(guessImageMime('doc.pdf'), null);
    assert.equal(guessImageMime('table.csv'), null);
    assert.equal(guessImageMime('index.html'), null);
    assert.equal(guessImageMime('script.js'), null);
    assert.equal(guessImageMime('archive.zip'), null);
    assert.equal(guessImageMime('video.mp4'), null);
    assert.equal(guessImageMime('audio.mp3'), null);
    assert.equal(guessImageMime('image.xyz'), null);
  });

  test('边界：无扩展名、以点结尾或隐藏文件', () => {
    assert.equal(guessImageMime('filename_without_ext'), null);
    assert.equal(guessImageMime('filename.'), null);
    assert.equal(guessImageMime('.gitignore'), null);
    assert.equal(guessImageMime('.png'), 'image/png');
  });

  test('边界：null、undefined、空串或非字符串输入', () => {
    assert.equal(guessImageMime(''), null);
    assert.equal(guessImageMime(null), null);
    assert.equal(guessImageMime(undefined), null);
    assert.equal(guessImageMime(123), null);
    assert.equal(guessImageMime({}), null);
  });
});

test.after(() => setLang('zh'));

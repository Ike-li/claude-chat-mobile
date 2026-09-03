import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createAppContext } from '../../app/public/js/app/context.js';
import { createClientLogger } from '../../app/public/js/app/client-log.js';
import { createAlertController } from '../../app/public/js/app/alerts.js';
import { createAttachmentController, createStoredPreviewLoader } from '../../app/public/js/app/attachments.js';
import { createRttMonitor } from '../../app/public/js/app/connection-sync.js';
import { createMessageRenderer } from '../../app/public/js/app/message-renderer.js';
import { createReplayBuffer } from '../../app/public/js/app/event-dispatch.js';
import { formatFileSize, cmModeForFileName } from '../../app/public/js/app/file-browser.js';
import { createSettingsController } from '../../app/public/js/app/settings.js';
import { createSessionWorkspaceState } from '../../app/public/js/app/session-workspaces.js';
import { createInteractionQueueState } from '../../app/public/js/app/approval-questions.js';
import { createUnreadTracker } from '../../app/public/js/app/unread-tracker.js';
import { attachLongPress } from '../../app/public/js/app/long-press.js';

test('app context owns shared DOM, state, dependencies and the active socket', () => {
  const dom = { messages: { id: 'messages' } };
  const state = { viewingInstanceId: 'inst-1' };
  const dependencies = { now: () => 123 };
  const context = createAppContext({ dom, state, dependencies });

  assert.equal(context.dom, dom);
  assert.equal(context.state, state);
  assert.equal(context.dependencies, dependencies);
  assert.equal(context.socket, null);

  const socket = { id: 'socket-1' };
  assert.equal(context.setSocket(socket), socket);
  assert.equal(context.socket, socket);
});

test('client logger uses the real ring buffer and reads current state from app context', () => {
  let now = 100;
  const state = { viewingInstanceId: 'inst-1', currentModel: 'sonnet' };
  const context = createAppContext({
    state,
    dependencies: { now: () => now },
  });
  const appended = [];
  const logger = createClientLogger(context, {
    capacity: 2,
    onEntry: entry => appended.push(entry),
  });

  logger.log('send', 'one');
  now = 101;
  state.viewingInstanceId = 'inst-2';
  state.currentModel = 'opus';
  logger.log('conn', 'two');
  now = 102;
  logger.log('recv', 'three');

  assert.deepEqual(logger.entries(), [
    { ts: 101, type: 'client_conn', text: 'two', instanceId: 'inst-2' },
    { ts: 102, type: 'client_recv', text: 'three', instanceId: 'inst-2', model: 'opus' },
  ]);
  assert.equal(appended.length, 3);
  assert.equal(logger.size(), 2);
  logger.clear();
  assert.deepEqual(logger.entries(), []);
});

test('the HTML shell loads app.css and contains no inline style block', async () => {
  const html = await readFile(new URL('../../app/public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../app/public/css/app.css', import.meta.url), 'utf8');

  assert.match(html, /<link rel="stylesheet" href="\/css\/app\.css">/);
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
  assert.match(css, /:root\s*\{/);
  assert.match(css, /\.msg-body\s*\{/);
});

test('alert controller owns persisted preferences while tap haptics remain unconditional', () => {
  const values = new Map();
  const vibrations = [];
  const context = createAppContext({
    dependencies: {
      window: {},
      navigator: { vibrate: pattern => vibrations.push(pattern) },
      storage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    },
  });
  const alerts = createAlertController(context);

  assert.deepEqual(alerts.preferences(), {
    sound: true,
    vibrate: true,
    foregroundComplete: true,
  });
  alerts.haptic('success');
  alerts.setPreference('vibrate', false);
  alerts.haptic('warning');
  alerts.haptic('tap');

  assert.deepEqual(vibrations, [[15, 80, 15], 12]);
  assert.equal(values.get('ccm_alert_vibrate'), '0');
  assert.equal(alerts.preferences().vibrate, false);
});

test('attachment controller owns pending attachment state without leaking mutable arrays', () => {
  const context = createAppContext();
  const changes = [];
  const attachments = createAttachmentController(context, {
    autoBind: false,
    onChange: items => changes.push(items),
  });
  const first = { _id: 'a', name: 'a.txt', size: 3, data: 'YWJj' };

  attachments.setItems([first]);
  const snapshot = attachments.items();
  snapshot.length = 0;

  assert.equal(attachments.items().length, 1);
  assert.deepEqual(attachments.payload(), [{ name: 'a.txt', size: 3, data: 'YWJj' }]);
  attachments.clear();
  assert.deepEqual(attachments.items(), []);
  assert.equal(changes.length, 2);
});

// 用户点 chip ✕ 移除附件：按 _id 删；payload/草稿回灌可能丢 _id，setItems 须补齐否则 filter 永 false。
test('attachment controller remove filters by _id and backfills missing ids on setItems', () => {
  let seq = 0;
  const context = createAppContext({
    dependencies: {
      now: () => 1000 + seq,
      random: () => 0.123456789 + (seq++ * 0.01),
    },
  });
  const attachments = createAttachmentController(context, { autoBind: false });

  attachments.setItems([
    { name: 'keep.txt', size: 1, data: 'YQ==' },
    { name: 'drop.txt', size: 1, data: 'Yg==' },
  ]);
  const [keep, drop] = attachments.items();
  assert.ok(keep._id, 'setItems 无 _id 时应补齐');
  assert.ok(drop._id);
  assert.notEqual(keep._id, drop._id);

  assert.equal(attachments.remove(drop._id), true);
  assert.deepEqual(
    attachments.items().map(a => a.name),
    ['keep.txt'],
  );
  assert.equal(attachments.remove('missing-id'), false);
  assert.equal(attachments.items().length, 1);

  // 保留已有 _id，不重写
  attachments.setItems([{ _id: 'stable', name: 'x.bin', size: 2, data: 'eA==' }]);
  assert.equal(attachments.items()[0]._id, 'stable');
});

// makeThumb 曾用 createObjectURL → image.src = blob:…，被 CSP img-src 'self' data: 拦下，
// 缩略图静默失败（onerror→null）。灯箱路径已走 data URL；缩略图必须同一契约，禁止 blob:。
test('attachment makeThumb loads via data URL and never creates a blob: object URL', async () => {
  const objectUrlCalls = [];
  class FakeFileReader {
    readAsDataURL(blob) {
      // 真 File 在 node 测试里用 plain object 模拟；按 type 拼一条最小 data URL
      const mime = blob?.type || 'application/octet-stream';
      queueMicrotask(() => {
        this.result = `data:${mime};base64,AA==`;
        this.onload?.();
      });
    }
  }
  class FakeImage {
    set src(value) {
      this._src = value;
      // 模拟浏览器：data: 可加载；blob: 会被 CSP 打成 error（本测试也禁止走到这条路径）
      queueMicrotask(() => {
        if (String(value).startsWith('data:')) {
          this.width = 640;
          this.height = 480;
          this.onload?.();
        } else {
          this.onerror?.();
        }
      });
    }
    get src() { return this._src; }
  }
  const fakeUrl = {
    createObjectURL(blob) {
      objectUrlCalls.push(blob);
      return `blob:http://127.0.0.1/${objectUrlCalls.length}`;
    },
    revokeObjectURL() {},
  };
  const context = createAppContext({
    dependencies: {
      FileReader: FakeFileReader,
      Image: FakeImage,
      URL: fakeUrl,
      document: {
        createElement(tag) {
          assert.equal(tag, 'canvas');
          return {
            width: 0,
            height: 0,
            getContext() {
              return { drawImage() {} };
            },
            toDataURL(type) {
              return `data:${type};base64,thumbJPEG`;
            },
          };
        },
      },
      now: () => 42,
      random: () => 0.5,
    },
  });
  const attachments = createAttachmentController(context, { autoBind: false });
  await attachments.addFiles([{ name: 'shot.png', type: 'image/png', size: 12 }]);

  assert.equal(objectUrlCalls.length, 0, 'CSP 禁 blob:，makeThumb 不得 createObjectURL');
  const [item] = attachments.items();
  assert.ok(item, '图片应成功入队');
  assert.equal(item.thumb, 'data:image/jpeg;base64,thumbJPEG');
  assert.equal(item.data, 'AA=='); // readBase64 剥 data: 前缀
});

// ── E18 附件预览：createStoredPreviewLoader ──────────────────────────────────────
// 气泡附件点击 → browse:read base64 分页拉原图 → Blob → FileReader.readAsDataURL → 灯箱。
// fake FileReader 用真 Blob.arrayBuffer() 还原字节再拼 data URL——端到端验证分片拼装正确性。
function makePreviewHarness({ fileBytes, chunkBytes = 10, ackOverride = null, deferFirstChunk = false } = {}) {
  const emits = [];
  const socket = {
    emit(event, payload, ack) {
      emits.push({ event, payload });
      if (ackOverride) return ackOverride(payload, ack);
      const offset = payload.offset || 0;
      const slice = fileBytes.subarray(offset, offset + (payload.maxBytes || chunkBytes));
      const reply = () => ack({
        ok: true,
        content: Buffer.from(slice).toString('base64'),
        totalSize: fileBytes.length,
        bytesRead: slice.length,
        truncated: offset + slice.length < fileBytes.length,
        binary: true,
      });
      if (deferFirstChunk && offset === 0) setTimeout(reply, 5);
      else reply();
    },
  };
  class FakeFileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buf => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString('base64')}`;
        this.onload?.();
      }, err => this.onerror?.(err));
    }
  }
  const context = createAppContext({ dependencies: { FileReader: FakeFileReader } });
  context.setSocket(socket);
  const bars = [];
  const opened = [];
  const loader = createStoredPreviewLoader(context, {
    addBar: (text, cls) => bars.push({ text, cls }),
    openPreviewUrl: (name, url) => opened.push({ name, url }),
    chunkBytes,
  });
  return { loader, emits, bars, opened };
}

test('stored preview loader fetches a single-chunk image and opens the lightbox with exact bytes', async () => {
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  const { loader, emits, opened, bars } = makePreviewHarness({ fileBytes, chunkBytes: 100 });
  await loader.open({ cwd: '/w', storedName: '123-abcd1234-p.png', name: 'p.png', mimeType: 'image/png' });
  assert.equal(emits.length, 1);
  assert.equal(emits[0].event, 'browse:read');
  assert.equal(emits[0].payload.relPath, '.ccm-uploads/123-abcd1234-p.png');
  assert.equal(emits[0].payload.encoding, 'base64');
  assert.equal(emits[0].payload.cwd, '/w');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].name, 'p.png');
  assert.equal(opened[0].url, `data:image/png;base64,${fileBytes.toString('base64')}`);
  assert.deepEqual(bars.filter(b => b.cls === 'text-danger'), []);
});

test('stored preview loader reassembles multi-chunk fetches by offset even when acks land out of order', async () => {
  const fileBytes = Buffer.from(Array.from({ length: 25 }, (_, i) => (i * 7 + 3) % 256));
  const { loader, emits, opened } = makePreviewHarness({ fileBytes, chunkBytes: 10, deferFirstChunk: true });
  await loader.open({ cwd: '/w', storedName: '1-aaaaaaaa-x.png', name: 'x.png', mimeType: 'image/png' });
  assert.equal(emits.length, 3); // 25 字节 / 10 每片 → 3 片
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, `data:image/png;base64,${fileBytes.toString('base64')}`);
});

test('stored preview loader caches by cwd+storedName and skips refetch on second open', async () => {
  const fileBytes = Buffer.from([1, 2, 3]);
  const { loader, emits, opened } = makePreviewHarness({ fileBytes, chunkBytes: 100 });
  await loader.open({ cwd: '/w', storedName: '1-bbbbbbbb-c.png', name: 'c.png', mimeType: 'image/png' });
  await loader.open({ cwd: '/w', storedName: '1-bbbbbbbb-c.png', name: 'c.png', mimeType: 'image/png' });
  assert.equal(emits.length, 1); // 第二次走缓存不 emit
  assert.equal(opened.length, 2);
  assert.equal(opened[0].url, opened[1].url);
});

test('stored preview loader rejects oversized files with a toast and no lightbox', async () => {
  const { loader, emits, opened, bars } = makePreviewHarness({
    fileBytes: Buffer.alloc(4),
    ackOverride: (_payload, ack) => ack({ ok: true, content: 'AAAA', totalSize: 11 * 1024 * 1024, bytesRead: 3, truncated: true, binary: true }),
  });
  await loader.open({ cwd: '/w', storedName: '1-cccccccc-big.png', name: 'big.png', mimeType: 'image/png' });
  assert.equal(emits.length, 1); // 只发了首片探测
  assert.equal(opened.length, 0);
  assert.ok(bars.some(b => b.text.includes('过大')));
});

test('stored preview loader falls back to the thumb with a toast when the file is gone', async () => {
  const { loader, opened, bars } = makePreviewHarness({
    fileBytes: Buffer.alloc(0),
    ackOverride: (_payload, ack) => ack({ ok: false, error: '路径不在授权范围内，或不是文件' }),
  });
  await loader.open({ cwd: '/w', storedName: '1-dddddddd-gone.png', name: 'gone.png', mimeType: 'image/png', thumb: 'data:image/jpeg;base64,thumb' });
  assert.ok(bars.some(b => b.cls === 'text-danger'));
  assert.deepEqual(opened, [{ name: 'gone.png', url: 'data:image/jpeg;base64,thumb' }]); // 降级放大 thumb
});

test('stored preview loader refuses path-like storedName and non-image types without emitting', async () => {
  const { loader, emits, opened, bars } = makePreviewHarness({ fileBytes: Buffer.alloc(1) });
  await loader.open({ cwd: '/w', storedName: '../escape.png', name: 'escape.png', mimeType: 'image/png' });
  await loader.open({ cwd: '/w', storedName: 'sub/dir.png', name: 'dir.png', mimeType: 'image/png' });
  await loader.open({ cwd: '/w', storedName: '1-eeeeeeee-doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf' });
  await loader.open({ cwd: '/w', storedName: '1-ffffffff-noext', name: 'noext' }); // 无 mime 且扩展名猜不出
  assert.equal(emits.length, 0);
  assert.equal(opened.length, 0);
  assert.equal(bars.length, 4);
});

test('stored preview loader guesses image mime from the file name when meta lacks mimeType', async () => {
  const fileBytes = Buffer.from([9, 9, 9]);
  const { loader, opened } = makePreviewHarness({ fileBytes, chunkBytes: 100 });
  await loader.open({ cwd: '/w', storedName: '1-99999999-shot.webp', name: 'shot.webp' }); // 历史路径无 mimeType
  assert.equal(opened.length, 1);
  assert.ok(opened[0].url.startsWith('data:image/webp;base64,'));
});

test('RTT monitor renders latency through app context and clears stale values', () => {
  const rtt = { textContent: '', className: '', title: '' };
  const wrap = { title: '' };
  const statuses = [];
  const context = createAppContext({ dom: { connRtt: rtt, connDotWrap: wrap } });
  const monitor = createRttMonitor(context, { setStatus: value => statuses.push(value) });

  // 差网：芯片可见 + danger 色；状态行带「延迟」。角标 title 不归 RTT 写。
  assert.equal(monitor.render(1250), '1.3s');
  assert.equal(rtt.textContent, '延迟 1.3s');
  assert.match(rtt.className, /conn-rtt-chip/);
  assert.match(rtt.className, /text-danger/);
  assert.doesNotMatch(rtt.className, /\bhidden\b/);
  assert.equal(rtt.title, '手机到主机往返延迟 1.3s');
  assert.equal(wrap.title, '');
  assert.deepEqual(statuses, ['已连接 · 延迟 1.3s']);

  // 好网：芯片隐藏（顶栏安静），状态行仍保留延迟数字供排障
  assert.equal(monitor.render(80), '80ms');
  assert.equal(rtt.textContent, '');
  assert.match(rtt.className, /\bhidden\b/);
  assert.match(rtt.className, /conn-rtt-chip/);
  assert.equal(rtt.title, '手机到主机往返延迟 80ms');
  assert.equal(wrap.title, '');
  assert.equal(statuses.at(-1), '已连接 · 延迟 80ms');

  // warn 档仍显示芯片
  assert.equal(monitor.render(500), '500ms');
  assert.equal(rtt.textContent, '延迟 500ms');
  assert.match(rtt.className, /text-warning/);
  assert.doesNotMatch(rtt.className, /\bhidden\b/);

  monitor.clear();
  assert.equal(rtt.textContent, '');
  assert.match(rtt.className, /hidden/);
  assert.match(rtt.className, /conn-rtt-chip/);
});

test('markdown sanitizer forbids clickjacking and form-exfiltration primitives', () => {
  const configs = [];
  const context = createAppContext({
    dependencies: {
      marked: { setOptions() {}, parse: raw => raw },
      DOMPurify: { addHook() {}, sanitize: (html, cfg) => { configs.push(cfg); return html; } },
    },
  });

  createMessageRenderer(context).renderMarkdown('x');

  const cfg = configs[0];
  assert.ok(cfg, 'sanitize 必须带显式配置，不能沿用 DOMPurify 默认放行表');
  const tags = cfg.FORBID_TAGS || [];
  const attrs = cfg.FORBID_ATTR || [];
  for (const tag of ['label', 'form', 'button', 'select', 'textarea']) {
    assert.ok(tags.includes(tag), `必须禁 <${tag}>：可构造覆盖层或外发表单`);
  }
  for (const attr of ['style', 'for']) {
    assert.ok(attrs.includes(attr), `必须禁 ${attr} 属性：全屏覆盖 + 激活按钮的两个必要原语`);
  }
});

// 回放缓冲：OOB 不入队 / 超时按阈值决策 / discard 清队列（code review 修复回归）
test.describe('createReplayBuffer：OOB 旁路 + 超时决策 + discard', () => {
  function makeBuffer(opts = {}) {
    const dispatched = [];
    const scrolls = [];
    let seq = 0;
    let epoch = null;
    const buf = createReplayBuffer({
      dispatch: (e) => dispatched.push(e),
      scrollBottom: (force) => scrolls.push(force),
      withScrollSuppressed: (fn) => fn(),
      setSeq: (v) => { seq = v; },
      setEpoch: (v) => { epoch = v; },
      timeoutMs: opts.timeoutMs ?? 50,
      decideTimeoutAction: opts.decideTimeoutAction,
      isOutOfBand: opts.isOutOfBand,
    });
    return { buf, dispatched, scrolls, getSeq: () => seq, getEpoch: () => epoch };
  }

  test('offer：同 instance 的对话流事件入队；OOB（mirror_state/history_append）不入队', () => {
    const { buf, dispatched } = makeBuffer({ timeoutMs: 60_000 });
    buf.begin('inst-1');
    assert.equal(buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 }), true);
    assert.equal(buf.offer({ type: 'mirror_state', instanceId: 'inst-1', epoch: 'server', seq: 0 }), false);
    assert.equal(buf.offer({ type: 'history_append', instanceId: 'inst-1', epoch: 'server', seq: 0 }), false);
    assert.equal(buf.offer({ type: 'task_notification', instanceId: 'inst-1', epoch: 'e1', seq: 2 }), false);
    assert.equal(buf.bufferedCount('inst-1'), 1);
    assert.deepEqual(dispatched, []);
  });

  test("resolve('reload')：只推进基线、不派发缓冲事件", () => {
    const { buf, dispatched, getSeq, getEpoch } = makeBuffer({ timeoutMs: 60_000 });
    const h = buf.begin('inst-1');
    buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 5 });
    buf.offer({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 6 });
    buf.resolve(h, 'reload');
    assert.deepEqual(dispatched, []);
    assert.equal(getSeq(), 6);
    assert.equal(getEpoch(), 'e1');
    assert.equal(buf.bufferedCount('inst-1'), 0);
  });

  test('超时：decideTimeoutAction 返回 reload → 只推进基线，不 flush 成打字机', async () => {
    const { buf, dispatched, getSeq } = makeBuffer({
      timeoutMs: 20,
      decideTimeoutAction: ({ bufferedCount }) => (bufferedCount >= 2 ? 'reload' : 'flush'),
    });
    buf.begin('inst-1');
    buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 });
    buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 2 });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(dispatched, [], '超阈值超时应走 reload，不逐条 dispatch');
    assert.equal(getSeq(), 2);
  });

  test('超时：decideTimeoutAction 返回 flush → 按序派发', async () => {
    const { buf, dispatched } = makeBuffer({
      timeoutMs: 20,
      decideTimeoutAction: () => 'flush',
    });
    buf.begin('inst-1');
    buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].seq, 1);
  });

  test("resolve(handle, 'discard')：清队列不推进基线、不派发", () => {
    const { buf, dispatched, getSeq } = makeBuffer({ timeoutMs: 60_000 });
    const h = buf.begin('inst-1');
    buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 9 });
    buf.resolve(h, 'discard');
    assert.deepEqual(dispatched, []);
    assert.equal(getSeq(), 0);
    assert.equal(buf.bufferedCount('inst-1'), 0);
  });
});

test('file browser formats byte counts consistently for directory and content pages', () => {
  assert.equal(formatFileSize(100), '100B');
  assert.equal(formatFileSize(1536), '1.5KB');
  assert.equal(formatFileSize(2 * 1024 * 1024), '2.0MB');
  assert.equal(formatFileSize(Number.NaN), '');
});

test('cmModeForFileName resolves vendored CodeMirror modes and falls back to null', () => {
  assert.equal(cmModeForFileName('app.js'), 'text/javascript');
  assert.equal(cmModeForFileName('types.d.ts'), 'application/typescript');
  assert.equal(cmModeForFileName('Component.tsx'), 'text/typescript-jsx');
  assert.equal(cmModeForFileName('package.json'), 'application/json');
  assert.equal(cmModeForFileName('index.html'), 'text/html');
  assert.equal(cmModeForFileName('README.md'), 'text/markdown');
  assert.equal(cmModeForFileName('config.YAML'), 'text/x-yaml');
  assert.equal(cmModeForFileName('deploy.sh'), 'text/x-sh');
  assert.equal(cmModeForFileName('a.out'), null);
  assert.equal(cmModeForFileName('Makefile'), null);
  assert.equal(cmModeForFileName(''), null);
  assert.equal(cmModeForFileName(null), null);
});

test('settings controller synchronizes alert preferences when opening the sheet', () => {
  const classes = initial => {
    const values = new Set(initial);
    return {
      add: (...names) => names.forEach(name => values.add(name)),
      remove: (...names) => names.forEach(name => values.delete(name)),
      has: name => values.has(name),
    };
  };
  const sheetClasses = classes(['translate-y-full']);
  const scrimClasses = classes(['hidden']);
  const bodyClasses = classes([]);
  const htmlClasses = classes([]);
  const sound = {};
  const vibrate = {};
  const foreground = {};
  const sheetBody = { scrollTop: 42 };
  const context = createAppContext({
    dom: {
      settingsSheet: { classList: sheetClasses, scrollTop: 0 },
      settingsSheetBody: sheetBody,
      settingsScrim: { classList: scrimClasses },
      prefAlertSound: sound,
      prefAlertVibrate: vibrate,
      prefAlertForeground: foreground,
    },
  });
  const fakeDoc = {
    documentElement: { classList: htmlClasses },
    body: { classList: bodyClasses },
  };
  const controller = createSettingsController(context, {
    alerts: { preferences: () => ({ sound: false, vibrate: true, foregroundComplete: false }), ensureAudio: () => {} },
    autoBind: false,
    doc: fakeDoc,
  });

  controller.open();
  assert.equal(sound.checked, false);
  assert.equal(vibrate.checked, true);
  assert.equal(foreground.checked, false);
  assert.equal(sheetClasses.has('translate-y-full'), false);
  assert.equal(scrimClasses.has('hidden'), false);
  // 打开锁背景滚动 + 内容区滚回顶部
  assert.equal(bodyClasses.has('ccm-sheet-open'), true);
  assert.equal(htmlClasses.has('ccm-sheet-open'), true);
  assert.equal(sheetBody.scrollTop, 0);

  controller.close();
  assert.equal(sheetClasses.has('translate-y-full'), true);
  assert.equal(scrimClasses.has('hidden'), true);
  assert.equal(bodyClasses.has('ccm-sheet-open'), false);
  assert.equal(htmlClasses.has('ccm-sheet-open'), false);
});

test('session workspace state exposes isolated caches through app context', () => {
  const firstContext = createAppContext();
  const secondContext = createAppContext();
  const first = createSessionWorkspaceState(firstContext);
  const second = createSessionWorkspaceState(secondContext);

  first.sessionDrafts.set('s1', { text: 'draft' });
  assert.equal(second.sessionDrafts.has('s1'), false);
  assert.equal(firstContext.state.sessionWorkspaces, first);
});

test('approval and question state caps answered IDs and recognizes grouped question IDs', () => {
  const context = createAppContext();
  const interactions = createInteractionQueueState(context, { answeredCapacity: 2 });

  interactions.markQuestionAnswered('tool#0');
  interactions.markQuestionAnswered('tool#1');
  interactions.markQuestionAnswered('new');

  assert.equal(interactions.answeredQuestionIds.has('tool#0'), false);
  assert.equal(interactions.isQuestionAnswered('tool#1'), true);
  interactions.markQuestionAnswered('group');
  assert.equal(interactions.isQuestionAnswered('group#4'), true);
});

// ---- createUnreadTracker：R65 未读点的本设备已读表 + 手动未读（长按「标为未读」）----
// 纯判定在 logic-unread.test.mjs；这里钉 tracker 的生命周期契约：离场记 seen 不清手动标记、
// 再次打开（markEntered）才清、标为已读同时记 seen、落盘形状、存储不可用时静默降级。
function memoryStorage(initial = null) {
  let raw = initial;
  return { getItem: () => raw, setItem: (_k, v) => { raw = v; }, dump: () => raw };
}

test.describe('createUnreadTracker：手动未读的生命周期', () => {
  const T0 = 1_700_000_000_000;

  test('标为未读 → 基线前的历史会话也亮；离场 markSeen 不清；再次打开 markEntered 才清', () => {
    let now = T0 + 10;
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {} }));
    const tracker = createUnreadTracker({ storage, now: () => now });
    const old = { id: 's1', lastUsedAt: T0 - 1000 };
    assert.equal(tracker.isUnread(old), false, '基线前的历史会话本来不亮');

    tracker.setManualUnread('s1', true);
    assert.equal(tracker.isUnread(old), true);
    assert.equal(tracker.isUnread(old, { isViewing: true }), false, '正在看的不亮（与自动未读同一条红线）');
    assert.equal(tracker.isManualUnread('s1'), true, '长按菜单据此对正看着的会话给出「标为已读」');
    assert.equal(tracker.isManualUnread('other'), false);
    assert.equal(JSON.parse(storage.dump()).manual.s1, now, '标记落盘');

    now += 5;
    tracker.markSeen('s1'); // bindView 离场侧：正看着时标的「稍后再看」必须活过离开
    assert.equal(tracker.isUnread(old), true);

    now += 5;
    tracker.markEntered('s1'); // bindView 入场侧：打开 = 看过 + 手动标记作废
    assert.equal(tracker.isUnread(old), false);
    const persisted = JSON.parse(storage.dump());
    assert.deepEqual(persisted.manual, {});
    assert.equal(persisted.seen.s1, now);
  });

  test('标为已读 → 时间判据本会亮的会话也不亮（同时记 seen，否则 lastUsedAt 仍压过 seenAt）', () => {
    const now = T0 + 10;
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {} }));
    const tracker = createUnreadTracker({ storage, now: () => now });
    const fresh = { id: 's2', lastUsedAt: T0 + 5 };
    assert.equal(tracker.isUnread(fresh), true);
    tracker.setManualUnread('s2', false);
    assert.equal(tracker.isUnread(fresh), false);
    assert.equal(JSON.parse(storage.dump()).seen.s2, now);
  });

  test('旧版本落盘（无 manual 字段）照常加载；存储不可用时内存态仍工作', () => {
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: { s3: T0 + 1 } }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 100 });
    assert.equal(tracker.isUnread({ id: 's3', lastUsedAt: T0 + 50 }), true, '已读表未被升级丢掉：seen 之后有新活动 → 亮');
    assert.equal(tracker.isUnread({ id: 's3', lastUsedAt: T0 }), false, 'seen 之前的活动不亮');

    const degraded = createUnreadTracker({ storage: null, now: () => T0 });
    degraded.setManualUnread('x', true);
    assert.equal(degraded.isUnread({ id: 'x', lastUsedAt: T0 - 1 }), true);
    degraded.markEntered('x');
    assert.equal(degraded.isUnread({ id: 'x', lastUsedAt: T0 - 1 }), false);
  });

  test('无 id 的会话行（未落盘新会话）：标记与判定都是 no-op', () => {
    const tracker = createUnreadTracker({ storage: memoryStorage(), now: () => T0 });
    tracker.setManualUnread('', true);
    tracker.setManualUnread(null, true);
    assert.equal(tracker.isUnread({ id: null, lastUsedAt: T0 + 1 }), false);
  });
});

// ---- attachLongPress：抽屉会话行的长按手势（触屏/鼠标走 Pointer Events 计时，桌面右键同效）----
// 用 EventTarget + 注入计时器，不依赖 DOM：钉的是手势判定契约（到时触发 / 位移取消 / 抬手取消 /
// 右键直达 / 触发后吞掉紧随的 click），不是浏览器细节。
function fakePointerTarget() {
  const el = new EventTarget();
  el.fire = (type, init = {}) => {
    const ev = new Event(type, { cancelable: true, bubbles: true });
    Object.assign(ev, init);
    el.dispatchEvent(ev);
    return ev;
  };
  return el;
}

function fakeTimers() {
  const timers = new Map();
  let nextId = 0;
  return {
    setTimer: (fn) => { nextId += 1; timers.set(nextId, fn); return nextId; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    flush: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
  };
}

function mountLongPress(handler = () => {}) {
  const el = fakePointerTarget();
  const timers = fakeTimers();
  const fired = [];
  attachLongPress(el, ev => { fired.push(ev.type); handler(ev); }, {
    holdMs: 500,
    moveTolerance: 10,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { el, timers, fired };
}

const DOWN = { button: 0, isPrimary: true, clientX: 10, clientY: 10 };

test.describe('attachLongPress：长按/右键触发，位移与抬手取消，吞掉紧随的 click', () => {
  test('按住不动到时 → 触发一次；随后的 click 被吞掉一次，再下一次点击照常', () => {
    const { el, timers, fired } = mountLongPress();
    el.fire('pointerdown', DOWN);
    assert.equal(fired.length, 0, '到时前不触发');
    assert.equal(timers.pending(), 1);
    timers.flush();
    assert.deepEqual(fired, ['pointerdown']);

    el.fire('pointerup', { clientX: 10, clientY: 10 });
    const swallowed = el.fire('click');
    assert.equal(swallowed.defaultPrevented, true, '长按松手产生的 click 不能再当成「点开会话」');
    const passed = el.fire('click');
    assert.equal(passed.defaultPrevented, false, '只吞一次');
  });

  test('指尖位移超过容差（纵向滚动 / 横向侧滑）→ 取消，不触发，click 照常', () => {
    const { el, timers, fired } = mountLongPress();
    el.fire('pointerdown', DOWN);
    el.fire('pointermove', { clientX: 10, clientY: 40 });
    assert.equal(timers.pending(), 0, '位移即撤销计时');
    timers.flush();
    assert.equal(fired.length, 0);
    assert.equal(el.fire('click').defaultPrevented, false);
  });

  test('容差内的抖动不取消', () => {
    const { el, timers, fired } = mountLongPress();
    el.fire('pointerdown', DOWN);
    el.fire('pointermove', { clientX: 14, clientY: 17 });
    assert.equal(timers.pending(), 1);
    timers.flush();
    assert.equal(fired.length, 1);
  });

  test('到时前抬手 / 系统接管（pointercancel）→ 取消', () => {
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      const { el, timers, fired } = mountLongPress();
      el.fire('pointerdown', DOWN);
      el.fire(type, { clientX: 10, clientY: 10 });
      assert.equal(timers.pending(), 0, type);
      timers.flush();
      assert.equal(fired.length, 0, type);
    }
  });

  test('非主键（右键/中键 pointerdown）不计时；contextmenu 直接触发并阻止原生菜单', () => {
    const { el, timers, fired } = mountLongPress();
    el.fire('pointerdown', { ...DOWN, button: 2 });
    assert.equal(timers.pending(), 0);
    const ctx = el.fire('contextmenu');
    assert.equal(ctx.defaultPrevented, true, '桌面右键：接管为本 app 的菜单');
    assert.deepEqual(fired, ['contextmenu']);
  });

  test('计时器已触发后再来 contextmenu（Android 长按两者都发）→ 不重复触发', () => {
    const { el, timers, fired } = mountLongPress();
    el.fire('pointerdown', DOWN);
    timers.flush();
    const ctx = el.fire('contextmenu');
    assert.equal(ctx.defaultPrevented, true);
    assert.equal(fired.length, 1);
  });

  test('第二根手指（isPrimary=false）不参与；重复 pointerdown 只保留最后一个计时', () => {
    const { el, timers, fired } = mountLongPress();
    el.fire('pointerdown', { ...DOWN, isPrimary: false });
    assert.equal(timers.pending(), 0);
    el.fire('pointerdown', DOWN);
    el.fire('pointerdown', DOWN);
    assert.equal(timers.pending(), 1);
    timers.flush();
    assert.equal(fired.length, 1);
  });
});

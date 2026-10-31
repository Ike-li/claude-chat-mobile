// tests/unit/frontend-app-modules.test.mjs —— app/public/js/app/ 下各工厂模块的【所有权边界】
// 这一层的问法不是「功能对不对」，是「状态归谁、依赖从哪注入」：每个工厂只持自己的状态，
// 共享的东西一律经 context 注入（样板见 app/event-dispatch.js），不许再落 app.js 顶层作用域。
// 覆盖：context 的共享 DOM/state/依赖 · client-log 环形缓冲 · alerts 持久化偏好 · attachments 待发队列
//       · createReplayBuffer（OOB 旁路 + 超时决策）· createUnreadTracker 手动未读生命周期
//       · createDrawerUnreadJump（未读行游标循环、折叠态先展开再补跳、子树重建后游标仍有效）
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
import { createDrawerUnreadJump } from '../../app/public/js/app/drawer-unread-jump.js';

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

test('the HTML shell links the prebuilt tw.css after app.css instead of compiling Tailwind in the browser', async () => {
  const html = await readFile(new URL('../../app/public/index.html', import.meta.url), 'utf8');

  const appCss = html.indexOf('<link rel="stylesheet" href="/css/app.css">');
  const twCss = html.indexOf('<link rel="stylesheet" href="/css/tw.css">');
  assert.ok(twCss !== -1, '外壳没链 tw.css：页面上所有 Tailwind 工具类都没有样式');
  assert.ok(twCss > appCss, 'tw.css 排到了 app.css 前面：同特异性的规则改由 app.css 胜出，层叠顺序与此前 Play CDN 追加在 head 末尾时相反');
  assert.doesNotMatch(html, /\/vendor\/tailwind\.js|\/js\/tw-config\.js/,
    '外壳又在加载 Tailwind 运行时：启动时同步执行 400KB 脚本，之后每批 DOM 变化都全量扫一遍 class');
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
// 气泡附件点击 → attachment:read base64 分页拉原图 → Blob → FileReader.readAsDataURL → 灯箱。
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
  assert.equal(emits[0].event, 'attachment:read');
  // 只带裸文件名：附件搬进 dataDir 后目录由服务端按 cwd 算（新家优先、旧对话回落老位置），
  // 前端不再自己拼 `.ccm-uploads/<name>`——它连附件根在哪都不知道，也不需要知道。
  assert.equal(emits[0].payload.storedName, '123-abcd1234-p.png');
  assert.equal(emits[0].payload.relPath, undefined, '不得再发相对路径');
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

  // 好网：芯片常驻显示（中性 ink-soft 色），状态行同步带延迟
  assert.equal(monitor.render(80), '80ms');
  assert.equal(rtt.textContent, '延迟 80ms');
  assert.doesNotMatch(rtt.className, /\bhidden\b/);
  assert.match(rtt.className, /conn-rtt-chip/);
  assert.match(rtt.className, /text-ink-soft/);
  assert.equal(rtt.title, '手机到主机往返延迟 80ms');
  assert.equal(wrap.title, '');
  assert.equal(statuses.at(-1), '已连接 · 延迟 80ms');

  // warn 档仍显示芯片
  assert.equal(monitor.render(500), '500ms');
  assert.equal(rtt.textContent, '延迟 500ms');
  assert.match(rtt.className, /text-warning/);
  assert.doesNotMatch(rtt.className, /\bhidden\b/);

  // #379：同签名不重写 DOM（格式化标签相同 → 不碰 textContent）
  const before = rtt.textContent;
  rtt.textContent = 'STALE';
  assert.equal(monitor.render(500), '500ms');
  assert.equal(rtt.textContent, 'STALE', '同 label/tone/title 须跳过写入');
  rtt.textContent = before;

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
  // t 必传：begin() 会挂一条真实 setTimeout(timeoutMs)，用例里为「大到不触发」常传 60_000。
  // 它挂在事件循环上，进程要等它烧完才肯退出——2026-09-07 实测本文件因此单跑 60.2s（CPU 仅 0.22s），
  // 而 test:unit 并行度 9 下的 wall time 恰由最长文件决定，整条 unit 槽被这一个定时器锚成 62s。
  // 清理放在 helper 里而不是逐个用例末尾加 discard()：后者每新增一个用例都要记得写，漏一次就复发。
  function makeBuffer(t, opts = {}) {
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
      deferMs: opts.deferMs ?? 60_000,
      decideTimeoutAction: opts.decideTimeoutAction,
      isOutOfBand: opts.isOutOfBand,
    });
    t.after(() => buf.discard()); // 无条件：已 resolve 过的 buf 再 discard 是空操作（active 为 null 直接 return）
    return { buf, dispatched, scrolls, getSeq: () => seq, getEpoch: () => epoch };
  }

  test('offer：同 instance 的对话流事件入队；OOB（mirror_state/history_append）不入队', (t) => {
    const { buf, dispatched } = makeBuffer(t, { timeoutMs: 60_000 });
    buf.begin('inst-1');
    assert.equal(buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 }), true);
    assert.equal(buf.offer({ type: 'mirror_state', instanceId: 'inst-1', epoch: 'server', seq: 0 }), false);
    assert.equal(buf.offer({ type: 'history_append', instanceId: 'inst-1', epoch: 'server', seq: 0 }), false);
    assert.equal(buf.offer({ type: 'task_notification', instanceId: 'inst-1', epoch: 'e1', seq: 2 }), false);
    assert.equal(buf.bufferedCount('inst-1'), 1);
    assert.deepEqual(dispatched, []);
  });

  // 「会话已中断」面要在缓冲被 discard 之前读出排着队的崩溃原因（#329 review P2）
  test('queued：只给当前缓冲实例的排队事件，且是副本', (t) => {
    const { buf } = makeBuffer(t, { timeoutMs: 60_000 });
    buf.begin('inst-1');
    const err = { type: 'error', instanceId: 'inst-1', epoch: 'e1', seq: 3, payload: { processExited: true, message: 'SIGKILL' } };
    buf.offer(err);
    assert.deepEqual(buf.queued('inst-1'), [err]);
    assert.deepEqual(buf.queued('inst-2'), []);
    buf.queued('inst-1').length = 0;
    assert.equal(buf.bufferedCount('inst-1'), 1);
    buf.discard();
    assert.deepEqual(buf.queued('inst-1'), []);
  });

  test("resolve('reload')：只推进基线、不派发缓冲事件", (t) => {
    const { buf, dispatched, getSeq, getEpoch } = makeBuffer(t, { timeoutMs: 60_000 });
    const h = buf.begin('inst-1');
    buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 5 });
    buf.offer({ type: 'result', instanceId: 'inst-1', epoch: 'e1', seq: 6 });
    buf.resolve(h, 'reload');
    assert.deepEqual(dispatched, []);
    assert.equal(getSeq(), 6);
    assert.equal(getEpoch(), 'e1');
    assert.equal(buf.bufferedCount('inst-1'), 0);
  });

  // 超时判 reload 之后事件不得被丢（2026-09-22 review P2）是 SYNC-01 红线，三条用例在
  // tests/invariants/replay-buffer-late-ack.test.mjs。

  test('超时：decideTimeoutAction 返回 flush → 按序派发', async (t) => {
    const { buf, dispatched } = makeBuffer(t, {
      timeoutMs: 20,
      decideTimeoutAction: () => 'flush',
    });
    buf.begin('inst-1');
    buf.offer({ type: 'text_delta', instanceId: 'inst-1', epoch: 'e1', seq: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].seq, 1);
  });

  test("resolve(handle, 'discard')：清队列不推进基线、不派发", (t) => {
    const { buf, dispatched, getSeq } = makeBuffer(t, { timeoutMs: 60_000 });
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
      contains: name => values.has(name),
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
      settingsSheet: {
        classList: sheetClasses, scrollTop: 0, inert: false, dataset: {},
        contains: () => false, hasAttribute: () => true, setAttribute: () => {}, focus: () => {},
      },
      settingsSheetBody: sheetBody,
      settingsScrim: { classList: scrimClasses },
      prefAlertSound: sound,
      prefAlertVibrate: vibrate,
      prefAlertForeground: foreground,
    },
  });
  const fakeDoc = {
    documentElement: { classList: htmlClasses, dataset: {} },
    body: { classList: bodyClasses },
    activeElement: null,
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

  assert.equal(context.dom.settingsSheet.inert, false, '打开后面板里的控件要能被 Tab 到');

  controller.close();
  assert.equal(sheetClasses.has('translate-y-full'), true);
  assert.equal(scrimClasses.has('hidden'), true);
  assert.equal(context.dom.settingsSheet.inert, true, '收起的面板只是移出屏幕，不 inert 就还能被 Tab 到（验收 O77）');
  assert.equal(bodyClasses.has('ccm-sheet-open'), false);
  assert.equal(htmlClasses.has('ccm-sheet-open'), false);
});

test('settings scroll-lock is idempotent on repeated open/close', () => {
  // #425：深链 / 再点入口会二次 open；若每次都 acquire，关一次就留下 ccm-sheet-open。
  const classes = initial => {
    const values = new Set(initial);
    return {
      add: (...names) => names.forEach(name => values.add(name)),
      remove: (...names) => names.forEach(name => values.delete(name)),
      has: name => values.has(name),
      contains: name => values.has(name),
    };
  };
  const sheetClasses = classes(['translate-y-full']);
  const scrimClasses = classes(['hidden']);
  const bodyClasses = classes([]);
  const htmlClasses = classes([]);
  const dataset = {};
  const context = createAppContext({
    dom: {
      settingsSheet: {
        classList: sheetClasses, scrollTop: 0, inert: false, dataset: {},
        contains: () => false, hasAttribute: () => true, setAttribute: () => {}, focus: () => {},
      },
      settingsSheetBody: { scrollTop: 0 },
      settingsScrim: { classList: scrimClasses },
      prefAlertSound: {},
      prefAlertVibrate: {},
      prefAlertForeground: {},
    },
  });
  const fakeDoc = {
    documentElement: { classList: htmlClasses, dataset },
    body: { classList: bodyClasses },
    activeElement: null,
  };
  const controller = createSettingsController(context, {
    alerts: { preferences: () => ({ sound: false, vibrate: false, foregroundComplete: false }), ensureAudio: () => {} },
    autoBind: false,
    doc: fakeDoc,
  });

  controller.open();
  assert.equal(dataset.ccmSheetLocks, '1');
  controller.open(); // 已开再开
  assert.equal(dataset.ccmSheetLocks, '1', '重复 open 不得再加锁');
  assert.equal(bodyClasses.has('ccm-sheet-open'), true);

  controller.close();
  assert.equal(bodyClasses.has('ccm-sheet-open'), false, '关一次必须解锁');
  assert.equal(dataset.ccmSheetLocks, undefined);

  controller.close(); // 已关再关
  assert.equal(bodyClasses.has('ccm-sheet-open'), false, '重复 close 不得 underflow 再去动别人的锁');
});

test('settings Escape: 上层 sheet 已在捕获阶段处理（defaultPrevented）时不跟着关设置（#380）', () => {
  const sheetClasses = new Set(['translate-y-full']);
  const classList = set => ({
    add: (...n) => n.forEach(x => set.add(x)),
    remove: (...n) => n.forEach(x => set.delete(x)),
    contains: n => set.has(n),
  });
  const context = createAppContext({
    dom: {
      settingsSheet: {
        classList: classList(sheetClasses), scrollTop: 0, inert: false, dataset: {},
        contains: () => false, hasAttribute: () => true, setAttribute: () => {}, focus: () => {},
      },
      settingsSheetBody: { scrollTop: 0 },
      settingsScrim: { classList: classList(new Set(['hidden'])) },
    },
  });
  const keydown = [];
  const fakeDoc = {
    documentElement: { classList: classList(new Set()), dataset: {} },
    body: { classList: classList(new Set()) },
    activeElement: null,
    addEventListener: (type, fn) => { if (type === 'keydown') keydown.push(fn); },
  };
  const controller = createSettingsController(context, {
    alerts: { preferences: () => ({ sound: false, vibrate: false, foregroundComplete: false }), ensureAudio: () => {} },
    syncPrefs: false,
    doc: fakeDoc,
  });
  const esc = extra => {
    const ev = { key: 'Escape', defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...extra };
    keydown.forEach(fn => fn(ev));
  };
  assert.equal(keydown.length, 1, '设置控制器应挂上 keydown');

  controller.open();
  assert.equal(sheetClasses.has('translate-y-full'), false);
  esc({ defaultPrevented: true }); // appConfirm 叠在设置上：sheets.js 已收掉栈顶并 preventDefault
  assert.equal(sheetClasses.has('translate-y-full'), false, '上层 sheet 的 Esc 把设置面板也一起关了');
  esc({ isComposing: true });
  assert.equal(sheetClasses.has('translate-y-full'), false, '取消输入法候选的 Esc 关掉了设置');
  esc();
  assert.equal(sheetClasses.has('translate-y-full'), true, '设置自己在顶层时 Esc 应关闭');
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

// ---- createUnreadTracker：R65（2026-08-30 需求合稿）未读点的本设备已读表 + 手动未读（长按「标为未读」）----
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
    assert.equal(tracker.isUnread(old, { isViewing: true }), true, '正看着时标的「稍后再看」当场就要亮（2026-09-07 翻向）');
    assert.equal(tracker.isManualUnread('s1'), true, '手动标记表的直读口（长按菜单已改问 isUnread）');
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

  // ---- 跨设备共享（2026-09-03）：本地表降级为离线缓存，权威位点在服务端 ----
  test('★ 离场 markSeen 在手动未读态下必须跳过记 seen——新判据 manual>seen 下写了就等于当场清掉标记', () => {
    let now = T0 + 10;
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {} }));
    const tracker = createUnreadTracker({ storage, now: () => now });
    tracker.setManualUnread('s1', true);
    now += 5;
    tracker.markSeen('s1');
    assert.equal(JSON.parse(storage.dump()).seen.s1, undefined, 'seen 不得被写进去');
    assert.equal(tracker.isUnread({ id: 's1', lastUsedAt: T0 - 1000 }), true, '标记活过离开');
  });

  test('hydrate：服务端基线覆盖本地，seen/manual 取较晚，结果落盘', () => {
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: { a: T0 + 10 }, manual: {} }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 500 });
    tracker.hydrate({ baselineTs: T0 + 100, seen: { a: T0 + 5, b: T0 + 200 }, manual: {} });
    const persisted = JSON.parse(storage.dump());
    assert.equal(persisted.baselineTs, T0 + 100);
    assert.equal(persisted.seen.a, T0 + 10, '本地更晚 → 保本地');
    assert.equal(persisted.seen.b, T0 + 200, '远端独有 → 补进来');
  });

  test('★ 跨设备主场景：本设备从没看过、但服务端有更晚的 seen → 不再亮（就是这次要修的那屏假未读）', () => {
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {}, manual: {} }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 500 });
    const s = { id: 's9', lastUsedAt: T0 + 100 };
    assert.equal(tracker.isUnread(s), true, '修复前：本设备没看过 + 活动晚于本机基线 → 亮');
    tracker.hydrate({ baselineTs: T0, seen: { s9: T0 + 200 }, manual: {} });
    assert.equal(tracker.isUnread(s), false, '另一台设备读过 → 不亮');
  });

  test('★ 手动未读跨设备：另一台设备在标记之后打开过 → 标记失效（时间戳比大小，不靠删条目）', () => {
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {}, manual: { s1: T0 + 100 } }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 500 });
    const s = { id: 's1', lastUsedAt: T0 - 1000 };
    assert.equal(tracker.isUnread(s), true);
    tracker.hydrate({ baselineTs: T0, seen: { s1: T0 + 200 }, manual: { s1: T0 + 100 } });
    assert.equal(tracker.isUnread(s), false, 'seen 晚于 manual → 已读');
    assert.equal(tracker.isManualUnread('s1'), false, '长按菜单也要跟着改口，否则显示「标为已读」点了没反应');
  });

  // session:list 每趟都捎一份 readState 回来。hydrate 恒 true 会让每次 SWR revalidate 都重建列表
  // DOM 子树，打掉 shouldRerenderSessionList 的省渲优化——返回值必须是「内容真变了吗」。
  test('★ hydrate 返回「内容是否真变」：同一份远端态重复灌入 → false，不触发重渲染', () => {
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {}, manual: {} }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 500 });
    const remote = { baselineTs: T0, seen: { a: T0 + 5 }, manual: {} };
    assert.equal(tracker.hydrate(remote), true, '第一次带来新信息');
    assert.equal(tracker.hydrate(remote), false, '第二次内容没变');
    assert.equal(tracker.hydrate({ baselineTs: T0, seen: { a: T0 + 1 }, manual: {} }), false, '更旧的远端值被 max 吃掉，内容仍没变');
    assert.equal(tracker.hydrate({ baselineTs: T0, seen: { a: T0 + 9 }, manual: {} }), true);
  });

  test('hydrate 拿到无效远端态（离线 / ack 超时）→ 本地原样保留，绝不清空', () => {
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: { a: T0 + 10 }, manual: {} }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 500 });
    for (const bad of [null, undefined, {}, 'x']) tracker.hydrate(bad);
    // folders：文件夹「全部标为已读」的水位，随 snapshot 走 read:sync（见下方 markAllRead 带文件夹那条）
    assert.deepEqual(tracker.snapshot(), { baselineTs: T0, seen: { a: T0 + 10 }, manual: {}, folders: {} });
  });

  test('snapshot 供连上后上推本地表；返回副本，调用方改不动内部状态', () => {
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: { a: T0 }, manual: {} }));
    const tracker = createUnreadTracker({ storage, now: () => T0 });
    const snap = tracker.snapshot();
    snap.seen.hacked = T0;
    assert.deepEqual(tracker.snapshot().seen, { a: T0 });
  });

  test('onChange 在三个写入点上报增量，供 app.js 转成 read:mark（hydrate 不回声）', () => {
    const events = [];
    const tracker = createUnreadTracker({
      storage: memoryStorage(JSON.stringify({ baselineTs: T0, seen: {}, manual: {} })),
      now: () => T0 + 10,
      onChange: e => events.push(e),
    });
    tracker.markEntered('s1');
    tracker.setManualUnread('s2', true);
    tracker.setManualUnread('s2', false);
    tracker.hydrate({ baselineTs: T0, seen: { s5: T0 }, manual: {} });
    assert.deepEqual(events, [
      { sessionId: 's1', seenAt: T0 + 10 },
      { sessionId: 's2', manual: true, at: T0 + 10 },
      { sessionId: 's2', manual: false, at: T0 + 10 },
    ], 'hydrate 是下行同步，回声会绕成写放大');
  });

  test('onChange 未注入时（离线壳 / 老接线）三个写入点照常工作', () => {
    const tracker = createUnreadTracker({ storage: memoryStorage(), now: () => T0 });
    assert.doesNotThrow(() => { tracker.markEntered('s1'); tracker.markSeen('s1'); tracker.setManualUnread('s2', true); });
  });

  // 文件夹长按「全部标为已读」（#300）：每个目标都要同时记 seen、清手动标记，逐条走 read:mark 的
  // 「标为已读」形状上报——只记 seen 的话服务端那份旧 manual 不清，旧设备回连照样能把它合并回来。
  test('markAllRead：一批会话全部变已读（含手动标未读的），落盘且逐条上报「标为已读」', () => {
    const events = [];
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {}, manual: { m: T0 + 1 } }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 10, onChange: e => events.push(e) });
    const rows = [{ id: 'a', lastUsedAt: T0 + 5 }, { id: 'm', lastUsedAt: T0 - 100 }];
    assert.deepEqual(rows.map(r => tracker.isUnread(r, { isViewing: r.id === 'm' })), [true, true], '前提：一条按时间亮、一条是正看着却手动标的');

    tracker.markAllRead(['a', 'm']);

    assert.deepEqual(rows.map(r => tracker.isUnread(r, { isViewing: r.id === 'm' })), [false, false]);
    const persisted = JSON.parse(storage.dump());
    assert.deepEqual(persisted.manual, {}, '手动标记清掉');
    assert.deepEqual(persisted.seen, { a: T0 + 10, m: T0 + 10 });
    assert.deepEqual(events, [
      { sessionId: 'a', manual: false, at: T0 + 10 },
      { sessionId: 'm', manual: false, at: T0 + 10 },
    ], '复用单条「标为已读」的上报形状，服务端走同一条写入路径');
  });

  // 一个分组最多画出 500（浏览窗口硬顶）+ 100（稍后再看，受 MANUAL_CAP）+ 20（live 实例上限）行。
  // 本地表装不下这一批时，同一批里先写的位点被挤掉，重新加载后那几行又亮——服务端那份同理，见 READ-01。
  test('markAllRead 一次标完最大的分组：重新加载后同一批一条不少（表里原本已满也一样）', () => {
    const old = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`old-${i}`, T0 + i]));
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: old, manual: {} }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 10_000 });
    const batch = Array.from({ length: 620 }, (_, i) => ({ id: `group-${i}`, lastUsedAt: T0 + 5_000 }));
    tracker.markAllRead(batch.map(s => s.id));

    const reloaded = createUnreadTracker({ storage, now: () => T0 + 20_000 });
    const relit = batch.filter(s => reloaded.isUnread(s)).length;
    assert.equal(relit, 0, `重新加载后 ${relit} 行重新亮起未读`);
  });

  // 2026-10-26 真机：「全部标为已读」只标得到屏幕上那几行，更早的没加载出来，「显示更多」拉出一片未读。
  // 现在另报一条文件夹水位，由服务端在 session:list 回执里折进每行（READ-01）。上报发不出去（离线）时
  // 水位留在本地，随 read:sync 的 snapshot 带上去——与逐条位点同一条补偿路径。
  test('markAllRead 带文件夹：逐条上报之外再报一条水位；水位落盘、进 snapshot', () => {
    const events = [];
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {}, manual: {} }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 10, onChange: e => events.push(e) });
    tracker.markAllRead(['a'], '/repo');
    assert.deepEqual(events, [
      { sessionId: 'a', manual: false, at: T0 + 10 },
      { folder: '/repo', at: T0 + 10 },
    ]);
    assert.deepEqual(tracker.snapshot().folders, { '/repo': T0 + 10 });
    const reloaded = createUnreadTracker({ storage, now: () => T0 + 20 });
    assert.deepEqual(reloaded.snapshot().folders, { '/repo': T0 + 10 }, '离线时报不出去，重开 app 后要靠这份去 read:sync');
  });

  test('hydrate 不抹掉本地水位（服务端回执不搬这张表）', () => {
    const storage = memoryStorage(JSON.stringify({ baselineTs: T0, seen: {}, manual: {}, folders: { '/repo': T0 + 5 } }));
    const tracker = createUnreadTracker({ storage, now: () => T0 + 500 });
    tracker.hydrate({ baselineTs: T0, seen: { s: T0 + 1 }, manual: {} });
    assert.deepEqual(tracker.snapshot().folders, { '/repo': T0 + 5 });
    assert.deepEqual(JSON.parse(storage.dump()).folders, { '/repo': T0 + 5 });
  });
});


// ── createDrawerUnreadJump ─────────────────────────────────────────────────
// 目录头「N 未读」角标点击 → 依次跳到下一条未读行。游标必须活过目录子树的整段替换
// （rebuildDirSections 会换掉 dirRow/subtree 节点），所以它归模块自己持有、不挂 DOM。
function fakeRow(hasUnreadMark) {
  const classes = new Set();
  return {
    classes,
    offsetWidth: 0,
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
    },
    querySelector: sel => (hasUnreadMark && sel === '[data-testid="unread-mark"]' ? {} : null),
  };
}
function fakeSection(rows, { connected = true } = {}) {
  return {
    dirRow: {},
    subtree: {
      isConnected: connected,
      querySelectorAll: sel => (sel === '[data-testid="session-row"]' ? rows : []),
    },
  };
}

test('drawer unread jump cycles through unread rows and wraps around', () => {
  const rows = [fakeRow(false), fakeRow(true), fakeRow(false), fakeRow(true)];
  const scrolled = [];
  const jump = createDrawerUnreadJump({
    getSection: () => fakeSection(rows),
    scroll: node => scrolled.push(rows.indexOf(node)),
    setTimer: () => {},
  });

  assert.equal(jump.request('/w'), true);
  assert.equal(jump.request('/w'), true);
  assert.equal(jump.request('/w'), true);
  // 只落在带未读标记的两行上，第三次绕回第一条——只跳第一条的话 4 条未读里另外 3 条永远够不着
  assert.deepEqual(scrolled, [1, 3, 1]);
  assert.equal(rows[1].classes.has('drawer-row-flash'), true, '落点要闪一下，否则用户不知道跳到哪了');
  assert.equal(rows[0].classes.has('drawer-row-flash'), false);
});

test('drawer unread jump reports false when there is nothing unread to jump to', () => {
  const jump = createDrawerUnreadJump({ getSection: () => fakeSection([fakeRow(false)]), setTimer: () => {} });
  assert.equal(jump.request('/w'), false);
});

test('drawer unread jump does not touch a subtree that was replaced out of the DOM', () => {
  const jump = createDrawerUnreadJump({
    getSection: () => fakeSection([fakeRow(true)], { connected: false }),
    setTimer: () => {},
  });
  assert.equal(jump.request('/w'), false);
  assert.equal(jump.request('/nope'), false); // getSection 返回 undefined 的分支同样不抛
});

test('drawer unread jump on a collapsed dir expands first, then jumps when rows arrive', () => {
  let expanded = false;
  const rows = [fakeRow(true)];
  const scrolled = [];
  const jump = createDrawerUnreadJump({
    getSection: () => fakeSection(rows),
    isExpanded: () => expanded,
    expandDir: () => { expanded = true; },
    scroll: node => scrolled.push(node),
    setTimer: () => {},
  });

  // 折叠态：子树还没渲染出行，同步跳只会跳空——先展开，记下意图
  assert.equal(jump.request('/w'), false);
  assert.equal(expanded, true);
  assert.deepEqual(scrolled, []);

  // renderRows 末尾把跳转补上，且只补一次：不然此后每 12 秒一次的 background revalidate 都会重跳
  assert.equal(jump.flushPendingJump('/w'), true);
  assert.equal(scrolled.length, 1);
  assert.equal(jump.flushPendingJump('/w'), false);
  assert.equal(scrolled.length, 1);
});

test('drawer unread jump only flushes for the dir that was actually requested', () => {
  const jump = createDrawerUnreadJump({
    getSection: () => fakeSection([fakeRow(true)]),
    isExpanded: () => false,
    scroll: () => {},
    setTimer: () => {},
  });
  jump.request('/w');
  assert.equal(jump.flushPendingJump('/other'), false, '别的目录渲染完不该顺手把这次跳转消费掉');
  assert.equal(jump.flushPendingJump('/w'), true);
});

test('drawer unread jump keeps its cursor across subtree rebuilds, and resets on collapse', () => {
  const scrolled = [];
  let rows = [fakeRow(true), fakeRow(true)];
  const jump = createDrawerUnreadJump({
    // 每次都返回新 section 对象：模拟 rebuildDirSections 换掉 dirRow/subtree 节点
    getSection: () => fakeSection(rows),
    scroll: node => scrolled.push(rows.indexOf(node)),
    setTimer: () => {},
  });

  jump.request('/w');
  rows = [fakeRow(true), fakeRow(true)]; // 子树整段重建（read:sync 回来重画未读标记就会触发）
  jump.request('/w');
  assert.deepEqual(scrolled, [0, 1], '游标挂在 DOM 上的话这里会退回 0，用户连点两次都跳同一行');

  jump.resetCursor('/w'); // 折叠目录：下次点开从第一条重新数起
  jump.request('/w');
  assert.deepEqual(scrolled, [0, 1, 0]);
});

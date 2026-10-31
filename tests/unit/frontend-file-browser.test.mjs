// tests/unit/frontend-file-browser.test.mjs —— 文件 tab 控制器（app/public/js/app/file-browser.js）对迟到回执的处置
//
// browse:read 的回执是异步的：慢网下打开文件、返回、再打开同一个文件，两次请求的回执都会到。
// 两次请求的路径相同，只比路径的话两份正文都被接上，正文变成两遍；而 baseHash 仍是磁盘上那份的合法哈希，
// 点「编辑 → 保存」会把两遍的正文写回磁盘，服务端的冲突检查认不出来。
// CodeMirror 脚本是第一次打开文件时才按需拉的，正文到了还要等它，这段等待是同一类窗口。
// DOM 用最小桩（同 frontend-drawer.test.mjs 的做法），CodeMirror 用一个只记 value 的替身；
// 脚本加载是网络边界，用例自己决定什么时候触发 onload。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppContext } from '../../app/public/js/app/context.js';
import { createFileBrowser } from '../../app/public/js/app/file-browser.js';

function fakeEl() {
  const classes = new Set();
  const el = {
    onclick: null,
    textContent: '',
    className: '',
    disabled: false,
    children: [],
    appendChild(child) { el.children.push(child); return child; },
    set innerHTML(_v) { el.children = []; },
    get innerHTML() { return ''; },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: c => classes.has(c),
    },
  };
  return el;
}

function harness() {
  const dom = {
    fileBrowseBody: fakeEl(), fileBrowseBack: fakeEl(), fileBrowsePath: fakeEl(),
    fileBrowseEdit: fakeEl(), fileBrowseSave: fakeEl(), fileBrowseCancelEdit: fakeEl(), fileBrowseSaveError: fakeEl(),
  };
  const head = fakeEl(); // 按需插入的 CodeMirror <script> 落在这里
  const context = createAppContext({ dom, dependencies: { document: { createElement: () => fakeEl(), head } } });
  const sent = []; // { event, payload, ack }：回执由用例决定何时、按什么顺序放行
  context.setSocket({ emit: (event, payload, ack) => sent.push({ event, payload, ack }) });
  const ctl = createFileBrowser(context, { createElement: () => fakeEl() });
  const pending = event => sent.filter(s => s.event === event);
  const rowNamed = name => dom.fileBrowseBody.children.find(row => row.children?.[1]?.textContent === name);
  return { ctl, dom, head, pending, rowNamed };
}

function fakeCodeMirror(editors) {
  return (_holder, opts) => {
    const cm = { value: opts.value, getValue: () => cm.value, setValue: v => { cm.value = v; }, setOption() {}, focus() {} };
    editors.push(cm);
    return cm;
  };
}

test('#473 同名相对目录的旧回执不得覆盖新 worktree', () => {
  const { ctl, pending, rowNamed } = harness();
  ctl.open('/old');
  ctl.open('/new');
  const requests = pending('browse:list');
  requests[1].ack({ ok: true, entries: [{ name: 'NEW_CODE', kind: 'file', size: 1 }], truncated: false, totalCount: 1 });
  requests[0].ack({ ok: true, entries: [{ name: 'OLD_CODE', kind: 'file', size: 1 }], truncated: false, totalCount: 1 });
  assert.ok(rowNamed('NEW_CODE'));
  assert.equal(rowNamed('OLD_CODE'), undefined);
});

test('打开文件、返回、再打开同一个文件：两次读请求的回执都到了，正文和保存出去的内容都只有一份', async t => {
  const editors = [];
  globalThis.CodeMirror = fakeCodeMirror(editors);
  t.after(() => { delete globalThis.CodeMirror; });

  const { ctl, dom, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({ ok: true, entries: [{ name: 'a.js', kind: 'file', size: 6 }], truncated: false, totalCount: 1 });
  rowNamed('a.js').onclick();          // 第一次打开，回执还在路上
  await ctl.back();                    // 返回列表
  rowNamed('a.js').onclick();          // 再打开同一个文件
  const reads = pending('browse:read');
  assert.equal(reads.length, 2, '两次打开应发出两次读请求');
  const reply = { ok: true, content: 'hello\n', bytesRead: 6, truncated: false, totalSize: 6, contentHash: 'h-disk' };
  reads[0].ack(reply);                 // 第一次的回执迟到
  reads[1].ack(reply);

  assert.equal(editors.at(-1).getValue(), 'hello\n', '同一个文件的正文被接了两遍');
  dom.fileBrowseEdit.onclick();
  dom.fileBrowseSave.onclick();
  const write = pending('files:write')[0];
  assert.ok(write, '可编辑的小文件点「保存」应发出 files:write');
  assert.equal(write.payload.content, 'hello\n', '保存把重复的正文带着合法的 baseHash 写回了磁盘');
});

test('CodeMirror 还在加载时换到另一个文件：先到的旧正文不得接进新文件，再随新文件的 baseHash 保存出去', async t => {
  const { ctl, dom, head, pending, rowNamed } = harness();
  ctl.open('/w');
  pending('browse:list')[0].ack({
    ok: true, truncated: false, totalCount: 2,
    entries: [{ name: 'a.js', kind: 'file', size: 2 }, { name: 'b.js', kind: 'file', size: 2 }],
  });
  rowNamed('a.js').onclick();          // 第一次打开文件，CodeMirror 开始按需加载
  pending('browse:read')[0].ack({ ok: true, content: 'A\n', bytesRead: 2, truncated: false, totalSize: 2, contentHash: 'h-a' });
  await ctl.back();                    // 正文到了、CM 还没拉完，用户返回
  rowNamed('b.js').onclick();          // 打开另一个文件
  pending('browse:read')[1].ack({ ok: true, content: 'B\n', bytesRead: 2, truncated: false, totalSize: 2, contentHash: 'h-b' });

  const editors = [];
  globalThis.CodeMirror = fakeCodeMirror(editors); // CM 脚本这时才拉完
  t.after(() => { delete globalThis.CodeMirror; });
  assert.ok(head.children.length > 0, '第一次打开文件没有插入 CodeMirror 脚本');
  for (const script of head.children) script.onload();
  await new Promise(setImmediate);

  assert.equal(editors.at(-1)?.getValue(), 'B\n', 'a.js 的正文被接进了 b.js 的视图');
  dom.fileBrowseEdit.onclick();
  dom.fileBrowseSave.onclick();
  const write = pending('files:write')[0];
  assert.ok(write, '可编辑的小文件点「保存」应发出 files:write');
  assert.deepEqual([write.payload.relPath, write.payload.content, write.payload.baseHash], ['b.js', 'B\n', 'h-b'],
    '保存把 a.js 的正文带着 b.js 的 baseHash 写进了 b.js');
});

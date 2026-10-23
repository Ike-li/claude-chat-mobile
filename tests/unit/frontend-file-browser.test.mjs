// tests/unit/frontend-file-browser.test.mjs —— 文件 tab 控制器（app/public/js/app/file-browser.js）对迟到回执的处置
//
// browse:read 的回执是异步的：慢网下打开文件、返回、再打开同一个文件，两次请求的回执都会到。
// 两次请求的路径相同，只比路径的话两份正文都被接上，正文变成两遍；而 baseHash 仍是磁盘上那份的合法哈希，
// 点「编辑 → 保存」会把两遍的正文写回磁盘，服务端的冲突检查认不出来。
// DOM 用最小桩（同 frontend-drawer.test.mjs 的做法），CodeMirror 用一个只记 value 的替身。
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
  const context = createAppContext({ dom, dependencies: { document: { createElement: () => fakeEl() } } });
  const sent = []; // { event, payload, ack }：回执由用例决定何时、按什么顺序放行
  context.setSocket({ emit: (event, payload, ack) => sent.push({ event, payload, ack }) });
  const ctl = createFileBrowser(context, { createElement: () => fakeEl() });
  const pending = event => sent.filter(s => s.event === event);
  const rowNamed = name => dom.fileBrowseBody.children.find(row => row.children?.[1]?.textContent === name);
  return { ctl, dom, pending, rowNamed };
}

test('打开文件、返回、再打开同一个文件：两次读请求的回执都到了，正文和保存出去的内容都只有一份', async t => {
  const editors = [];
  globalThis.CodeMirror = (_holder, opts) => {
    const cm = { value: opts.value, getValue: () => cm.value, setValue: v => { cm.value = v; }, setOption() {}, focus() {} };
    editors.push(cm);
    return cm;
  };
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

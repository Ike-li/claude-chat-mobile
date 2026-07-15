// smoke runner `upload` —— E17 文件/图片上传真实验收。
// 用法：npm run test:smoke -- --scenario upload；零 token 逻辑由 tests/unit/uploads.test.mjs 覆盖。
//     e2e 证：上传 .txt → 落盘 → 路径注入 → claude Read → 暗号原样回显；user_message 回执仅元数据无完整 data
import { io } from 'socket.io-client';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const finish = () => {
  console.log(`\n=== upload 结果: ${results.filter(r => r.ok).length}/${results.length} 通过 ===`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
};

// ───────────────────────────── --unit ─────────────────────────────
if (process.argv.includes('--unit')) {
  const { sanitizeName, validateAttachments, saveAttachments, buildPromptText, toEventMeta, UPLOAD_DIR } =
    await import('../../../src/files/uploads.js');
  const b64 = s => Buffer.from(s).toString('base64');

  // U1 sanitizeName：basename 去路径、去前导点、显式去分隔字符、空回退
  check('U1-去路径段', sanitizeName('../../etc/passwd') === 'passwd', sanitizeName('../../etc/passwd'));
  check('U1-斜杠取尾', sanitizeName('foo/bar.txt') === 'bar.txt');
  check('U1-反斜杠替换', sanitizeName('a\\b.txt') === 'a_b.txt', sanitizeName('a\\b.txt'));
  check('U1-纯点回退', sanitizeName('..') === 'file' && sanitizeName('') === 'file');
  check('U1-去前导点', sanitizeName('.hidden') === 'hidden');

  // U2 validateAttachments
  check('U2-无附件 null', validateAttachments(undefined) === null && validateAttachments([]) === null);
  check('U2-缺数据', /缺少数据/.test(validateAttachments([{ name: 'a', mimeType: 't' }]) || ''));
  check('U2-缺 name/mime', /name\/mimeType/.test(validateAttachments([{ data: b64('x') }]) || ''));
  const ok1 = validateAttachments([{ name: 'a.txt', mimeType: 'text/plain', data: b64('hello') }]);
  check('U2-合法通过', ok1 === null, String(ok1));
  const tooMany = Array.from({ length: 11 }, () => ({ name: 'a', mimeType: 't', data: b64('x') }));
  check('U2-条数超限', /过多/.test(validateAttachments(tooMany) || ''));
  const big = b64('x'.repeat(11 * 1024 * 1024));
  check('U2-单文件超限', /过大/.test(validateAttachments([{ name: 'big', mimeType: 't', data: big }]) || ''));

  // U3 saveAttachments：真写盘 + 落点在 .ccm-uploads 内 + 内容正确 + 恶意名仍不逃逸
  const tmp = mkdtempSync(join(tmpdir(), 'ccm-upload-'));
  try {
    const saved = await saveAttachments(tmp, [
      { name: 'note.txt', mimeType: 'text/plain', data: b64('暗号 BANANA') },
      { name: '../../../evil.sh', mimeType: 'text/plain', data: b64('rm -rf') }
    ]);
    const dir = join(tmp, UPLOAD_DIR);
    check('U3-落盘子目录', saved.every(s => s.absPath.startsWith(dir + '/')), saved.map(s => s.absPath).join(' , '));
    check('U3-内容正确', readFileSync(saved[0].absPath, 'utf8') === '暗号 BANANA');
    check('U3-恶意名不逃逸', saved[1].absPath.startsWith(dir + '/'), saved[1].absPath);
    check('U3-写了 2 个文件', readdirSync(dir).length === 2);

    // U4 buildPromptText：原文 + 附件段；空文本仅附件段
    const pt = buildPromptText('看下这个', saved);
    check('U4-含原文与路径', pt.startsWith('看下这个') && pt.includes(saved[0].absPath) && pt.includes('[附件]'));
    const ptEmpty = buildPromptText('', saved);
    check('U4-空文本仅附件段', ptEmpty.startsWith('[附件]') && ptEmpty.includes(saved[1].absPath));
    check('U4-无附件原样', buildPromptText('hi', []) === 'hi');

    // U5 toEventMeta：剥 absPath/data，留 thumb
    const meta = toEventMeta([{ absPath: '/x', name: 'a', mimeType: 't', size: 3, thumb: 'data:img', data: 'XXX' }]);
    check('U5-剥 absPath/data 留 thumb',
      meta[0].absPath === undefined && meta[0].data === undefined
      && meta[0].name === 'a' && meta[0].size === 3 && meta[0].thumb === 'data:img');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  finish();
}

// ───────────────────────────── e2e ─────────────────────────────
const SECRET = 'BANANA-7391';
const smokeUrl = process.env.CCM_SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
const socket = io(smokeUrl, { reconnection: false, timeout: 5000 });
let acc = '';                 // 累积 assistant 文本
let userMsg = null;           // user_message 回执 payload
const timer = setTimeout(() => { check('e2e-超时未完成', false, '15s 内无 result'); cleanup(); }, 15000);

function cleanup() {
  clearTimeout(timer);
  socket.close();
  finish();
}

socket.on('connect_error', err => { check('e2e-连接', false, err.message); cleanup(); });
socket.on('connect', () => {
  socket.emit('session:new', () => {
    const data = Buffer.from(`这是一个测试文件。暗号是 ${SECRET}。`).toString('base64');
    socket.emit('user:message', {
      text: '读取我上传的附件文件，把其中的暗号原样输出（只输出暗号本身）。',
      attachments: [{ name: 'secret.txt', mimeType: 'text/plain', size: 40, data }]
    });
  });
});
socket.on('agent:event', ev => {
  const { type, payload } = ev;
  if (type === 'user_message') userMsg = payload;
  else if (type === 'text_delta') acc += payload.text;
  else if (type === 'error') { check('e2e-无 error', false, payload.message); cleanup(); }
  else if (type === 'result') {
    // 回执契约：user_message 带附件元数据、但不含完整 data（仅 name/mimeType/size，可选 thumb）
    const a = userMsg?.attachments?.[0];
    check('e2e-回执含附件元数据', !!a && a.name === 'secret.txt' && a.data === undefined,
      JSON.stringify(userMsg?.attachments));
    // 暗号回显 = 落盘 + 路径注入 + claude Read 全链路打通
    check('e2e-claude 读到附件暗号', acc.includes(SECRET), acc.slice(0, 120));
    cleanup();
  }
});

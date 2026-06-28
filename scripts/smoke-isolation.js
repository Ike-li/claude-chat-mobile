// smoke-isolation.js —— 会话列表 cwd 隔离 + ~/.claude 扫描单测（零 token，不需 server）
// 验收 台阶0：
//   - listSessions 按 cwd 隔离、从 jsonl head 提取 title/model/entrypoint、按 mtime 降序；
//   - sessionFileExists 归属校验（本 cwd 命中 / 跨 cwd 与失效 id 不命中）；
//   - getProjectDir 编码与 CLI 一致（含 /private/tmp 与连续 dash 不折叠）。
// 用法: node scripts/smoke-isolation.js [--unit]   （--unit 仅为对齐约定，行为一致）
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listSessions, sessionFileExists, getProjectDir } from '../history.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const jl = (...objs) => objs.map(o => JSON.stringify(o)).join('\n') + '\n';

// ---- 夹具：临时 baseDir 下造两个 cwd 的 project 目录 ----
const base = mkdtempSync(join(tmpdir(), 'ccm-iso-'));
const cwdA = '/iso/projA', cwdB = '/iso/projB';
const dirA = join(base, getProjectDir(cwdA));
const dirB = join(base, getProjectDir(cwdB));
mkdirSync(dirA, { recursive: true });
mkdirSync(dirB, { recursive: true });

// A1（cli）：summary 噪声 + isMeta user（title 应跳过）+ 真实 user（title）+ assistant（model）
writeFileSync(join(dirA, 'A1.jsonl'), jl(
  { type: 'summary', summary: 'x' },
  { type: 'user', isMeta: true, entrypoint: 'cli', message: { content: [{ type: 'text', text: 'META-IGNORE' }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '标题A1真实' }] } },
  { type: 'assistant', message: { role: 'assistant', model: 'model-a1', content: [{ type: 'text', text: 'hi' }] } }
));
// A2（sdk-ts）
writeFileSync(join(dirA, 'A2.jsonl'), jl(
  { type: 'user', entrypoint: 'sdk-ts', message: { content: [{ type: 'text', text: '标题A2' }] } },
  { type: 'assistant', message: { model: 'model-a2', content: [] } }
));
// B1（另一个 cwd，应被隔离，不出现在 cwdA 列表）
writeFileSync(join(dirB, 'B1.jsonl'), jl(
  { type: 'user', entrypoint: 'cli', message: { content: [{ type: 'text', text: '标题B1' }] } }
));

// C：标题提取优先级（cwdC）——ai-title > 真实 user > 命令名
const cwdC = '/iso/projC';
const dirC = join(base, getProjectDir(cwdC));
mkdirSync(dirC, { recursive: true });
// C1：仅命令包裹 → 标题取命令名 /clear
writeFileSync(join(dirC, 'C1.jsonl'), jl(
  { type: 'user', entrypoint: 'cli', message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>' } }
));
// C2：命令包裹在前、真实 user 在后 → 标题取真实 user（跳过命令）
writeFileSync(join(dirC, 'C2.jsonl'), jl(
  { type: 'user', entrypoint: 'cli', message: { content: '<command-name>/model</command-name>' } },
  { type: 'user', message: { content: [{ type: 'text', text: '真实问题C2' }] } }
));
// C3：有 ai-title（命令在前）→ 标题取 ai-title
writeFileSync(join(dirC, 'C3.jsonl'), jl(
  { type: 'user', entrypoint: 'cli', message: { content: '<command-name>/clear</command-name>' } },
  { type: 'ai-title', aiTitle: '生成的标题C3' }
));
// C4：本地命令 stdout 包裹在前、真实 user 在后 → 跳过包裹取真实 user
writeFileSync(join(dirC, 'C4.jsonl'), jl(
  { type: 'user', entrypoint: 'sdk-ts', message: { content: '<local-command-stdout>Set model to claude-x</local-command-stdout>' } },
  { type: 'user', message: { content: [{ type: 'text', text: '真实问题C4' }] } }
));

// mtime：A2 比 A1 新 → 列表中 A2 在前（按 mtime 降序）
const now = Date.now() / 1000;
utimesSync(join(dirA, 'A1.jsonl'), now - 100, now - 100);
utimesSync(join(dirA, 'A2.jsonl'), now, now);

const run = async () => {
  const a = await listSessions(cwdA, { baseDir: base });
  check('cwdA 列表含 2 条（隔离掉 B）', a.length === 2, `len=${a.length}`);
  check('按 mtime 降序（A2 在前）', a[0]?.id === 'A2' && a[1]?.id === 'A1', a.map(s => s.id).join(','));

  const a1 = a.find(s => s.id === 'A1') || {};
  check('A1 标题跳过 isMeta 取真实 user', a1.title === '标题A1真实', String(a1.title));
  check('A1 model 取首条 assistant.message.model', a1.model === 'model-a1', String(a1.model));
  check('A1 entrypoint=cli', a1.entrypoint === 'cli', String(a1.entrypoint));

  const a2 = a.find(s => s.id === 'A2') || {};
  check('A2 entrypoint=sdk-ts 且 model=model-a2', a2.entrypoint === 'sdk-ts' && a2.model === 'model-a2', `${a2.entrypoint}/${a2.model}`);
  check('cwdA 不含 B1（隔离）', !a.some(s => s.id === 'B1'), 'ok');

  const b = await listSessions(cwdB, { baseDir: base });
  check('cwdB 列表含 1 条且标题正确', b.length === 1 && b[0]?.title === '标题B1', `len=${b.length}`);

  const c = await listSessions(cwdC, { baseDir: base });
  const byId = Object.fromEntries(c.map(s => [s.id, s]));
  check('C1 仅命令包裹 → 标题取命令名', byId.C1?.title === '/clear', byId.C1?.title);
  check('C2 跳过命令取真实 user', byId.C2?.title === '真实问题C2', byId.C2?.title);
  check('C3 优先 ai-title', byId.C3?.title === '生成的标题C3', byId.C3?.title);
  check('C4 跳过 local-command 包裹取真实 user', byId.C4?.title === '真实问题C4', byId.C4?.title);

  const none = await listSessions('/no/such/cwd', { baseDir: base });
  check('不存在的 cwd 目录 → []', Array.isArray(none) && none.length === 0, `len=${none.length}`);

  check('sessionFileExists 本 cwd 命中', (await sessionFileExists(cwdA, 'A1', { baseDir: base })) === true);
  check('sessionFileExists 跨 cwd 不命中（B1 不在 A）', (await sessionFileExists(cwdA, 'B1', { baseDir: base })) === false);
  check('sessionFileExists 失效 id 不命中', (await sessionFileExists(cwdA, 'nope', { baseDir: base })) === false);
  // 路径穿越守卫（/verify 抓出）：含 ../ 的 id 不得借 join 规范化越到别的 cwd 目录
  check('sessionFileExists 拒绝路径穿越 id',
    (await sessionFileExists(cwdB, `../${getProjectDir(cwdA)}/A1`, { baseDir: base })) === false);
  check('sessionFileExists 拒绝含斜杠 id', (await sessionFileExists(cwdA, 'a/b', { baseDir: base })) === false);
  check('sessionFileExists 拒绝空串 id', (await sessionFileExists(cwdA, '', { baseDir: base })) === false);

  check('getProjectDir 编码同 CLI（/private/tmp）',
    getProjectDir('/private/tmp/ccm-test') === '-private-tmp-ccm-test', getProjectDir('/private/tmp/ccm-test'));
  check('getProjectDir 不折叠连续 dash（/.）',
    getProjectDir('/Users/alice/.claude') === '-Users-alice--claude', getProjectDir('/Users/alice/.claude'));
};

run()
  .catch(err => { console.error('运行异常', err); results.push({ name: 'run', ok: false }); })
  .finally(() => {
    try { rmSync(base, { recursive: true, force: true }); } catch { /* 清理失败不致命 */ }
    const pass = results.filter(r => r.ok).length;
    console.log(`\n=== 隔离单测: ${pass}/${results.length} 通过 ===`);
    process.exit(pass === results.length ? 0 : 1);
  });

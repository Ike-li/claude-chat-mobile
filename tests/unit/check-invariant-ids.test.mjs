// tests/unit/check-invariant-ids.test.mjs —— 编号双向闸自己的两侧验收
//
// 钉住：这道闸的四种失效形态各能被抓住，且**真实仓库**当前是干净的。
// 每条用例都在一次性目录里造一棵最小的假仓库树（README + invariants 文件），
// 而不是改真实仓库——门禁的判据是「读什么文件」，用真树测就只能测到一种状态。
//
// 为什么这份测试必须存在：门禁是"守护者的守护者"，它自己失明的话，
// 编号悬空会在完全无症状的情况下重新长回来——那正是 2026-09-05 之前的状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkInvariantIds } from '../../tests/gates/check-invariant-ids.js';

// 造一棵最小假仓库：tests/README.md（登记表）+ tests/invariants/（用例）
function fakeRepo({ registryRows = [], files = {}, extraCorpus = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ccm-invid-'));
  mkdirSync(join(root, 'tests', 'invariants', 'server'), { recursive: true });
  const table = registryRows.map(([id, desc]) => `| \`${id}\` | ${desc} |`).join('\n');
  writeFileSync(join(root, 'tests', 'README.md'), `# tests\n\n| ID | 红线 |\n|---|---|\n${table}\n`);
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(join(root, 'tests', 'invariants', rel), body);
  }
  for (const [rel, body] of Object.entries(extraCorpus)) {
    mkdirSync(join(root, 'tests', rel.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(root, 'tests', rel), body);
  }
  return root;
}

const codes = result => result.problems.map(p => p.code).sort();

// ID_RE/REGISTRY_ROW_RE 此前是 /\b([A-Z]+-\d+)\b/，对 SRV-NEW-004 这类【多段】复合编号
// （连字符分隔的多个大写词 + 数字）只匹配得到最后一段 "NEW-004"——[A-Z]+ 不含连字符，
// \b 在 "SRV" 与 "-NEW" 之间不构成新的匹配起点，只有从 "NEW" 开始才第一次同时满足
// \b 与 [A-Z]+-\d+。报出来的 id 是错的，排查时对着登记表怎么查都查不到。
test('复合编号（多段连字符，如 SRV-NEW-004）双向闭合时报的 id 必须是完整那串，不是被截断的尾段', () => {
  const root = fakeRepo({
    registryRows: [['SRV-NEW-004', '附件落盘失败须结构化 permanent ack']],
    files: { 'srv.test.mjs': '// x\n// 守护：SRV-NEW-004（附件落盘失败）\n' },
  });
  try {
    const r = checkInvariantIds({ rootDir: root });
    // ok:true 单独看有可能是「两边都错误地截断成 NEW-004、意外还能配上」这种假阳性——
    // 真正的证明在下面那条反向用例：截断形态必须被识别成【不匹配】完整编号。
    assert.equal(r.ok, true, `应为绿，实际 ${JSON.stringify(r.problems)}`);
  } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
});

// 反向：复合编号在登记表里存在，但守护行写的是被截断的错误形态（模拟"截断 bug 存在时，
// 一个手误只打了后半段"这种更直接能看见坏处的场景）——必须报悬空引用，不能因为两边
// 恰好都截断成同一个错误字符串而被判成"匹配上了"。
test('复合编号：守护行若只写了截断的后半段（NEW-004），必须算未登记引用', () => {
  const root = fakeRepo({
    registryRows: [['SRV-NEW-004', '附件落盘失败须结构化 permanent ack']],
    files: { 'srv.test.mjs': '// x\n// 守护：NEW-004（这是错误的写法）\n' },
  });
  try {
    const r = checkInvariantIds({ rootDir: root });
    // 实测报的是 dead_registry_entry（"SRV-NEW-004" 在语料里确实一次没出现——"NEW-004" 不是
    // 它的子串），而不是 unregistered_id；两者都证明同一件事：截断后的 "NEW-004" 不会被
    // 误判成命中了完整编号 "SRV-NEW-004"，核心诉求就是这个，具体报哪个 code 不是本测试要钉的。
    assert.equal(r.ok, false, `截断形态不该被判成闭合，实际 ${JSON.stringify(r.problems)}`);
    assert.ok(codes(r).length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('绿侧：登记表与守护行双向闭合 → ok', () => {
  const root = fakeRepo({
    registryRows: [['AUTH-01', '未持令牌不得进数据面']],
    files: { 'auth.test.mjs': '// x\n// 守护：AUTH-01（令牌门）\n' },
  });
  try {
    const r = checkInvariantIds({ rootDir: root });
    assert.equal(r.ok, true, `应为绿，实际 ${JSON.stringify(r.problems)}`);
  } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
});

test('红侧①：invariants 下的文件没有「守护：」行 → missing_guard_line', () => {
  const root = fakeRepo({
    registryRows: [['AUTH-01', '令牌门']],
    files: { 'nope.test.mjs': '// 只有一句描述，没声明守哪条\n' },
  });
  try {
    const r = checkInvariantIds({ rootDir: root });
    assert.deepEqual(codes(r), ['dead_registry_entry', 'missing_guard_line'],
      '既要抓「没声明」，也要抓「AUTH-01 登记了却无人守」');
  } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
});

test('红侧②：守护行有但没编号 → guard_line_without_id（散文不能替代编号）', () => {
  const root = fakeRepo({
    registryRows: [['AUTH-01', '令牌门']],
    files: {
      'a.test.mjs': '// x\n// 守护：AUTH-01\n',
      'b.test.mjs': '// x\n// 守护：某种很重要的东西但我没写编号\n',
    },
  });
  try {
    const r = checkInvariantIds({ rootDir: root });
    assert.deepEqual(codes(r), ['guard_line_without_id']);
    assert.match(r.problems[0].file, /b\.test\.mjs$/);
  } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
});

test('红侧③：引用了登记表里没有的编号 → unregistered_id（这正是悬空引用的形态）', () => {
  const root = fakeRepo({
    registryRows: [['AUTH-01', '令牌门']],
    files: { 'a.test.mjs': '// x\n// 守护：AUTH-01、SRV-999（编造的）\n' },
  });
  try {
    const r = checkInvariantIds({ rootDir: root });
    assert.deepEqual(codes(r), ['unregistered_id']);
    assert.equal(r.problems[0].id, 'SRV-999');
  } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
});

test('红侧④：登记了却整棵 tests/ 树无人提及 → dead_registry_entry', () => {
  const root = fakeRepo({
    registryRows: [['AUTH-01', '令牌门'], ['GHOST-01', '写了但没人守']],
    files: { 'a.test.mjs': '// x\n// 守护：AUTH-01\n' },
  });
  try {
    const r = checkInvariantIds({ rootDir: root });
    assert.deepEqual(codes(r), ['dead_registry_entry']);
    assert.equal(r.problems[0].id, 'GHOST-01');
  } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
});

// 反向检查故意放宽到整棵 tests/ 树：PROTO-01 由 contract-check.js 守、TEST-01 由
// check-destructive-deletes.js 守，都不是 invariants/ 下的用例。只看守护行会把它们误报成死条目。
test('反向放宽：编号由门禁而非用例守护时不误报（PROTO-01 / TEST-01 的真实形态）', () => {
  const root = fakeRepo({
    registryRows: [['AUTH-01', '令牌门'], ['PROTO-01', '事件名单双向相等']],
    files: { 'a.test.mjs': '// x\n// 守护：AUTH-01\n' },
    extraCorpus: { 'gates/contract-check.js': '// 守护：PROTO-01（名单一致性由门禁守）\n' },
  });
  try {
    const r = checkInvariantIds({ rootDir: root });
    assert.equal(r.ok, true, `门禁里写了编号就该闭合，实际 ${JSON.stringify(r.problems)}`);
  } finally { rmSync(root, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
});

// 扫描面塌掉必须报错，不能静默当成「全部合规」——这是 repo-inventory 的同款判据。
test('扫描面塌了不得当成全绿：登记表读不到 / invariants 目录为空', () => {
  const noReadme = mkdtempSync(join(tmpdir(), 'ccm-invid-bare-'));
  try {
    mkdirSync(join(noReadme, 'tests', 'invariants'), { recursive: true });
    assert.deepEqual(codes(checkInvariantIds({ rootDir: noReadme })), ['registry_missing']);
  } finally { rmSync(noReadme, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录

  const empty = fakeRepo({ registryRows: [['AUTH-01', '令牌门']], files: {} });
  try {
    assert.deepEqual(codes(checkInvariantIds({ rootDir: empty })), ['scan_empty']);
  } finally { rmSync(empty, { recursive: true, force: true }); } // safe-rm: mkdtemp 一次性目录
});

test('真实仓库当前闭合（这条红了说明有人加了悬空编号或死条目）', () => {
  const r = checkInvariantIds();
  assert.equal(r.ok, true, r.problems.map(p => `[${p.code}] ${p.message}`).join('\n'));
  assert.ok(r.listed.length >= 25, `登记表条目数异常偏少（${r.listed.length}）——表格是不是被改坏了`);
});

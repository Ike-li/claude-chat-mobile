// tests/unit/cross-side-parity.test.mjs —— 前后端「同语义两份实现」的对照闸。
//
// 【为什么需要这道闸】模块边界闸（scripts/check-import-boundaries.js）禁止前后端互相 import，
// 这是对的。但它只保证了「不许共享代码」，**没有任何东西保证那两份代码等价** —— 于是每次
// 有人写下「与 xxx 同语义（两侧不能互相 import，边界闸）」这句注释，就诞生一对无人看管的孪生实现。
//
// 2026-08-27 实测到的后果（formatNotifyIdentity，两份都写着「同语义」）：
//   · sessionTitle='New session' → 前端识别为占位丢弃，后端当真标题推出去
//   · cwd='/'                    → 后端产出「✅ 完成 ·  · 改个bug」的空段，而它自己的注释
//                                  第 45 行正写着「避免『✅ 任务完成 · ·』这种空段」
//   · cwd='C:\code\proj'         → 后端 POSIX basename 不认反斜杠，整条路径进了横幅
// 两边各有一个测试文件，用例恰好都落在一致的区间（/a/proj + 正常标题），全绿了好几个月。
//
// 这是同型事故的复发：2026-08-05 的 outbox stale 死信也是「两个函数注释都写与对方对齐，
// 而那一维从没对齐」。教训是**别信注释，成对决策函数逐维对照**。本文件就是那个「逐维对照」。
//
// 【为什么带自动发现】只列举现有的几对，防不住下一对。下面第一条断言扫出前后端所有同名
// export，要求它们全部登记在 PAIRS 里 —— 新写一对孪生实现却不加对照用例，这条会红。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

// ── 自动发现：前后端同名 export ────────────────────────────────────────────
function exportedNames(file) {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/^export\s+function\s+([a-zA-Z_$][\w$]*)/gm)].map(m => m[1]);
}

function walkJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkJs(p));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

function collect(dir) {
  const map = new Map();                       // name → 文件路径
  for (const f of walkJs(dir)) for (const n of exportedNames(f)) map.set(n, f);
  return map;
}

// 已登记的孪生对：name → 对照用例。新增同名 export 必须在这里补一行，否则下面第一条断言红。
const PAIRS = {
  matchesSessionTitle: [
    ['proj', 'PROJ'], ['Proj', 'pro'], ['', 'x'], [null, 'x'], ['abc', ''], ['abc', '  '],
    ['abc', null], ['大小写ABC', 'abc'], ['abc', 'abc'], [undefined, undefined],
  ],
  sessionTitleSearchKeys: [
    [{ summary: 'a', aiTitle: 'b', firstUser: 'c', firstCmd: 'd' }],
    [{ summary: '  ', aiTitle: '', firstUser: null, firstCmd: undefined }],
    [{}], [undefined], [{ summary: '  x  ' }],
  ],
  matchesSessionSearch: [
    [['a', 'b'], 'A'], [[], 'x'], [null, 'x'], [['abc'], ''], [['abc'], null], [undefined, undefined],
  ],
  resolveSessionListTitle: [
    [{ summary: 's', metaTitle: 'm' }], [{ summary: '  ', metaTitle: 'm' }], [{}], [undefined],
    [{ metaTitle: 'x'.repeat(80) }], [{ metaTitle: '  ' }],
  ],
  sanitizeNotifySessionTitle: [
    ['改个bug'], ['  多  空白\n换行  '], ['新会话'], ['(无标题)'], ['New session'],
    ['x'.repeat(50)], ['x'.repeat(40)], [''], ['   '], [null], [undefined], [123],
  ],
  // ★ 这一组的每一行都对应上面注释里实测到的一处分叉，删任何一行都会让那个 bug 变得可回归。
  formatNotifyIdentity: [
    ['✅ 完成', { cwd: '/Users/x/code/proj', sessionTitle: '改bug' }],
    ['✅ 完成', { cwd: '/Users/x/code/proj/', sessionTitle: '改bug' }],   // 尾斜杠
    ['✅ 完成', { cwd: '/', sessionTitle: '改bug' }],                     // 根目录 → 曾产出空段
    ['✅ 完成', { cwd: '//', sessionTitle: '改bug' }],
    ['✅ 完成', { cwd: 'C:\\code\\proj', sessionTitle: '改bug' }],        // Windows 路径
    ['✅ 完成', { cwd: 'C:\\code\\proj\\', sessionTitle: '改bug' }],
    ['✅ 完成', { cwd: '/a/proj', sessionTitle: 'New session' }],         // 英文占位（i18n 后的「新会话」）
    ['✅ 完成', { cwd: '/a/proj', sessionTitle: '新会话' }],
    ['✅ 完成', { cwd: '/a/proj', sessionTitle: '(无标题)' }],
    ['✅ 完成', { cwd: '/a/proj' }],
    ['✅ 完成', { sessionTitle: '改bug' }],
    ['✅ 完成', {}],
    ['✅ 完成', undefined],
    ['', { cwd: '/a/proj', sessionTitle: '改bug' }],
    ['✅ 完成', { cwd: '', sessionTitle: '' }],
    ['✅ 完成', { cwd: null, sessionTitle: null }],
    ['✅ 完成', { cwd: '/a/proj', sessionTitle: 'x'.repeat(50) }],        // 超长截断
  ],
};

test('前后端所有同名 export 都已登记对照用例（新增孪生实现必须进闸）', () => {
  const fe = collect(join(ROOT, 'public/js/logic'));
  const be = collect(join(ROOT, 'src'));
  const twins = [...fe.keys()].filter(n => be.has(n)).sort();
  const registered = Object.keys(PAIRS).sort();

  const unregistered = twins.filter(n => !registered.includes(n));
  assert.deepEqual(unregistered, [],
    `这些函数前后端各有一份实现却没有对照用例：${unregistered.join(', ')}\n`
    + '  前后端不能互相 import（边界闸），所以「等价」只能靠断言维持。\n'
    + '  在本文件的 PAIRS 里加一行对照用例，或者把其中一份改名（如果它们本就不该等价）。');

  // 反向：登记了却已经不存在的对，是过期的闸，删掉它免得给人虚假安全感
  const stale = registered.filter(n => !twins.includes(n));
  assert.deepEqual(stale, [], `PAIRS 里登记的对已不存在于两侧：${stale.join(', ')}`);
});

// ★ 只 import「静态扫描定位到的那几个文件」，绝不遍历 import 整个 src/。
//
// 初版就是那么写的，代价当场兑现：`src/server/app.js` 是组装根，import 它 = **真的启动一个
// server** —— 加载 CF Access 证书、起 hooks 桥文件监听、绑 3000 端口。本机恰好被生产 server
// 占着端口才炸出来；换台干净机器就是测试里悄悄跑起一个真服务，还可能往真实 data/ 落盘
// （这正是 CCM_DATA_DIR 隔离那组断言存在的理由）。
//
// 静态扫描（读源码正则）拿路径 → 只 import 叶子模块，两步分开就没有这个风险。
async function loadPair(name, feIndex, beIndex) {
  const feFile = feIndex.get(name), beFile = beIndex.get(name);
  assert.ok(feFile, `前端找不到 ${name}`);
  assert.ok(beFile, `后端找不到 ${name}`);
  const [feMod, beMod] = await Promise.all([import(feFile), import(beFile)]);
  return { feFile, beFile, fe: feMod[name], be: beMod[name] };
}

test('每一对孪生实现在所有登记输入下输出一致', async () => {
  const feIndex = collect(join(ROOT, 'public/js/logic'));
  const beIndex = collect(join(ROOT, 'src'));

  for (const [name, cases] of Object.entries(PAIRS)) {
    const { feFile, beFile, fe, be } = await loadPair(name, feIndex, beIndex);
    for (const args of cases) {
      const f = fe(...args);
      const b = be(...args);
      assert.deepEqual(b, f,
        `${name}(${args.map(a => JSON.stringify(a)).join(', ')}) 前后端不一致\n`
        + `  前端 ${feFile.replace(ROOT, '.')} → ${JSON.stringify(f)}\n`
        + `  后端 ${beFile.replace(ROOT, '.')} → ${JSON.stringify(b)}`);
    }
  }
});

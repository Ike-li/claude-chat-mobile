// tests/invariants/read-state.test.mjs —— 未读位点跨设备单调合并与防整屏复亮
// 守护：READ-01（LWW 单调递增；手动标未读不用「删条目」表达已读，否则会被别的设备复活）
// 覆盖：多设备增量归并（LWW 单调递增）+ baselineTs 免疫污染 + 手动标已读记 seen 阻断旧 manual 复活 + 乱序上报不整屏复亮
//       + 已读盖过手动标记后清干净（消除本地删/服务端留的不对称）+ 两条写入路径的 seen 都单调不回退
//       + manualUnreadIds 与前端 isManualUnreadNow 逐条同义（标记必须能被 session:list 补回列表）
// 槽位：S1（纯函数 + 一次性目录状态机）
// 不测什么 + 为什么：不测浏览器 localStorage 与真实 DOM 渲染（属于 S3 UI/E2E 槽）

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createReadStateStore } from '../../app/src/sessions/read-state.js';
import { isSessionUnread, isManualUnreadNow } from '../../app/public/js/logic/unread.js';

const T0 = 1_700_000_000_000;
const MIN = 60_000;

let TMP_DIR;
let fileSeq = 0;

function createStore(opts = {}) {
  return createReadStateStore({
    file: join(TMP_DIR, `read-state-${++fileSeq}.json`),
    ...opts,
  });
}

test.before(() => {
  TMP_DIR = mkdtempSync(join(tmpdir(), 'ccm-inv-read-state-'));
});
test.after(() => {
  if (TMP_DIR) rmSync(TMP_DIR, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

test.describe('READ-01: 服务端共享已读位点单调合并与基线保护', () => {

  test('首次读取即建档，baselineTs 钉在此时此刻', () => {
    const s = createStore({ now: () => T0 });
    assert.deepEqual(s.getState(), { baselineTs: T0, seen: {}, manual: {} });
  });

  test('baselineTs 建档后永不改变：客户端上报的任何基线一律忽略，防整屏复亮放大器', () => {
    const s = createStore({ now: () => T0 });
    s.getState();

    // 较老设备的旧基线尝试回传
    s.applyClientState({ baselineTs: T0 - 100 * MIN, seen: {}, manual: {} });
    assert.equal(s.getState().baselineTs, T0, '客户端更老的基线不得回传染');

    // 更新设备的基线尝试覆盖
    s.applyClientState({ baselineTs: T0 + 100 * MIN, seen: {}, manual: {} });
    assert.equal(s.getState().baselineTs, T0, '更新的基线也不得覆盖');
  });

  test('seen 位点按会话取最新时间戳，单调不回退（乱序到达旧 ack 不拨旧位点）', () => {
    const s = createStore({ now: () => T0 });
    s.markRead('session-1', T0 + 5 * MIN);
    s.markRead('session-1', T0 + 1 * MIN); // 较旧的晚到达
    assert.equal(s.getState().seen['session-1'], T0 + 5 * MIN, '必须保留较晚时间戳');
  });

  test('applyClientState 增量归并：逐会话取 max 时间戳', () => {
    const s = createStore({ now: () => T0 });
    s.markRead('s-a', T0 + 10 * MIN);
    s.markRead('s-b', T0 + 20 * MIN);

    const merged = s.applyClientState({
      seen: {
        's-a': T0 + 5 * MIN,  // 客户端较旧 -> 被服务端保留
        's-b': T0 + 25 * MIN, // 客户端较新 -> 更新为较新
        's-c': T0 + 15 * MIN, // 客户端新增 -> 补入
      },
    });

    assert.equal(merged.seen['s-a'], T0 + 10 * MIN);
    assert.equal(merged.seen['s-b'], T0 + 25 * MIN);
    assert.equal(merged.seen['s-c'], T0 + 15 * MIN);
  });
});

test.describe('READ-01: 手动标已读写 seen 阻断旧 manual 复活（防整屏复亮核心）', () => {
  test('setManual(false) 必须同时记 seen，阻止另一台离线设备把旧 manual 同步回来后复活', () => {
    const s = createStore({ now: () => T0 });

    // 设备 A：在 T0+10MIN 手动标未读
    s.setManual('sess-target', true, T0 + 10 * MIN);
    assert.equal(s.getState().manual['sess-target'], T0 + 10 * MIN);

    // 设备 A：在 T0+20MIN 打开会话看完了，标为已读（setManual off）
    s.setManual('sess-target', false, T0 + 20 * MIN);
    assert.equal(s.getState().manual['sess-target'], undefined, '服务端已移除 manual 标记');
    assert.equal(s.getState().seen['sess-target'], T0 + 20 * MIN, '★ 必须记录 seen=T0+20MIN');

    // 模拟离线设备 B 此时上线，带着它本地缓存的旧 manual（T0+10MIN 的手动未读标记）进行增量归并
    const clientBState = {
      manual: { 'sess-target': T0 + 10 * MIN },
      seen: {},
    };
    const authoritative = s.applyClientState(clientBState);

    // 验证：即使 manual 里合并进了设备 B 上报的旧条目，seen['sess-target'] 仍然大于 manual['sess-target']
    assert.equal(authoritative.seen['sess-target'], T0 + 20 * MIN);
    assert.equal(authoritative.manual['sess-target'], T0 + 10 * MIN);

    // 配合前端 isManualUnreadNow 判定：因为 seen >= manual，该会话绝不点亮！
    const isUnread = isManualUnreadNow(authoritative.manual, authoritative.seen, 'sess-target');
    assert.equal(isUnread, false, '旧 manual 条目不得导致会话整屏复亮！');
  });

  // 前端 markEntered（再次打开会话）只发 seenAt、不发 manual 字段，服务端因此走 markRead 分支。
  // 而它在【本地】是直接把 manual 条目删掉的 —— 服务端若留着，本地删、服务端留，下一趟 hydrate
  // 的 LWW 合并又把它搬回本地，形成永不收敛的不对称。判定上通常被 seen 盖住看不出来，但两台设备
  // 时钟有偏移时那份复活的旧标记就会翻成假未读。清理的判据必须是时间戳比较，不是无条件删。
  test('markRead 盖过手动标记后必须清掉该 manual 条目：不留下会被 hydrate 搬回来的不对称', () => {
    const s = createStore({ now: () => T0 });
    s.setManual('session-1', true, T0 + 1 * MIN);   // 设备 A 长按「标为未读」
    s.markRead('session-1', T0 + 2 * MIN);          // 设备 B 打开该会话（markEntered 只发 seenAt）

    const st = s.getState();
    assert.equal(st.seen['session-1'], T0 + 2 * MIN);
    assert.equal('session-1' in st.manual, false, '被这笔已读盖过的手动标记必须清掉，不能留成垃圾键');
    assert.equal(isManualUnreadNow(st.manual, st.seen, 'session-1'), false);
  });

  test('markRead 不得清掉晚于它的手动标记：乱序到达的旧已读不能吃掉「稍后再看」', () => {
    const s = createStore({ now: () => T0 });
    s.setManual('session-1', true, T0 + 5 * MIN);   // 标记在后
    s.markRead('session-1', T0 + 2 * MIN);          // 较早的一笔已读乱序到达

    const st = s.getState();
    assert.equal('session-1' in st.manual, true, '晚于这笔已读的手动标记必须原样保留');
    assert.equal(isManualUnreadNow(st.manual, st.seen, 'session-1'), true, '用户显式标的未读不得被旧已读清掉');
  });

  test('setManual(false) 的 seen 也单调不回退：乱序旧「标为已读」不得把位点拨回过去', () => {
    const s = createStore({ now: () => T0 });
    s.markRead('session-1', T0 + 5 * MIN);
    s.setManual('session-1', false, T0 + 1 * MIN);  // 另一台设备很久以前那笔「标为已读」晚到

    assert.equal(s.getState().seen['session-1'], T0 + 5 * MIN, '位点被拨回过去会让早已读过的内容重新变未读');
  });

  test('多设备乱序交织上报：最终状态收敛且判定幂等', () => {
    const s = createStore({ now: () => T0 });

    // 设备 1 和设备 2 交叉上报位点
    s.applyClientState({
      seen: { s1: T0 + 5 * MIN, s2: T0 + 2 * MIN },
      manual: { s3: T0 + 3 * MIN },
    });

    s.applyClientState({
      seen: { s1: T0 + 2 * MIN, s2: T0 + 8 * MIN },
      manual: { s3: T0 + 7 * MIN },
    });

    const state = s.getState();
    assert.equal(state.seen.s1, T0 + 5 * MIN);
    assert.equal(state.seen.s2, T0 + 8 * MIN);
    assert.equal(state.manual.s3, T0 + 7 * MIN);

    // 校验未读判定纯函数在多设备会话下的正确性
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 4 * MIN, seenAt: state.seen.s1 }), false);
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 6 * MIN, seenAt: state.seen.s1 }), true);
    assert.equal(isSessionUnread({ lastUsedAt: T0 + 10 * MIN, seenAt: state.seen.s2 }), true);
    assert.equal(isSessionUnread({ isViewing: true, lastUsedAt: T0 + 100 * MIN }), false, '当前正在查看的会话恒不亮');
  });
});

test.describe('READ-01: 容量限制与持久化健壮性', () => {
  test('超出 seenCap / manualCap 时按时间戳淘汰最旧记录', () => {
    const s = createStore({ now: () => T0, seenCap: 2, manualCap: 2 });
    s.markRead('s-old', T0 + 1 * MIN);
    s.markRead('s-mid', T0 + 2 * MIN);
    s.markRead('s-new', T0 + 3 * MIN);

    assert.deepEqual(Object.keys(s.getState().seen).sort(), ['s-mid', 's-new']);

    s.setManual('m-old', true, T0 + 1 * MIN);
    s.setManual('m-mid', true, T0 + 2 * MIN);
    s.setManual('m-new', true, T0 + 3 * MIN);

    assert.deepEqual(Object.keys(s.getState().manual).sort(), ['m-mid', 'm-new']);
  });

  test('脏输入防御：非字符串 sessionId / NaN 时间戳直接忽略，不抛异常', () => {
    const s = createStore({ now: () => T0 });
    s.markRead(null, T0);
    s.markRead(undefined, T0);
    s.markRead('', T0);
    s.markRead('valid', NaN);
    s.markRead('valid', 'invalid-ts');

    assert.deepEqual(s.getState().seen, {});
    assert.doesNotThrow(() => s.applyClientState({ seen: null, manual: 'bad' }));
  });

  test('文件损坏自动恢复：读到损坏 JSON 退化为空状态重新建档', () => {
    const file = join(TMP_DIR, 'corrupted-read-state.json');
    writeFileSync(file, '{ corrupt broken json !!!');

    const s = createReadStateStore({ file, now: () => T0 });
    assert.deepEqual(s.getState(), { baselineTs: T0, seen: {}, manual: {} });
  });

  test('落盘权限 0600 并保证原子写', () => {
    const file = join(TMP_DIR, 'secure-read-state.json');
    const s = createReadStateStore({ file, now: () => T0 });
    s.markRead('s-sec', T0 + MIN);
    s.flushSaveSync();

    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    const content = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(content.seen['s-sec'], T0 + MIN);
  });
});

// ── 从磁盘加载既有位点 ──────────────────────────────────────────────────────
// 本节补的是变异对比里「已退役的旧测试独占咬住、本文件原先漏掉」的两个点（129:26 / 130:30）。
// 原先的用例都从空 store 起步，从没走过「文件里已有合法数据」这条加载路径——
// 于是 `typeof raw !== 'object'` 与 `typeof raw.baselineTs !== 'number'` 两个守卫
// 反转后也没人变红：跨设备共享的位点在重启后能不能读回来，从来没被证明过。
test.describe('落盘位点在重启后读得回来', () => {
  // 判据用「基线来自文件还是来自 now()」区分：加载成功则保留盘上的旧基线，
  // 加载失败则退化成未建档、由首次 getState 现场建档（read-state.js:56）。
  const T_NOW = 1_800_000_000_000;   // 与盘上时间戳明显不同，便于区分来源
  const loadWith = (name, content) => {
    const file = join(TMP_DIR, `${name}.json`);
    writeFileSync(file, content);
    return createReadStateStore({ file, now: () => T_NOW }).getState();
  };

  test('合法文件被完整加载：baselineTs 与 seen/manual 都还原', () => {
    const s = loadWith('existing-read-state', JSON.stringify({
      baselineTs: T0,
      seen: { 's-a': T0 + MIN },
      manual: { 's-b': T0 + 2 * MIN },
    }));
    assert.equal(s.baselineTs, T0, '基线必须来自文件，不是重新建档为 now()');
    assert.notEqual(s.baselineTs, T_NOW);
    assert.equal(s.seen['s-a'], T0 + MIN, '跨设备已读位点要能在重启后读回来');
    assert.equal(s.manual['s-b'], T0 + 2 * MIN);
  });

  test('顶层是数组或标量 → 退化成未建档，现场重建基线', () => {
    // `typeof raw !== 'object'` 反转后，合法对象反而会被判为坏档；
    // 而 Array.isArray 那道单独的守卫负责挡住「数组也是 object」。
    for (const bad of ['[]', '"str"', '42', 'null']) {
      const s = loadWith(`bad-top-${bad.replace(/\W/g, '')}`, bad);
      assert.equal(s.baselineTs, T_NOW, `顶层 ${bad} 应退化成未建档并现场建档`);
      assert.deepEqual(s.seen, {});
    }
  });

  test('baselineTs 不是有限数 → 退化成未建档，绝不把 NaN 当基线', () => {
    // 基线是「这个时间点之前的都算已读」。NaN 基线会让所有比较恒假，
    // 表现为整屏未读永远清不掉。
    // 注：JSON 不支持 NaN / Infinity 字面量，写进文件会在 JSON.parse 阶段就抛错走 catch，
    // 所以 `!Number.isFinite(baselineTs)` 那道守卫从【文件加载路径】不可达——它防的是
    // 别的调用方直接传入的内存对象。这里只覆盖 typeof 那道。
    for (const bad of ['"1700000000000"', 'null', 'true', 'NaN', 'Infinity']) {
      const s = loadWith(`bad-base-${bad.replace(/\W/g, '')}`, `{"baselineTs":${bad},"seen":{},"manual":{}}`);
      assert.equal(s.baselineTs, T_NOW, `baselineTs=${bad} 应退化成未建档`);
    }
  });

  test('文件内容不是合法 JSON → 退化成未建档，不抛错阻塞启动', () => {
    assert.equal(loadWith('corrupt-json', '{ not json').baselineTs, T_NOW);
  });
});


// READ-01 的另一半：标记活下来了，但用户还得看得见它。
// session:list 按 limit 截断（默认 6 条），标记的会话滑出窗口就从抽屉里消失——标记还在
// read-state.json 里，UI 上再也找不回来，而长按确认框刚承诺过「会一直显示未读，直到你再次打开」。
// manualUnreadIds 是服务端把这些会话补回列表的入口，它的判据必须与前端逐条同义：
// 服务端多报一条 → 列表里凭空多一行不该在的；少报一条 → 那条标记就是被静默吞掉了。
test.describe('READ-01: manualUnreadIds —— 标记必须能被补回列表，判据与前端同义', () => {

  test('manual > seen 算未读；缺 seen 算未读；相等算已读', () => {
    const s = createStore({ now: () => T0 });
    // 三种状态直接注入（公开写入路径会互相清理，构造不出 manual === seen 的并存态）
    s.applyClientState({
      seen: { 'read-after-mark': T0 + MIN, 'equal': T0, 'marked-later': T0 },
      manual: { 'read-after-mark': T0, 'equal': T0, 'marked-later': T0 + MIN, 'never-seen': T0 },
    });
    assert.deepEqual(s.manualUnreadIds().sort(), ['marked-later', 'never-seen'],
      'read-after-mark 已被更晚的 seen 盖过、equal 相等算已读，两者都不该补回列表');
  });

  test('与前端 isManualUnreadNow 对同一份状态给出相同集合（前后端各一份实现，不得漂移）', () => {
    const s = createStore({ now: () => T0 });
    // 覆盖全部相对位置：manual 早于/等于/晚于 seen、无 seen、无 manual
    const seen = { a: T0 + MIN, b: T0, c: T0, e: T0 };
    const manual = { a: T0, b: T0, c: T0 + MIN, d: T0 };
    s.applyClientState({ seen, manual });
    const state = s.getState();
    const fromFrontend = ['a', 'b', 'c', 'd', 'e']
      .filter(id => isManualUnreadNow(state.manual, state.seen, id));
    assert.deepEqual(s.manualUnreadIds().sort(), fromFrontend.sort());
    assert.deepEqual(fromFrontend.sort(), ['c', 'd'], '两侧一起算错的话上一句会互相掩护，这里钉死期望值');
  });

  test('标为已读后立刻从补回名单里消失（不再占着列表顶部那一行）', () => {
    const s = createStore({ now: () => T0 });
    s.setManual('later', true, T0);
    assert.deepEqual(s.manualUnreadIds(), ['later']);
    s.setManual('later', false, T0 + MIN);
    assert.deepEqual(s.manualUnreadIds(), []);
  });

  test('打开会话（markRead）同样解除补回，与「再次打开即清除」的承诺一致', () => {
    const s = createStore({ now: () => T0 });
    s.setManual('later', true, T0);
    s.markRead('later', T0 + MIN);
    assert.deepEqual(s.manualUnreadIds(), []);
  });
});

// tests/unit/logic-general-nav.test.mjs —— 通用设置 L1 目录行的摘要判定层单测。
// 跑法：npm run test:unit。零 DOM/零 socket，只吃 {push, alerts, devices, service, lang, now}。
//
// 这一层解决的是旧面板的结构性缺陷：入口副标题「本机提醒 · 推送 · 语言 · 诊断」是**死的功能枚举**，
// 内容一变就漂（上线时四个词已有两个和面板里的组标题对不上）。改成活数据后，摘要由本函数从当前
// 状态算出，不可能漂——但也因此，"算错"会直接变成"面板上写着假话"，故这里逐行钉住。
//
// 覆盖：六行的 id 与顺序、通知行随订阅态变文案、设备行的计数与待批红点、主机行的运行时长/版本/两个桥、
//       三条静态行不受状态影响，以及★每一项都指得到页面里一个真实元素。
// 不覆盖：DOM 渲染与页面切换（归 tests/e2e/specs/settings-scope-split.spec.ts）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarizeGeneralNav, GENERAL_NAV_IDS, formatMcpServers } from '../../app/public/js/logic.js';
import { setLang } from '../../app/public/js/i18n.js';

test.beforeEach(() => setLang('zh'));

const INDEX_HTML = readFileSync(
  fileURLToPath(new URL('../../app/public/index.html', import.meta.url)), 'utf8');

// 六行全部喂满：条件项（两个桥、待批台数）缺状态时会从摘要里消失，而消失的项测不到锚点。
const FULL_STATE = Object.freeze({
  push: { subscribed: true, preview: false },
  alerts: { sound: true, vibrate: true },
  devices: { trusted: 3, pending: 1 },
  service: {
    startedAt: 1_700_000_000_000 - 3600_000,
    versions: { server: '1.10.1' },
    hooksBridge: { state: 'installed' },
    statuslineBridge: { state: 'not-installed' },
  },
  lang: 'zh',
  now: 1_700_000_000_000,
});

// ---- 骨架：六行、顺序固定 ----

test('返回六行，id 与顺序固定（L1 目录的骨架契约）', () => {
  const rows = summarizeGeneralNav();
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(r => r.id), [
    'notify', 'devices', 'host', 'behavior', 'diag', 'help',
  ]);
  // 导出的常量与实际返回保持一致——接线层按 id 找 L2 页，两处分叉会让某一页永远打不开
  assert.deepEqual(GENERAL_NAV_IDS, rows.map(r => r.id));
});

test('每行都有非空 icon 与 title（L1 是目录，缺一项就是一行空白）', () => {
  for (const row of summarizeGeneralNav()) {
    assert.ok(row.icon, `${row.id} 缺 icon`);
    assert.ok(row.title, `${row.id} 缺 title`);
  }
});

// ---- ★ 摘要词 ↔ 页面内容的绑定 ----
//
// 这两条守的是上一版真实发生过的失效：副标题与 L2 页内容分居两处，改内容的人没有任何理由回头改
// 文案，于是五天里漂了两条——behavior 行写着页面里根本不存在的「会花钱的功能」，diag 行列了四条
// 日志而页面里只有一条（另两条在顶栏与服务状态面板）。绑上元素 id 之后，写一个页面里没有的词
// 会在这里直接红。
//
// 这是「架构守卫」类的源码文本断言（docs/testing.md §5）：没有行为等价物——E2E 只能验当前那几个
// 词渲染出来了，验不了「这个词在页面里有没有对应的东西」。故留在这一层。

test('★ 摘要的每一项都指向 index.html 里真实存在的元素（防枚举词漂到页面之外）', () => {
  for (const row of summarizeGeneralNav(FULL_STATE)) {
    assert.ok(row.items.length, `${row.id} 摘要为空`);
    for (const item of row.items) {
      assert.ok(
        INDEX_HTML.includes(`id="${item.el}"`),
        `${row.id} 的「${item.text}」指向 #${item.el}，但 index.html 里没有这个元素`,
      );
    }
  }
});

test('★ summary 就是 items 的拼接（两处各写一份＝面板显示一套、锚点指着另一套）', () => {
  for (const row of summarizeGeneralNav(FULL_STATE)) {
    assert.equal(
      row.summary, row.items.map(i => i.text).join(' · '),
      `${row.id} 的 summary 与 items 不一致`,
    );
  }
});

// ---- 通知行：随订阅态变 ----

test('通知行：未订阅时摘要点名「推送未开启」', () => {
  const [notify] = summarizeGeneralNav({ push: { subscribed: false } });
  assert.equal(notify.id, 'notify');
  assert.match(notify.summary, /推送未开启/);
});

test('通知行：已订阅时不再说未开启，改报提示音/震动的实际开关', () => {
  const [notify] = summarizeGeneralNav({
    push: { subscribed: true },
    alerts: { sound: true, vibrate: false },
  });
  assert.doesNotMatch(notify.summary, /未开启/);
  assert.match(notify.summary, /提示音/);
  // ★ 关掉的那个必须能从文案里读出来是关的，否则面板在说假话
  assert.match(notify.summary, /震动关/);
});

test('通知行：两个本地提示都关掉时，文案不得读成「都开着」', () => {
  const [notify] = summarizeGeneralNav({
    push: { subscribed: true },
    alerts: { sound: false, vibrate: false },
  });
  assert.match(notify.summary, /提示音关/);
  assert.match(notify.summary, /震动关/);
});

// 锁屏预览决定推送 body 里带不带问题/工具原文，是这一页上隐私影响最大的开关——
// 入口此前只报推送/提示音/震动三项，它一个字没提。
test('通知行：锁屏预览也报开关态', () => {
  const on = summarizeGeneralNav({ push: { subscribed: true, preview: true } })[0];
  const off = summarizeGeneralNav({ push: { subscribed: true, preview: false } })[0];
  assert.match(on.summary, /锁屏预览开/);
  assert.match(off.summary, /锁屏预览关/);
});

// ---- 设备行：计数 + 待批红点 ----

test('设备行：报出已信任台数', () => {
  const row = summarizeGeneralNav({ devices: { trusted: 3, pending: 0 } })[1];
  assert.equal(row.id, 'devices');
  assert.match(row.summary, /3 台已信任/);
});

test('设备行：有待批时摘要点出台数且亮红点（L1 上唯一的待办轴）', () => {
  const row = summarizeGeneralNav({ devices: { trusted: 3, pending: 1 } })[1];
  assert.match(row.summary, /1 台待批/);
  assert.equal(row.dot, true);
});

test('设备行：零待批时不得亮红点，也不得写出「0 台待批」', () => {
  const row = summarizeGeneralNav({ devices: { trusted: 3, pending: 0 } })[1];
  assert.equal(row.dot, false);
  assert.doesNotMatch(row.summary, /待批/);
});

test('设备行：devices 整个缺席时按 0 台渲染，不得崩也不得亮红点', () => {
  const row = summarizeGeneralNav()[1];
  assert.match(row.summary, /0 台已信任/);
  assert.equal(row.dot, false);
});

// 扫码是全站唯一「把一台新手机接进来」的动作，此前入口只报已信任台数、一个字没提它
test('设备行：点名扫码接入这个动作，不只报台数', () => {
  const row = summarizeGeneralNav({ devices: { trusted: 3 } })[1];
  assert.match(row.summary, /扫码/);
});

// ---- 主机行：运行时长 + 版本 ----

test('主机行：按 startedAt 算运行时长', () => {
  const now = 1_700_000_000_000;
  const row = summarizeGeneralNav({
    service: { startedAt: now - 6 * 24 * 3600_000 - 4 * 3600_000 },
    now,
  })[2];
  assert.equal(row.id, 'host');
  assert.match(row.summary, /已运行 6 天 4 小时/);
});

test('主机行：带上 server 版本', () => {
  const now = 1_700_000_000_000;
  const row = summarizeGeneralNav({
    service: { startedAt: now - 3600_000, versions: { server: '1.7.0' } },
    now,
  })[2];
  assert.match(row.summary, /v1\.7\.0/);
});

// ★ versions 的缺省字面量就是 'unknown'（server/app.js:298），原样显示会变成 "v unknown"。
// 这一条守的是"缺省值不得被当成版本号"，不是"版本号要显示"。
test('主机行：versions.server 为缺省字面量 unknown 时不得显示成版本号', () => {
  const now = 1_700_000_000_000;
  const row = summarizeGeneralNav({
    service: { startedAt: now - 3600_000, versions: { server: 'unknown' } },
    now,
  })[2];
  assert.doesNotMatch(row.summary, /unknown/);
  assert.doesNotMatch(row.summary, /v\s*$/);
});

test('主机行：service 还没回来时给确定占位，不给空摘要（空摘要在 L1 上像渲染坏了）', () => {
  const row = summarizeGeneralNav()[2];
  assert.ok(row.summary.length > 0);
  assert.match(row.summary, /状态读取中/);
});

// 两个 CLI 桥是这一页上仅有的真开关，此前入口只报运行时长与版本，读起来像个纯只读状态行。
test('主机行：两个桥的开关态各自进摘要，关着的那个必须读得出是关的', () => {
  const row = summarizeGeneralNav({
    ...FULL_STATE,
    service: { ...FULL_STATE.service, statuslineBridge: { state: 'not-installed' } },
  })[2];
  assert.match(row.summary, /终端推送开/);
  assert.match(row.summary, /终端状态栏关/);
});

// ★ 失败方向：不知道 ≠ 关。旧 server 不带桥字段时页面里那两段整段缺席（formatHooksBridgeRow
//   返回 null），摘要跟着不提——否则 L1 会预告一个点进去根本不存在的开关。
test('主机行：旧 server 没有桥字段时，摘要里一个桥都不许出现', () => {
  const row = summarizeGeneralNav({
    ...FULL_STATE,
    service: { startedAt: FULL_STATE.service.startedAt, versions: { server: '1.10.1' } },
  })[2];
  assert.doesNotMatch(row.summary, /终端推送/);
  assert.doesNotMatch(row.summary, /终端状态栏/);
  assert.match(row.summary, /已运行/); // 其余活数据照常
});

// ★ 失败方向同上：drifted（配置被改过）与 unknown（读不出安装态）都不知道现在到底在不在工作，
//   读成「开」会让用户以为终端通知有人管着，读成「关」又会让他去开一个可能已经开着的东西。
test('主机行：桥处于 drifted / unknown 时，摘要不得读成开或关', () => {
  for (const state of ['drifted', 'unknown']) {
    const row = summarizeGeneralNav({
      ...FULL_STATE,
      service: { ...FULL_STATE.service, hooksBridge: { state } },
    })[2];
    assert.doesNotMatch(row.summary, /终端推送开/, `${state} 被读成了开`);
    assert.doesNotMatch(row.summary, /终端推送关/, `${state} 被读成了关`);
    assert.match(row.summary, /终端推送待查/);
  }
});

// off 由 env 直接决定，功能整体停用——这一档说「关」是准确的（同 formatHooksBridgeRow 的分档顺序）
test('主机行：桥被 env 停用时读成关', () => {
  const row = summarizeGeneralNav({
    ...FULL_STATE,
    service: { ...FULL_STATE.service, hooksBridge: { state: 'installed', off: true } },
  })[2];
  assert.match(row.summary, /终端推送关/);
});

// ---- 静态三行：不受状态影响 ----

test('behavior 行随语言偏好变，其余静态行不受任何状态影响', () => {
  const zh = summarizeGeneralNav({ lang: 'zh' })[3];
  const en = summarizeGeneralNav({ lang: 'en' })[3];
  assert.match(zh.summary, /中文/);
  assert.match(en.summary, /English/);

  // diag / help 两行在任何状态下都该一字不差——它们是纯目录项
  const busy = summarizeGeneralNav({
    push: { subscribed: true }, devices: { trusted: 9, pending: 4 },
    service: { startedAt: 1, versions: { server: '9.9.9' } }, now: 99_999_999,
  });
  const idle = summarizeGeneralNav();
  assert.equal(busy[4].summary, idle[4].summary);
  assert.equal(busy[5].summary, idle[5].summary);
});

// ---- MCP 服务器（「宿主机」页）----
//
// 数据早就随 init 事件到了浏览器（agent.js 的 emit('init', {mcpServers})，SDK 契约是
// `{name, status}[]`），只是从来没渲染过。这一层把它译成「几个、哪个坏了」。
//
// ★ 失败方向：status 的取值集合 SDK 未声明。不认识的值必须**当成有问题**，不能当成正常——
//   把一个连不上的服务器显示成绿的，比显示成未知更糟：用户会去别处找原因。

test('MCP：没有服务器时返回 null，整段不该出现（不给空计数占位）', () => {
  assert.equal(formatMcpServers([]), null);
  assert.equal(formatMcpServers(undefined), null);
  assert.equal(formatMcpServers(null), null);
});

test('MCP：全部连上时报总数，每项标记为正常', () => {
  const view = formatMcpServers([
    { name: 'filesystem', status: 'connected' },
    { name: 'github', status: 'connected' },
  ]);
  assert.equal(view.total, 2);
  assert.equal(view.failed, 0);
  assert.deepEqual(view.items.map(i => i.name), ['filesystem', 'github']);
  assert.ok(view.items.every(i => i.ok));
});

test('MCP：有连接失败的，failed 计数与该项的 ok 都要反映出来', () => {
  const view = formatMcpServers([
    { name: 'filesystem', status: 'connected' },
    { name: 'postgres', status: 'failed' },
  ]);
  assert.equal(view.total, 2);
  assert.equal(view.failed, 1);
  assert.equal(view.items.find(i => i.name === 'postgres').ok, false);
  // 原始 status 要留给用户看——「failed」和「needs-auth」是两种完全不同的处置
  assert.equal(view.items.find(i => i.name === 'postgres').status, 'failed');
});

// ★ 这条守的是失败方向：SDK 没有声明 status 的取值集合，未来新增一个值时，
//   默认必须落到「有问题」一侧，而不是被当成正常。
test('MCP：不认识的 status 一律不当作正常（未知值不得被渲染成绿的）', () => {
  const view = formatMcpServers([
    { name: 'a', status: 'needs-auth' },
    { name: 'b', status: 'some-future-state' },
    { name: 'c', status: '' },
  ]);
  assert.equal(view.failed, 3);
  assert.ok(view.items.every(i => i.ok === false));
});

test('MCP：条目缺 name 时跳过而不是渲染成空行', () => {
  const view = formatMcpServers([
    { name: 'ok', status: 'connected' },
    { status: 'connected' },
    null,
  ]);
  assert.equal(view.total, 1);
  assert.deepEqual(view.items.map(i => i.name), ['ok']);
});

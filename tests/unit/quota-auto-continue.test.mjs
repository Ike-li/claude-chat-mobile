// tests/unit/quota-auto-continue.test.mjs —— 额度墙自动继续的纯判定（布防 / 到期 / 尾部校验）
//
// 语义对齐 CLI 2.1.280 的 autoContinueAtUsageLimit（二进制实测，见 app/src/agent/quota-auto-continue.js 头注）：
// 只认 status=rejected 且带有限 resetsAt、未在用超额的墙；重置点远于 24h 不自动等；
// 到点加 30–90s 抖动；等待期间机器睡过重置点（两拍间隔 > 30min）就转 stale 不自动发。
// 与 CLI 的一处有意差异：连续空转计数只数「续跑那一轮一个字都没产出就又撞墙」，
// 干了活再撞墙不算空转——CLI 两种都算，长任务会在第三个窗口被截停。
//
// 夹具里的墙形态逐字取自真机 transcript（2026-09-11，CLI 2.1.2xx，d257416a 会话第 100 行）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_CONTINUE_HORIZON_MS,
  AUTO_CONTINUE_JITTER_MAX_MS,
  AUTO_CONTINUE_JITTER_MIN_MS,
  AUTO_CONTINUE_PROMPT,
  AUTO_CONTINUE_REARM_CAP,
  AUTO_CONTINUE_REARM_MIN_DELAYS_MS,
  AUTO_CONTINUE_SLEEP_GRACE_MS,
  decideDue,
  planQuotaWall,
  resetsAtToMs,
  wallStillTail,
} from '../../app/src/agent/quota-auto-continue.js';

const NOW = Date.UTC(2026, 8, 11, 19, 47, 50);
const RESET_S = Math.floor(NOW / 1000) + 12 * 60; // 12 分钟后重置（秒级，同真机口径）
const RESET_MS = RESET_S * 1000;

// 真机 quotaLimits（除 resetsAt 外逐字照抄）
const REAL_QUOTA = Object.freeze({
  status: 'rejected',
  resetsAt: RESET_S,
  unifiedRateLimitFallbackAvailable: false,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled',
  upgradePaths: ['upgrade_plan'],
  isUsingOverage: false,
});

const plan = (over = {}) => planQuotaWall({
  quota: REAL_QUOTA, fallback: null, now: NOW, autoEnabled: true,
  turnOrigin: 'human', turnHadOutput: true, prevFutile: 0, random: () => 0,
  ...over,
});

test.describe('resetsAtToMs：秒/毫秒两种口径归一', () => {
  test('秒级（CLI 实测口径）乘 1000，毫秒级原样', () => {
    assert.equal(resetsAtToMs(RESET_S), RESET_MS);
    assert.equal(resetsAtToMs(RESET_MS), RESET_MS);
  });

  test('缺失/非法一律 null——判错一个数量级会把重置时刻算成 1970 年', () => {
    for (const bad of [undefined, null, 0, -1, 'soon', NaN, Infinity, {}]) {
      assert.equal(resetsAtToMs(bad), null, `resetsAt=${String(bad)}`);
    }
  });
});

test.describe('planQuotaWall：什么样的墙能布防', () => {
  test('官方订阅的真机墙 → 布防，到点 = 重置时刻 + 抖动下限', () => {
    const p = plan();
    assert.equal(p.kind, 'arm');
    assert.equal(p.resetsAtMs, RESET_MS);
    assert.equal(p.rateLimitType, 'five_hour');
    assert.equal(p.fireAt, RESET_MS + AUTO_CONTINUE_JITTER_MIN_MS, 'random()=0 取抖动下限');
    assert.equal(p.futile, 0);
  });

  test('抖动落在 [30s, 90s] 内：random 取上沿时不越界', () => {
    const p = plan({ random: () => 0.999999 });
    assert.ok(p.fireAt >= RESET_MS + AUTO_CONTINUE_JITTER_MIN_MS);
    assert.ok(p.fireAt <= RESET_MS + AUTO_CONTINUE_JITTER_MAX_MS, '抖动上沿越界 = 比 CLI 晚得多才续跑');
  });

  test('网关只回 429、没给重置时刻（无 quotaLimits 也无 rate_limit_event）→ 不布防，原因 no_reset', () => {
    const p = plan({ quota: null });
    assert.equal(p.kind, 'ineligible');
    assert.equal(p.reason, 'no_reset', '不猜重置时刻：对模型通路零假设（hard-rules §1）');
  });

  test('assistant 墙没带 quotaLimits 时回落同一轮收到的 rejected rate_limit_event（老 CLI 形态）', () => {
    const p = plan({ quota: undefined, fallback: { status: 'rejected', resetsAt: RESET_S, rateLimitType: 'seven_day' } });
    assert.equal(p.kind, 'arm');
    assert.equal(p.rateLimitType, 'seven_day');
  });

  test('quotaLimits 在但不是 rejected（allowed/allowed_warning/垃圾值）→ 视同没给', () => {
    for (const quota of [{ ...REAL_QUOTA, status: 'allowed' }, { ...REAL_QUOTA, status: 'allowed_warning' }, 'rejected', [], {}]) {
      assert.equal(plan({ quota }).kind, 'ineligible', `quota=${JSON.stringify(quota)}`);
    }
  });

  test('resetsAt 缺失或非法 → no_reset', () => {
    for (const resetsAt of [undefined, null, 0, 'soon']) {
      const p = plan({ quota: { ...REAL_QUOTA, resetsAt } });
      assert.equal(p.kind, 'ineligible');
      assert.equal(p.reason, 'no_reset');
    }
  });

  test('正在用超额额度（isUsingOverage / overageInUse）→ 不自动续，同 CLI 的 fj()', () => {
    for (const extra of [{ isUsingOverage: true }, { overageInUse: true }]) {
      const p = plan({ quota: { ...REAL_QUOTA, ...extra } });
      assert.equal(p.kind, 'ineligible');
      assert.equal(p.reason, 'overage');
    }
  });

  test('重置点在 24h 以外 → 只提供「到点继续」选项，不自动布防（CLI 的 horizon）', () => {
    const far = Math.floor((NOW + AUTO_CONTINUE_HORIZON_MS + 60_000) / 1000);
    const p = plan({ quota: { ...REAL_QUOTA, rateLimitType: 'seven_day', resetsAt: far } });
    assert.equal(p.kind, 'offer');
    assert.equal(p.reason, 'horizon');
    assert.equal(p.fireAt, null, 'offer 不带到点时刻：用户点了才布防');
  });

  test('恰在 24h 边界内仍自动布防', () => {
    const edge = Math.floor((NOW + AUTO_CONTINUE_HORIZON_MS) / 1000);
    assert.equal(plan({ quota: { ...REAL_QUOTA, resetsAt: edge } }).kind, 'arm');
  });

  test('开关关着（CCM 开关或 CLI 的 autoContinueAtUsageLimit:false）→ offer，原因 disabled', () => {
    const p = plan({ autoEnabled: false });
    assert.equal(p.kind, 'offer');
    assert.equal(p.reason, 'disabled');
  });

  test('重置点已过（时钟偏差 / 迟到的墙）→ 仍至少等抖动下限，不当场连发', () => {
    const p = plan({ quota: { ...REAL_QUOTA, resetsAt: Math.floor(NOW / 1000) - 600 } });
    assert.equal(p.kind, 'arm');
    assert.ok(p.fireAt >= NOW + AUTO_CONTINUE_JITTER_MIN_MS);
  });
});

test.describe('planQuotaWall：续跑后又撞墙（重布防与熔断）', () => {
  test('续跑那一轮一个字没产出就撞墙 = 空转，计数 +1，且至少等 60s', () => {
    const past = Math.floor(NOW / 1000) - 5; // 重置已过但上游还在拒
    const p = plan({ turnOrigin: 'auto-continuation', turnHadOutput: false, prevFutile: 0, quota: { ...REAL_QUOTA, resetsAt: past } });
    assert.equal(p.kind, 'arm');
    assert.equal(p.futile, 1);
    assert.ok(p.fireAt >= NOW + AUTO_CONTINUE_REARM_MIN_DELAYS_MS[0]);
  });

  test('第二次空转至少等 300s', () => {
    const past = Math.floor(NOW / 1000) - 5;
    const p = plan({ turnOrigin: 'auto-continuation', turnHadOutput: false, prevFutile: 1, quota: { ...REAL_QUOTA, resetsAt: past } });
    assert.equal(p.futile, 2);
    assert.ok(p.fireAt >= NOW + AUTO_CONTINUE_REARM_MIN_DELAYS_MS[1]);
  });

  test(`空转超过 ${AUTO_CONTINUE_REARM_CAP} 次 → 熔断停止，不再布防`, () => {
    const p = plan({ turnOrigin: 'auto-continuation', turnHadOutput: false, prevFutile: AUTO_CONTINUE_REARM_CAP });
    assert.equal(p.kind, 'stop');
    assert.equal(p.reason, 'rearm_cap');
  });

  test('续跑那一轮干了活再撞墙（下一个窗口用完）→ 不算空转，计数清零照常布防', () => {
    const p = plan({ turnOrigin: 'auto-continuation', turnHadOutput: true, prevFutile: AUTO_CONTINUE_REARM_CAP });
    assert.equal(p.kind, 'arm', '长任务跨多个窗口是本功能的主用例，不能在第三个窗口被截停');
    assert.equal(p.futile, 0);
  });

  test('人发起的轮次撞墙 → 计数清零（人接手过就是新一段）', () => {
    const p = plan({ turnOrigin: 'human', turnHadOutput: false, prevFutile: AUTO_CONTINUE_REARM_CAP });
    assert.equal(p.kind, 'arm');
    assert.equal(p.futile, 0);
  });
});

test.describe('decideDue：到点、等待、睡过头', () => {
  const FIRE = NOW + 60_000;

  test('未到点 → wait', () => {
    assert.equal(decideDue({ fireAt: FIRE, now: FIRE - 1, lastTickAt: FIRE - 30_000 }), 'wait');
  });

  test('到点且两拍间隔正常 → fire', () => {
    assert.equal(decideDue({ fireAt: FIRE, now: FIRE + 5_000, lastTickAt: FIRE - 25_000 }), 'fire');
  });

  test('两拍间隔超过宽限且已过点 = 机器睡过了重置点 → stale，不自动发', () => {
    const now = FIRE + 3 * 3600_000;
    assert.equal(decideDue({ fireAt: FIRE, now, lastTickAt: now - AUTO_CONTINUE_SLEEP_GRACE_MS - 1 }), 'stale');
  });

  test('睡了很久但醒来时还没到点 → 继续等（不是 stale）', () => {
    assert.equal(decideDue({ fireAt: FIRE, now: FIRE - 1_000, lastTickAt: FIRE - 5 * 3600_000 }), 'wait');
  });

  test('没有上一拍记录（刚布防）→ 不据此判睡眠', () => {
    assert.equal(decideDue({ fireAt: FIRE, now: FIRE + 1, lastTickAt: null }), 'fire');
  });
});

test.describe('wallStillTail：到点前确认「墙之后没人动过」', () => {
  const wallEntry = (extra = {}) => ({
    type: 'assistant', uuid: 'wall-uuid', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429,
    quotaLimits: REAL_QUOTA, isSidechain: false,
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3pm (America/Chicago)" }] },
    ...extra,
  });
  const human = text => ({ type: 'user', uuid: `u-${text}`, isSidechain: false, message: { role: 'user', content: text } });
  // CLI resume 被打断回合时在内存里补的一对（2026-09-11 真机：同一毫秒写盘、零 token）
  const resumeMeta = { type: 'user', uuid: 'meta-1', isMeta: true, isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] } };
  const noResponse = { type: 'assistant', uuid: 'syn-1', isSidechain: false, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } };
  const tail = { wallUuid: 'wall-uuid', resetsAtMs: RESET_MS };

  test('墙就是最后一条 → true', () => {
    assert.equal(wallStillTail([human('做个任务'), wallEntry()], tail), true);
  });

  test('墙之后只有 system / last-prompt / queue-operation 等非对话条目 → 仍是尾', () => {
    const entries = [human('x'), wallEntry(), { type: 'system', subtype: 'turn_duration' }, { type: 'last-prompt' }, { type: 'queue-operation' }];
    assert.equal(wallStillTail(entries, tail), true);
  });

  test('CLI resume 补的 meta「Continue from where you left off.」+ <synthetic>「No response requested.」不算有人动过', () => {
    assert.equal(wallStillTail([human('x'), wallEntry(), resumeMeta, noResponse], tail), true);
  });

  test('墙之后有人发了消息（终端或别的设备）→ false：续跑会从旧叶子分叉', () => {
    assert.equal(wallStillTail([human('x'), wallEntry(), human('我接着来')], tail), false);
  });

  test('墙之后有真模型输出 → false', () => {
    const reply = { type: 'assistant', uuid: 'a2', isSidechain: false, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '继续干活' }] } };
    assert.equal(wallStillTail([wallEntry(), reply], tail), false);
  });

  test('子 agent 链（isSidechain）上的条目不影响主链判定', () => {
    const side = { type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'side' }] } };
    assert.equal(wallStillTail([wallEntry(), side], tail), true);
  });

  test('uuid 对不上但 resetsAt 相同 → 仍认（SDK 流与落盘 uuid 若不一致，功能不能静默失效）', () => {
    assert.equal(wallStillTail([wallEntry({ uuid: 'other' })], tail), true);
  });

  test('老 CLI 的墙条目没有 quotaLimits → 按 rate_limit 错误本身认', () => {
    assert.equal(wallStillTail([wallEntry({ uuid: 'other', quotaLimits: undefined })], tail), true);
  });

  test('尾部是另一次重置时刻不同的墙（有人重试过、撞了别的墙）且 uuid 不同 → false', () => {
    const other = wallEntry({ uuid: 'wall-2', quotaLimits: { ...REAL_QUOTA, resetsAt: RESET_S + 3600 } });
    assert.equal(wallStillTail([wallEntry(), human('再试一次'), other], tail), false);
  });

  test('读不到任何条目 → false（没有证据就不代发）', () => {
    assert.equal(wallStillTail([], tail), false);
  });
});

test('续跑提示词沿用 CLI 原文但去掉 claude.ai 字样（对模型通路零假设）', () => {
  assert.match(AUTO_CONTINUE_PROMPT, /Continue the task you were working on when the limit was reached; do not repeat work that is already complete\./);
  assert.doesNotMatch(AUTO_CONTINUE_PROMPT, /claude\.ai/, '网关用户看到「claude.ai 额度已重置」是在说错话');
});

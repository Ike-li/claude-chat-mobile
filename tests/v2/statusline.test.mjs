// tests/v2/statusline.test.mjs —— 状态栏字段的来源约束与越界值处理
// 守护：OPS-2（utilization 必须夹在 [0,100]，越界值不得进 UI）、
//       DISPLAY-01（statusline 字段只做允许的变换，CLI 与 Web 两条路径不混拼）
// 覆盖：额度越界丢弃 + 额度缺席时不产出空壳 + git porcelain 三分计数 + repo/项目名解析
//       + 刷新原因的强弱合并 + 陈旧阈值常量
// 槽位：S1（纯函数，零 IO；不 spawn git、不起 server）
//
// 不测什么 + 为什么：
//  ① buildWebStatusLine / buildCliStatusLine 的完整组装 —— 需要 agent 实例与在途 RPC 状态，
//     属 S2；本文件只钉它们共用的纯函数判据。
//  ② 模型列表条数、effort 档位映射 —— 契约真相源是 docs/display-contracts.md，
//     既有 tests/unit/display-contracts.test.mjs 是那份契约的执行闸，不在此重复。
//  ③ 状态栏在浏览器里的可见性/布局 —— 属 S3，不在 DOM 里重测一遍字段映射。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  usageBitsForStatusLine,
  projectNameFromCwd,
  parsePorcelain,
  parseRepo,
  strongerStatusRefreshReason,
  statusRefreshReasonForEnvelope,
  RATE_STALE_AFTER_MS,
  readCachedCtxWindow,
  shouldFetchContextUsage,
  lastUsageInputTokens,
  invalidateCtxOccupancy,
  webContextCost,
  getContextUsageSafe,
  CONTEXT_USAGE_INFLIGHT_MAX_MS,
  clearCtxWindowCache,
} from '../../app/src/ops/statusline.js';

const withRate = (five, seven) => ({
  rate_limits: { ...(five ? { five_hour: five } : {}), ...(seven ? { seven_day: seven } : {}) },
});

test.describe('OPS-2：utilization 越界值一律丢弃，不透传给 UI', () => {
  test('区间内（含 0 与 100 两个边界）正常透传', () => {
    for (const v of [0, 1, 50, 99.9, 100]) {
      const out = usageBitsForStatusLine(withRate({ utilization: v }));
      assert.equal(out.rate?.fiveHour?.usedPercent, v, `${v} 在 [0,100] 内应保留`);
    }
  });

  test('超出上界 / 低于下界 → 整条丢弃，而不是钳到边界值', () => {
    // 钳到边界会把「上游给了脏数据」伪装成「用满了 100%」，比缺席更误导。
    for (const v of [100.1, 101, 1e6, -0.1, -5]) {
      const out = usageBitsForStatusLine(withRate({ utilization: v }));
      assert.equal(out.rate, undefined, `${v} 越界必须丢弃整条 rate，不得钳取`);
    }
  });

  test('非有限数（NaN / Infinity / 字符串 / null）→ 丢弃', () => {
    for (const v of [NaN, Infinity, -Infinity, '50', null, undefined, {}]) {
      const out = usageBitsForStatusLine(withRate({ utilization: v }));
      assert.equal(out.rate, undefined, `${String(v)} 不是有限数，必须丢弃`);
    }
  });

  test('两档独立判定：5h 合法 / 7d 越界 → 只保留 5h', () => {
    const out = usageBitsForStatusLine(withRate({ utilization: 42 }, { utilization: 999 }));
    assert.equal(out.rate.fiveHour.usedPercent, 42);
    assert.equal(out.rate.sevenDay, undefined, '一档脏不该连累另一档');
  });

  test('两档都越界 → 不产出空的 rate 对象（前端按存在性渲染）', () => {
    const out = usageBitsForStatusLine(withRate({ utilization: -1 }, { utilization: 200 }));
    assert.equal(out.rate, undefined, '空壳 rate 会让前端渲染出一个没有数字的额度区块');
  });

  test('7d 档与 5h 档判据完全对称（同样的边界、同样的类型检查）', () => {
    // 两档是各写一遍的条件，容易只改一边。逐条对称验，避免 7d 悄悄放行越界值。
    for (const v of [0, 100]) {
      const out = usageBitsForStatusLine(withRate(null, { utilization: v }));
      assert.equal(out.rate?.sevenDay?.usedPercent, v, `7d 的 ${v} 是合法边界，必须保留`);
    }
    for (const v of [-0.1, 100.1, NaN, Infinity]) {
      const out = usageBitsForStatusLine(withRate(null, { utilization: v }));
      assert.equal(out.rate, undefined, `7d 的 ${String(v)} 越界/非有限，必须丢弃`);
    }
    for (const notObj of ['x', 42, null, true]) {
      const out = usageBitsForStatusLine({ rate_limits: { seven_day: notObj } });
      assert.equal(out.rate, undefined, `seven_day=${String(notObj)} 不是对象，必须丢弃`);
    }
  });

  test('five_hour 不是对象时同样丢弃', () => {
    for (const notObj of ['x', 42, null, true]) {
      const out = usageBitsForStatusLine({ rate_limits: { five_hour: notObj } });
      assert.equal(out.rate, undefined);
    }
  });

  test('rate_limits 缺失或不是对象 → 返回空，不抛错', () => {
    for (const bad of [undefined, null, 'x', 42]) {
      assert.deepEqual(usageBitsForStatusLine({ rate_limits: bad }), {},
        `rate_limits=${String(bad)} 时不得进入解析分支`);
    }
  });
});

test.describe('额度可用性与重置时间', () => {
  test('rate_limits_available === false → 完全不产出 rate（第三方鉴权场景）', () => {
    const out = usageBitsForStatusLine({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 30 } } });
    assert.equal(out.rate, undefined, '上游明说额度不可用时，有数也不显示');
  });

  test('rate_limits_available 缺省视为可用（只有显式 false 才关闭）', () => {
    const out = usageBitsForStatusLine(withRate({ utilization: 30 }));
    assert.equal(out.rate.fiveHour.usedPercent, 30);
  });

  test('resets_at 是非空字符串才带上；其它类型静默省略', () => {
    const ok = usageBitsForStatusLine(withRate({ utilization: 10, resets_at: '2026-09-05T00:00:00Z' }));
    assert.equal(ok.rate.fiveHour.resetsAt, '2026-09-05T00:00:00Z');
    for (const bad of ['', 1757030400, null, {}]) {
      const out = usageBitsForStatusLine(withRate({ utilization: 10, resets_at: bad }));
      assert.equal(out.rate.fiveHour.resetsAt, undefined, `resets_at=${String(bad)} 不该带上`);
      assert.equal(out.rate.fiveHour.usedPercent, 10, '重置时间不合法不影响百分比本身');
    }
  });

  test('7d 的 resets_at 判据与 5h 对称', () => {
    const ok = usageBitsForStatusLine(withRate(null, { utilization: 20, resets_at: '2026-09-12T00:00:00Z' }));
    assert.equal(ok.rate.sevenDay.resetsAt, '2026-09-12T00:00:00Z');
    for (const bad of ['', 1757030400, null, {}]) {
      const out = usageBitsForStatusLine(withRate(null, { utilization: 20, resets_at: bad }));
      assert.equal(out.rate.sevenDay.resetsAt, undefined, `7d resets_at=${String(bad)} 不该带上`);
      assert.equal(out.rate.sevenDay.usedPercent, 20);
    }
  });

  test('入参不是对象 → 返回空对象而不是抛错', () => {
    for (const bad of [null, undefined, 'x', 42]) {
      assert.deepEqual(usageBitsForStatusLine(bad), {});
    }
  });
});

test.describe('会话行数增减：只在真有变更时出现', () => {
  test('added 或 removed 任一 > 0 即产出', () => {
    assert.deepEqual(usageBitsForStatusLine({ session: { total_lines_added: 5, total_lines_removed: 0 } }).lines,
      { added: 5, removed: 0 });
    assert.deepEqual(usageBitsForStatusLine({ session: { total_lines_added: 0, total_lines_removed: 3 } }).lines,
      { added: 0, removed: 3 });
  });

  test('两者都是 0 → 不产出 lines（避免状态栏常驻一个 +0/-0）', () => {
    assert.equal(usageBitsForStatusLine({ session: { total_lines_added: 0, total_lines_removed: 0 } }).lines, undefined);
  });

  test('非有限数按 0 计入，不让 NaN 流到 UI', () => {
    const out = usageBitsForStatusLine({ session: { total_lines_added: 7, total_lines_removed: NaN } });
    assert.deepEqual(out.lines, { added: 7, removed: 0 });
  });

  test('session 缺失或不是对象 → 不产出 lines，不抛错', () => {
    for (const bad of [undefined, null, 'x', 42, true]) {
      assert.equal(usageBitsForStatusLine({ session: bad }).lines, undefined,
        `session=${String(bad)} 时不得进入解析分支`);
    }
  });
});

test.describe('git porcelain 三分计数：三类独立、不互斥', () => {
  test('MM 同时计入 staged 与 modified（既暂存又有新改动）', () => {
    // 三分对齐 CLI statusline 的 +暂存 !改动 ?未跟踪。若写成互斥，MM 这行会漏掉一半信息。
    assert.deepEqual(parsePorcelain('MM a.js'), { staged: 1, modified: 1, untracked: 0 });
  });

  test('X 位属 MADRC 记 staged，Y 位属 MDT 记 modified', () => {
    assert.deepEqual(parsePorcelain('M  a.js'), { staged: 1, modified: 0, untracked: 0 });
    assert.deepEqual(parsePorcelain('A  b.js'), { staged: 1, modified: 0, untracked: 0 });
    assert.deepEqual(parsePorcelain(' M c.js'), { staged: 0, modified: 1, untracked: 0 });
    assert.deepEqual(parsePorcelain(' D d.js'), { staged: 0, modified: 1, untracked: 0 });
  });

  test('?? 只记 untracked，不落进另外两类', () => {
    assert.deepEqual(parsePorcelain('?? new.js'), { staged: 0, modified: 0, untracked: 1 });
  });

  test('多行汇总；空行与空输入不计数也不抛错', () => {
    assert.deepEqual(parsePorcelain('M  a\n M b\n?? c\nMM d\n'), { staged: 2, modified: 2, untracked: 1 });
    assert.deepEqual(parsePorcelain(''), { staged: 0, modified: 0, untracked: 0 });
    assert.deepEqual(parsePorcelain(null), { staged: 0, modified: 0, untracked: 0 });
  });
});

test.describe('remote url → owner/repo', () => {
  test('https 与 scp 两种形式都取末两段', () => {
    assert.equal(parseRepo('https://github.com/owner/repo.git'), 'owner/repo');
    assert.equal(parseRepo('git@github.com:owner/repo.git'), 'owner/repo');
    assert.equal(parseRepo('https://github.com/owner/repo'), 'owner/repo');
    assert.equal(parseRepo('https://github.com/owner/repo/'), 'owner/repo');
  });

  test('恰好两段即可成立（边界：>= 2 不是 > 2）', () => {
    assert.equal(parseRepo('owner/repo'), 'owner/repo', '两段是合法下界，不能被要求至少三段');
  });

  test('段数不足或空值 → null（优雅缺席，不产出半个标识）', () => {
    for (const bad of ['', null, undefined, 'repo']) {
      assert.equal(parseRepo(bad), null);
    }
  });
});

test.describe('项目名：路径尾段，跟随平台', () => {
  test('win32 认反斜杠，posix 认正斜杠', () => {
    assert.equal(projectNameFromCwd('C:\\code\\proj', { platform: 'win32' }), 'proj');
    assert.equal(projectNameFromCwd('/home/u/proj', { platform: 'linux' }), 'proj');
  });

  test('取不出尾段时回落整串，不返回空', () => {
    assert.equal(projectNameFromCwd('/', { platform: 'linux' }), '/');
  });

  test('空值原样返回，不抛错', () => {
    assert.equal(projectNameFromCwd(''), '');
    assert.equal(projectNameFromCwd(null), null);
  });
});

test.describe('刷新原因：取信息量更高的那个', () => {
  test('优先级 tick < usage < event', () => {
    assert.equal(strongerStatusRefreshReason('tick', 'usage'), 'usage');
    assert.equal(strongerStatusRefreshReason('usage', 'tick'), 'usage');
    assert.equal(strongerStatusRefreshReason('tick', 'event'), 'event');
    assert.equal(strongerStatusRefreshReason('event', 'tick'), 'event');
    assert.equal(strongerStatusRefreshReason('usage', 'event'), 'event');
  });

  test('未知原因按最高档处理（宁可多刷一次，不静默降级）', () => {
    assert.equal(strongerStatusRefreshReason('tick', 'brand_new_reason'), 'brand_new_reason');
    assert.equal(strongerStatusRefreshReason('brand_new_reason', 'tick'), 'brand_new_reason');
  });

  test('同档取后者——用两个同档但不同名的值才验得出来', () => {
    // 'event' 与任意未知原因同为最高档。若合并写成「相等取前者」，后来的原因会被旧的盖住。
    assert.equal(strongerStatusRefreshReason('event', 'unknown_same_rank'), 'unknown_same_rank');
    assert.equal(strongerStatusRefreshReason('unknown_same_rank', 'event'), 'event');
    assert.equal(strongerStatusRefreshReason('tick', 'tick'), 'tick');
  });

  test('init / result / compact_boundary 触发 event，其余不触发刷新', () => {
    assert.equal(statusRefreshReasonForEnvelope('init', {}), 'event');
    assert.equal(statusRefreshReasonForEnvelope('result', {}), 'event');
    assert.equal(statusRefreshReasonForEnvelope('system', { kind: 'compact_boundary' }), 'event');
    assert.equal(statusRefreshReasonForEnvelope('system', { kind: 'other' }), null);
    assert.equal(statusRefreshReasonForEnvelope('system', undefined), null, 'payload 缺失不得抛错');
    assert.equal(statusRefreshReasonForEnvelope('tool_use', {}), null);
  });
});

test('额度陈旧阈值取 90s：贴着 60s 节流窗会在边界反复闪', () => {
  // fetchUsage 常规节流窗 60s，缓存年龄天然在 [0,60s] 游走。阈值必须留出余量，
  // 否则常规档就会亮「非实时」，把护栏变成常驻噪音。
  assert.equal(RATE_STALE_AFTER_MS, 90_000);
  assert.ok(RATE_STALE_AFTER_MS > 60_000, '必须严格大于节流窗，否则常规刷新就会误标非实时');
});

// ── context usage 子系统 ────────────────────────────────────────────────────
// 本节补的是变异对比里 v2 相对旧测试【整块缺失】的覆盖面（约 17 个变异点）：
// ctx 窗口缓存的读取与作废、是否重打 RPC 的节流判据、web 侧 token/成本口径、RPC 兜底。
// 这些函数决定状态栏上的 ctx% 准不准；算错的表现是「压缩后百分比跳回 94%」这类幽灵数字。
test.describe('readCachedCtxWindow：模型不匹配的缓存一律作废', () => {
  const cached = (over = {}) => ({ ctxWindowCache: { model: 'opus', maxTokens: 200000, ...over } });

  test('模型一致且窗口有效 → 返回窗口大小', () => {
    assert.equal(readCachedCtxWindow(cached(), 'opus'), 200000);
  });

  test('模型变了 → null（切模型后窗口可能完全不同，用旧值会算出错误百分比）', () => {
    assert.equal(readCachedCtxWindow(cached(), 'haiku'), null);
  });

  test('空模型名与 undefined 视为同一种「没有模型」，不误判为不匹配', () => {
    assert.equal(readCachedCtxWindow({ ctxWindowCache: { model: '', maxTokens: 100 } }, undefined), 100);
    assert.equal(readCachedCtxWindow({ ctxWindowCache: { model: '', maxTokens: 100 } }, ''), 100);
  });

  test('窗口非有限数或 ≤0 → null，绝不拿它当除数', () => {
    for (const bad of [0, -1, NaN, Infinity, undefined, '200000']) {
      assert.equal(readCachedCtxWindow(cached({ maxTokens: bad }), 'opus'), null, `maxTokens=${String(bad)} 不可用`);
    }
  });

  test('无 agent / 无缓存 → null，不抛错', () => {
    assert.equal(readCachedCtxWindow(null, 'opus'), null);
    assert.equal(readCachedCtxWindow({}, 'opus'), null);
  });
});

test.describe('shouldFetchContextUsage：什么时候值得再打一次 RPC', () => {
  // getContextUsage 不是读内存——CLI 要按类别 count_tokens，冷路径数秒。
  // 10s tick 是给 git 段的，占用缓存热时不得重打，否则每 10 秒烧一次昂贵调用。
  const base = { hasQ: true, disposed: false, model: 'opus', now: 1_000_000 };

  test('已 dispose 或没有 q → 一律不打', () => {
    assert.equal(shouldFetchContextUsage({ ...base, disposed: true }), false);
    assert.equal(shouldFetchContextUsage({ ...base, hasQ: false }), false);
    assert.equal(shouldFetchContextUsage({}), false, '空参数不得误判为「该打」');
  });

  test('在途未超时 → 不重复打；超过上限则允许重打（防 RPC 卡死后永不恢复）', () => {
    const inFlight = { model: 'opus', inFlight: true, inFlightAt: base.now - 1000 };
    assert.equal(shouldFetchContextUsage({ ...base, cache: inFlight }), false);

    const stuck = { model: 'opus', inFlight: true, inFlightAt: base.now - CONTEXT_USAGE_INFLIGHT_MAX_MS - 1 };
    assert.equal(shouldFetchContextUsage({ ...base, cache: stuck }), true, '超时的在途标记不得永久堵住重打');
  });

  test('占用被标脏（压缩后）→ 立刻重打，优先级高于「窗口齐全」', () => {
    const stale = { model: 'opus', maxTokens: 200000, totalTokens: 100, staleOccupancy: true };
    assert.equal(shouldFetchContextUsage({ ...base, cache: stale }), true,
      '压缩后占用作废，不重打会让 ctx% 停在压缩前的旧值');
  });

  test('模型变了 → 重打', () => {
    assert.equal(shouldFetchContextUsage({ ...base, cache: { model: 'haiku', maxTokens: 1, totalTokens: 1 } }), true);
  });

  test('窗口与占用都在 → 不打（这正是 10s tick 不该烧 RPC 的场景）', () => {
    const hot = { model: 'opus', maxTokens: 200000, totalTokens: 12345 };
    assert.equal(shouldFetchContextUsage({ ...base, cache: hot, reason: 'tick' }), false);
    assert.equal(shouldFetchContextUsage({ ...base, cache: hot, reason: 'event' }), false);
  });

  test('占用为 0 也算「有占用」（0 是合法读数，不是缺失）', () => {
    const zero = { model: 'opus', maxTokens: 200000, totalTokens: 0 };
    assert.equal(shouldFetchContextUsage({ ...base, cache: zero }), false);
  });

  test('只有窗口没有占用，但本轮有 usage 可垫 → 不打', () => {
    const winOnly = { model: 'opus', maxTokens: 200000 };
    assert.equal(shouldFetchContextUsage({ ...base, cache: winOnly, hasLastUsage: true }), false);
    assert.equal(shouldFetchContextUsage({ ...base, cache: winOnly, hasLastUsage: false, reason: 'event' }), true);
  });

  test('不传 hasLastUsage 时按「没有 usage 可垫」处理 → 该打就打', () => {
    // 默认值若写成 true，任何忘传该参数的调用方都会被判成「有值可垫」而跳过取数，
    // 状态栏就一直显示不出 ctx%——而且没有任何报错。
    const winOnly = { model: 'opus', maxTokens: 200000 };
    assert.equal(shouldFetchContextUsage({ ...base, cache: winOnly, reason: 'event' }), true);
  });

  test('tick / usage 触发且已试过一次 → 不再打；event 触发不受 attempted 限制', () => {
    const attempted = { model: 'opus', attempted: true };
    assert.equal(shouldFetchContextUsage({ ...base, cache: attempted, reason: 'tick' }), false);
    assert.equal(shouldFetchContextUsage({ ...base, cache: attempted, reason: 'usage' }), false);
    assert.equal(shouldFetchContextUsage({ ...base, cache: attempted, reason: 'event' }), true,
      'init/result/压缩边界是真事件，值得重新取权威占用');
  });
});

test.describe('invalidateCtxOccupancy：压缩后作废占用，但【保留窗口】', () => {
  test('占用清空、窗口留下——与 clearCtxWindowCache 的关键区别', () => {
    // 压缩改变的是「用了多少」，不是「窗口多大」。若连窗口一起丢，下一拍必须重打一次
    // 昂贵的 count_tokens 才能算出百分比；保留窗口则只补占用即可。
    const agent = {
      ctxWindowCache: { model: 'opus', maxTokens: 200000, totalTokens: 999, percentage: 94 },
      _ctxUsageGen: 3,
    };
    invalidateCtxOccupancy(agent);
    assert.equal(agent.ctxWindowCache.maxTokens, 200000, '窗口必须保留');
    assert.equal(agent.ctxWindowCache.model, 'opus');
    assert.equal(agent.ctxWindowCache.totalTokens, undefined, '占用必须作废');
    assert.equal(agent.ctxWindowCache.percentage, undefined,
      '百分比同样要作废——只清 totalTokens 会让 ctx% 停在压缩前的 94%');
    assert.equal(agent.ctxWindowCache.staleOccupancy, true);
    assert.equal(agent.ctxWindowCache.attempted, false, 'attempted 清零才允许紧接着再拉一次权威占用');
    assert.equal(agent.ctxWindowCache.inFlight, false, '在途标记必须清掉，否则下一拍会被「已有在途」挡住而永不重打');
    assert.equal(agent.ctxWindowCache.inFlightAt, 0);
    assert.equal(agent._ctxUsageGen, 4, '代数必须推进，否则在途的迟到结果会写回已失效的占用');
  });

  test('clearCtxWindowCache 才是整份丢弃（换会话用），两者不可混用', () => {
    const agent = { ctxWindowCache: { model: 'opus', maxTokens: 200000 }, _ctxUsageGen: 1 };
    clearCtxWindowCache(agent);
    assert.equal(agent.ctxWindowCache, null, '换会话时窗口也不能留——新会话可能是别的模型');
    assert.equal(agent._ctxUsageGen, 2);
  });

  test('无缓存 → 留下一个标脏的空壳，让下一拍必定重打', () => {
    const agent = {};
    invalidateCtxOccupancy(agent);
    assert.equal(agent.ctxWindowCache.staleOccupancy, true);
    assert.equal(agent.ctxWindowCache.attempted, false, 'attempted 清零才允许紧接着再拉一次');
    assert.equal(agent.ctxWindowCache.inFlight, false);
  });

  test('agent 为空 → 静默返回，不抛错', () => {
    assert.doesNotThrow(() => invalidateCtxOccupancy(null));
    assert.doesNotThrow(() => invalidateCtxOccupancy(undefined));
  });
});

test.describe('token 与成本口径', () => {
  test('lastUsageInputTokens 把三类输入 token 相加，缺字段按 0', () => {
    assert.equal(lastUsageInputTokens({ input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 2 }), 17);
    assert.equal(lastUsageInputTokens({ input_tokens: 10 }), 10, '缓存类字段缺失按 0，不产出 NaN');
    assert.equal(lastUsageInputTokens(null), 0);
    assert.equal(lastUsageInputTokens(undefined), 0);
  });

  test('webContextCost：无 usage 时不产出 context 字段', () => {
    assert.deepEqual(webContextCost({ agent: {} }), {});
    assert.deepEqual(webContextCost({}), {});
  });

  test('webContextCost：totalInputTokens 与 lastUsageInputTokens 同口径', () => {
    const u = { input_tokens: 100, output_tokens: 7, cache_creation_input_tokens: 20, cache_read_input_tokens: 3 };
    const r = webContextCost({ agent: { lastUsage: u } });
    assert.equal(r.context.totalInputTokens, 123, '口径是三类输入之和，不含 output');
    assert.equal(r.context.totalInputTokens, lastUsageInputTokens(u), '两处口径必须一致，否则 ctx% 与明细对不上');
    assert.equal(r.context.usage.output_tokens, 7);
  });

  test('cost 只在真有花费或时长时出现（避免状态栏常驻一个 $0.00）', () => {
    assert.equal(webContextCost({ agent: { lastUsage: { input_tokens: 1 } } }).cost, undefined);
    const withCost = webContextCost({ agent: { totalCostUsd: 0.5, historicalCostUsd: 1.25, totalDurationMs: 900 } });
    assert.equal(withCost.cost.usedUsd, 1.75, '历史成本与本会话成本相加');
    assert.equal(withCost.cost.durationMs, 900);
  });

  test('只有时长没有花费也算有成本信息', () => {
    assert.equal(webContextCost({ agent: { totalDurationMs: 5 } }).cost?.durationMs, 5);
  });
});

test.describe('getContextUsageSafe：RPC 层兜底，不判生命周期', () => {
  test('q 没有 getContextUsage → null', async () => {
    assert.equal(await getContextUsageSafe(null), null);
    assert.equal(await getContextUsageSafe({}), null);
  });

  test('正常返回原样透传', async () => {
    const payload = { maxTokens: 200000, percentage: 12 };
    assert.deepEqual(await getContextUsageSafe({ getContextUsage: async () => payload }), payload);
  });

  test('超时 → null（先发陈旧值，回来再补发，不阻塞状态栏）', async () => {
    const never = { getContextUsage: () => new Promise(() => {}) };
    assert.equal(await getContextUsageSafe(never, 20), null);
  });

  test('抛错 → null，不把异常冒泡到状态栏组装', async () => {
    const boom = { getContextUsage: async () => { throw new Error('rpc down'); } };
    assert.equal(await getContextUsageSafe(boom, 100), null);
  });
});

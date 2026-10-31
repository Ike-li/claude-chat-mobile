// tests/unit/logic-perf.test.mjs —— 启动 / 打开会话耗时埋点的纯计算（logic/perf.js）
// 这些数字是性能改造每一步的验收依据（机主在手机上「复制全部」导出），算错了会把对照表带偏：
// 长任务按窗口归属、资源按缓存命中分类、日志行把每一段的增量和服务端拆分都写出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLateStartupMark, formatOpenPerfLine, formatStartupPerfLine, summarizeLongTasks, summarizeResources } from '../../app/public/js/logic.js';

test.describe('summarizeLongTasks：只算与窗口重叠的长任务', () => {
  test('窗口外的不算；跨在窗口边界上的按整段时长算（点了没反应的那一下正是它）', () => {
    const tasks = [
      { start: 0, duration: 80 },      // 窗口之前结束
      { start: 950, duration: 120 },   // 跨进窗口起点
      { start: 1200, duration: 300 },  // 完全在窗口内
      { start: 1990, duration: 60 },   // 跨出窗口终点
      { start: 2500, duration: 400 },  // 窗口之后才开始
    ];
    assert.deepEqual(summarizeLongTasks(tasks, 1000, 2000), { count: 3, totalMs: 480, maxMs: 300 });
  });

  test('没有长任务（或浏览器不支持、拿到的不是数组）→ 全零，不抛', () => {
    assert.deepEqual(summarizeLongTasks([], 0, 1000), { count: 0, totalMs: 0, maxMs: 0 });
    assert.deepEqual(summarizeLongTasks(undefined, 0, 1000), { count: 0, totalMs: 0, maxMs: 0 });
  });
});

test.describe('summarizeResources：一方资源走了缓存、304 重验还是整份下载', () => {
  test('transferSize 0 = 缓存；只回了头（比 body 小，或明说 304）= 重验；其余 = 下载', () => {
    const entries = [
      { transferSize: 0, encodedBodySize: 40_000, responseEnd: 300 },                       // 内存/磁盘缓存
      { transferSize: 310, encodedBodySize: 12_000, responseEnd: 520 },                     // 304：只回了头
      { transferSize: 900, encodedBodySize: 400, responseStatus: 304, responseEnd: 610 },  // 小文件的 304 靠状态码认
      { transferSize: 47_300, encodedBodySize: 47_000, responseStatus: 200, responseEnd: 880 }, // 整份下载
    ];
    assert.deepEqual(summarizeResources(entries), { count: 4, cached: 1, revalidated: 2, fetched: 1, bytes: 48_510, lastEndMs: 880 });
  });

  test('Chrome 把预加载扫描器取的 head 资源的 304 报成 body 0、状态 200：只回了头，同样算重验', () => {
    // 2026-10-31 桌面复现实测：热启动时 head 里的脚本、样式表、字体都是这个形状（模块脚本照报 body 大小，归上一条）；
    // 冷启动整份下载时同一批资源 body 照报，不会被这条误收
    const entries = [{ transferSize: 300, encodedBodySize: 0, decodedBodySize: 0, responseStatus: 200, responseEnd: 400 }];
    assert.deepEqual(summarizeResources(entries), { count: 1, cached: 0, revalidated: 1, fetched: 0, bytes: 300, lastEndMs: 400 });
  });

  test('浏览器不给 transferSize 的条目只计总数，不猜成缓存命中', () => {
    assert.deepEqual(summarizeResources([{ responseEnd: 120.4 }]), { count: 1, cached: 0, revalidated: 0, fetched: 0, bytes: 0, lastEndMs: 120 });
  });
});

test.describe('formatOpenPerfLine：打开会话一行写清每一段花了多久', () => {
  const fullTrace = {
    source: 'tap',
    steps: [
      { name: 'bind', t: 420 },
      { name: 'switch', t: 435, server: { ms: 380, priorExitMs: 0, divergenceMs: 360 } },
      { name: 'sync', t: 645, note: 'load' },
      { name: 'history', t: 1545, count: 2000, server: { ms: 650, cache: 'miss', parseMs: 350 } },
      { name: 'insert', t: 2745, count: 2000 },
      { name: 'highlight', t: 3120, blocks: 678, ms: 356 },
    ],
    end: { t: 3120, outcome: 'done' },
    longTasks: { count: 6, totalMs: 1900, maxMs: 856 },
  };

  test('总耗时 + 每段相对上一段的增量，按发生顺序', () => {
    const line = formatOpenPerfLine(fullTrace);
    assert.match(line, /^\[PERF\] 打开会话 3120ms/);
    assert.match(line, /绑定视图 \+420.*切换回执 \+15.*同步回执 \+210.*历史回执 \+900.*插入 \+1200.*高亮 \+375/);
  });

  test('服务端拆分、走了哪条路、条数、块数与长任务都写进去——分得清是网络、服务端还是前端在慢', () => {
    const line = formatOpenPerfLine(fullTrace);
    assert.match(line, /切换回执 \+15（服务端 380ms：priorExit 0 · divergence 360）/);
    assert.match(line, /同步回执 \+210（load）/);
    assert.match(line, /历史回执 \+900（2000 条；服务端 650ms：cache miss · parse 350）/);
    assert.match(line, /高亮 \+375（678 块，356ms）/);
    assert.match(line, /长任务 6 次 共 1900ms 最长 856ms$/);
  });

  test('不拉历史时没有历史段；浏览器测不了长任务时写「不可测」而不是假装 0 次', () => {
    const line = formatOpenPerfLine({
      source: 'bind',
      steps: [{ name: 'bind', t: 0 }, { name: 'sync', t: 180, note: 'keep' }],
      end: { t: 180, outcome: 'keep' },
      longTasks: null,
    });
    assert.match(line, /^\[PERF\] 打开会话 180ms（视图切入 · 不拉历史）/);
    assert.doesNotMatch(line, /历史回执/);
    assert.match(line, /长任务 不可测$/);
  });
});

test.describe('formatStartupPerfLine：启动一行写清各时间点（距导航开始）', () => {
  const startup = {
    marks: {
      connect: { t: 1500, transport: 'polling' }, // 传入顺序故意打乱：输出必须按时间排
      html: { t: 180 },
      instances: { t: 1650 },
      appjs: { t: 1100 },
      parsed: { t: 700 },
      dcl: { t: 1150 },
    },
    ready: { t: 2350, label: '首页列表' },
    resources: { count: 95, cached: 0, revalidated: 90, fetched: 5, bytes: 319_488, lastEndMs: 1050 },
    longTasks: { count: 4, totalMs: 800, maxMs: 420 },
  };

  test('按发生先后排成一条时间线，到就绪点为止', () => {
    const line = formatStartupPerfLine(startup);
    assert.match(line, /^\[PERF\] 启动 2350ms（首页列表）/);
    assert.match(line, /HTML 到齐 180 → 解析完 700 → app\.js 开跑 1100 → DCL 1150 → 连上 1500（polling） → 首个 instances 1650 → 首页列表 2350；/);
  });

  test('资源按缓存 / 重验 / 下载分开数，长任务汇总在末尾', () => {
    const line = formatStartupPerfLine(startup);
    assert.match(line, /一方资源 95 个：缓存 0 · 重验 90 · 下载 5 · 312KB · 最后到齐 1050；长任务 4 次 共 800ms 最长 420ms$/);
  });

  test('没采到的点不出现；浏览器给不了资源 / 长任务数据时写「不可测」', () => {
    const line = formatStartupPerfLine({ marks: { html: { t: 90 } }, ready: { t: 400, label: '会话就绪' }, resources: null, longTasks: null });
    assert.match(line, /^\[PERF\] 启动 400ms（会话就绪）：HTML 到齐 90 → 会话就绪 400；一方资源 不可测；长任务 不可测$/);
  });

  test('就绪之后才到的点单独成行（websocket 升级常晚于首页）', () => {
    assert.equal(formatLateStartupMark('upgrade', { t: 2900, transport: 'websocket' }), '[PERF] 启动后 升级 2900（websocket）');
  });
});

// service-sampler.js —— 重启历史采样的 glue 层（IO 全部注入，逻辑可测）。
//
// ## 为什么单独一层
//
// 判定（谁重启了、算不算 flapping）在 service-events.js，那一层测得不错。而 2026-08-14
// 第三轮审查里出问题的**全是 glue**，它当时整个住在 src/server/app.js 里、零测试：
//
//   · 快照只在内存 ⇒ server 自身的重启结构性永远记不到（最该抓的场景是唯一的盲区）
//   · 落盘前没有 mkdir ⇒ 全新安装时每轮 ENOENT，事件静默消失
//   · 快照推进排在写盘之前 ⇒ 写失败那批事件永久丢失，下一轮 diff 也拿不回来
//   · 采样器搭在 WEB_STATUSLINE 的开关上 ⇒ 用户关掉状态栏就连带停了采样
//
// 这些都不是判定错误，是**接线错误**——而 app.js 是组装根、进不去单测。所以按
// scripts/service.js 的 createServiceManager 同一范式：全部 IO 走 deps，宿主机零成本可测。
import {
  MAX_SERVICE_EVENTS,
  RESTART_INTENT_KIND,
  appendEvents,
  classifyRestartPattern,
  deserializeSnapshot,
  diffRunningState,
  serializeSnapshot,
  validateServiceEvents,
} from './service-events.js';

// 时间线给 UI 画几条。不是「历史上限」（那是 MAX_SERVICE_EVENTS），只是一屏能看的量。
const RECENT_LIMIT = 10;

export function createServiceSampler(deps = {}) {
  const {
    platform = typeof process !== 'undefined' ? process.platform : '',
    labelPrefix = 'com.ccm.',
    now = Date.now,
    // listUnits: () => Map<label,{pid,lastExit}> | null。null = 这次没取到（launchctl 挂了）,
    // 与「取到了但是空的」必须区分：后者意味着 unit 全没了，前者只是这一轮没数据。
    listUnits = () => null,
    readEventsRaw = () => null,     // 已 JSON.parse 的内容，读不到给 null
    writeEvents = () => {},         // (array) => void，抛错即视为失败
    readSnapshotRaw = () => null,
    writeSnapshot = () => {},       // (object) => void
    log = () => {},
    warn = () => {},
    recentLimit = RECENT_LIMIT,
  } = deps;

  // 启动时从盘上取基线。取不到 → 空 Map ＝「没有可比的前值」⇒ 首次采样静默。
  let lastSnapshot = deserializeSnapshot(readSnapshotRaw());
  // 把「盘上现在是什么」也记下来，否则启动后第一次采样必定重写一遍内容完全相同的快照。
  // 注意归一化：比较的是 serializeSnapshot 之后的形态，不是文件原文（原文可能缩进/键序不同）。
  let lastSnapshotJson = lastSnapshot.size ? JSON.stringify(serializeSnapshot(lastSnapshot)) : null;

  const readEvents = () => validateServiceEvents(readEventsRaw());

  function sample() {
    if (platform !== 'darwin') return; // 非 macOS 没有 launchd 快照可比；headless 的重启记录走下面那条路
    const live = listUnits();
    if (!(live instanceof Map)) return; // 这一轮没取到；下一轮再试，绝不据此清空

    // 只留我们前缀下的 unit：机器上还有十几个第三方 agent，全记进来没有意义
    const mine = new Map([...live].filter(([label]) => String(label).startsWith(labelPrefix)));
    const events = diffRunningState(lastSnapshot, mine, now());

    // ★ 快照推进必须排在事件落盘**之后**。排前面的话，写盘失败（目录不存在 / 磁盘满）时
    // 那批事件永久丢失、下一轮 diff 也拿不回来 —— 只留一条 warn。
    if (events.length > 0) {
      try {
        writeEvents(appendEvents(readEvents(), events).slice(-MAX_SERVICE_EVENTS));
        for (const e of events) {
          log(`[service] ${e.label} ${e.kind}${e.from ? ` pid ${e.from}→${e.to ?? '-'}` : ''}`);
        }
      } catch (err) {
        warn(`[service] 重启事件落盘失败（保留快照，下轮重试）：${err?.message || err}`);
        return; // 不推进
      }
    }
    lastSnapshot = mine;

    // 快照独立落盘：它是**下一条命**的比对基线，写失败只影响那一次比对，
    // 不该回滚已经记下的事件。只在内容变化时写——绝大多数采样什么都没变。
    try {
      const obj = serializeSnapshot(mine);
      const json = JSON.stringify(obj);
      if (json !== lastSnapshotJson) {
        writeSnapshot(obj);
        lastSnapshotJson = json;
      }
    } catch (err) {
      warn(`[service] 快照落盘失败（下一条命将缺少比对基线）：${err?.message || err}`);
    }
  }

  /**
   * server 自己的启动记录 —— **非 macOS 平台的重启历史唯一来源**。
   *
   * sample() 第一行就按平台早退，所以非 macOS（headless）用户的「重启记录」段
   * 一直是空的：那一整块面板对他们不存在。而 server 自己知道自己什么时候起来的，
   * 这个事实与进程管理器无关，任何平台都成立。
   *
   * ## 为什么 darwin 上不记
   *
   * 两条路径**必须互斥**。macOS 上 launchctl 快照比对已经能认出 server 自身重启
   * （2026-08-14 把快照落盘之后修好的），再记一次会让同一次重启进两条事件 ——
   * flapping 阈值被实际打成一半，恒亮告警又回来了。
   *
   * 而且 launchctl 那条路更全：它还能看到隧道、日志轮转、菜单栏那些 server 自己
   * 压根不知道的 unit。所以不是「通用实现取代平台实现」，是各自负责能看到的部分。
   *
   * kind 的判据是「盘上有没有本 label 的历史」：首次运行记 started（不计入频率，
   * 那是首次启动不是循环），之后每次记 restarted。与 diffRunningState 的语义一致。
   */
  function recordSelfStart(at = now()) {
    if (platform === 'darwin') return null;

    const label = `${labelPrefix}server`;
    try {
      const events = readEvents();
      const kind = events.some((e) => e.label === label) ? 'restarted' : 'started';
      const event = { ts: at, label, kind, from: null, to: null, lastExit: null };
      writeEvents(appendEvents(events, [event]).slice(-MAX_SERVICE_EVENTS));
      log(`[service] ${label} ${kind}（自身启动记录）`);
      return event;
    } catch (err) {
      // 记不了历史不该让 server 起不来 —— 这是可观测性功能，不是启动前提。
      warn(`[service] 自身启动记录落盘失败（本次重启不会出现在历史里）：${err?.message || err}`);
      return null;
    }
  }

  /**
   * 「接下来那次换 pid 是用户按的」。在 dev:restart 真正退出之前调用。
   *
   * ## 为什么必须由发起方记
   *
   * 采样器只能看见 pid 变了，看不见为什么变 —— 崩溃重启和用户点「立即重启」在 launchctl
   * 眼里一模一样。而配置面板每次保存成功都给一个「立即重启」按钮，手机上改三次配置就凑够
   * 「1 小时 3 次」，doctor 于是报「疑似崩溃重启循环」、面板变红、菜单栏图标变 ◐ —— 什么都没崩。
   *
   * ## 为什么这里**不**按平台早退
   *
   * recordSelfStart 在 darwin 上早退，是因为 launchctl 快照比对已经能认出 server 自身重启，
   * 再记一次会重复计数。这条相反：darwin 正是那条会产出 restarted 的路径，也就正是需要
   * 「这次是有意的」这份声明的地方。两个方法的平台条件天然相反，不要照着上面那个抄。
   */
  function recordRestartIntent(at = now()) {
    const label = `${labelPrefix}server`;
    try {
      const event = { ts: at, label, kind: RESTART_INTENT_KIND, from: null, to: null, lastExit: null };
      writeEvents(appendEvents(readEvents(), [event]).slice(-MAX_SERVICE_EVENTS));
      return event;
    } catch (err) {
      // 记不下来只会让这次重启被当成崩溃计一次，不该阻断重启本身。
      warn(`[service] 重启意图落盘失败（这次重启可能被计入 flapping）：${err?.message || err}`);
      return null;
    }
  }

  /**
   * 面板要的两段。判定化：不给裸计数器，给「有没有在频繁重启」+ 一小段时间线。
   *
   * 时间线只取「摘要里有话说的那些 unit」的事件。此前是全局最后 N 条，于是一个高频 label
   * 能把时间线整个占满，用户看到「com.ccm.tunnel 24 小时内 5 次」下面却一条 tunnel 都没有 ——
   * 同一屏里两段互相打脸。摘要为空时不过滤：那时时间线是唯一的信息。
   */
  function summarize(at = now()) {
    const events = readEvents();
    if (events.length === 0) return { units: [], recent: [] };
    const labels = [...new Set(events.map((e) => e.label))].sort();
    const units = labels.map((label) => ({ label, ...classifyRestartPattern(events, { label, now: at }) }));
    const shown = new Set(units.filter((u) => u.last24h > 0 || u.flapping).map((u) => u.label));
    const pool = shown.size ? events.filter((e) => shown.has(e.label)) : events;
    return { units, recent: pool.slice(-recentLimit).reverse() }; // 倒序：最新的在前
  }

  return { sample, recordSelfStart, recordRestartIntent, summarize };
}

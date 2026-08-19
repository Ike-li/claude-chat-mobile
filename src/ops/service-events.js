// 桌面端服务的重启历史：从两次 `launchctl list` 快照之间认出重启，并按**频率**判定异常。
//
// ## 为什么需要历史，而不是直接看 LastExitStatus
//
// launchd 只保留「最后一次怎么退出的」——那是瞬时值，回答不了「这正常吗」。
// 机主机器上的实证（2026-08-14）：隧道的 `LastExitStatus = -9` 看着像崩溃，实际是自建看门狗
// `com.ccm.tunnel-watch` 每 30s 检测 en0 的 DHCP 漂移、发现变了就 `launchctl kickstart -k`
// 留下的痕迹（`-k` 先 SIGKILL）。路由器每天换一次 IP，于是这个「异常退出」每天都在。
//
// 用瞬时值判 flapping 的后果是**每天误报一次**，而恒亮的告警比没有告警更糟：它会训练用户
// 忽略这个图标，等真出事那天也不会多看一眼。这与 doctor D4 那个「端口被自家服务占用判 fail」
// 的恒红是同一类错误。
//
// 只有时间序列能区分：每天一次是路由器换 IP，一小时内三次才是真进了崩溃重启循环。
//
// 本文件零 IO：快照由调用方 exec `launchctl list` 拿到，落盘由调用方负责。

// 环形上限。一天正常也就几条，200 条够看两三个月；上限存在的意义是防止某个真出问题的
// unit 在崩溃循环里把文件撑爆。
export const MAX_SERVICE_EVENTS = 200;

// ★ restart-requested 必须在这个白名单里，否则 recordRestartIntent 写下去的声明在读回来时
// 被整条丢弃 —— 那不只是「抵消逻辑不生效」：recordRestartIntent 自己也走 readEvents()，
// 于是每写一条新 intent 就把上一条从磁盘上抹掉。加它的时候漏了这里，而单测只断言
// 「写入侧收到了什么」、从不 round-trip 读一次，所以三千多条测试全绿。
const KINDS = new Set(['restarted', 'started', 'stopped', 'restart-requested']);

// ## 只有 restarted 计入频率（2026-08-14 第三轮审查修正）
//
// 上一版把 started 也算进来，后果是**把刚消灭的恒亮告警搬到了另一个 label 上**：
// 机主机器上的 `com.ccm.tunnel-watch`（每 30s 检测 DHCP 漂移）与 `com.ccm.logrotate` 在
// `launchctl list` 里 pid 恒为 `-` —— 它们是短命周期 job 不是常驻进程。采样器 60s 抓一次，
// 抓到在跑产 started、下次抓到已退出产 stopped，一小时抓够三次就误报 flapping。
//
// 判据收窄成 pid→pid（进程被就地换掉）。取舍：
//   · 崩溃循环在 60s 粒度下几乎必然是 pid→pid（KeepAlive 立刻拉起），命中
//   · 周期 job 是 null↔pid 交替，天然不命中
//   · 代价：「停了很久再手动起来」的循环不计入 —— 那是用户操作，本来就不该叫 flapping
// started / stopped 仍然**照常记录**，它们进时间线供人看，只是不参与下告警结论。
const RESTART_KINDS = new Set(['restarted']);

// 用户主动重启（手机面板的「立即重启」→ dev:restart）在退出前先记一条这个 kind。
// 它本身不是重启，是一份「接下来那次换 pid 是我按的」的声明——采样器无从分辨有意与崩溃，
// 只有发起方知道。它进时间线供人看，但不参与频率判据。
export const RESTART_INTENT_KIND = 'restart-requested';

// 一条 intent 认领其后多久内的那次 restarted。要盖住「优雅退出 200ms + KeepAlive 拉起 +
// 采样器下一轮 tick」，同时短到不会把一次真崩溃误认成用户操作。
const INTENT_WINDOW_MS = 120_000;

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

// 1 小时内重启 ≥3 次才算 flapping。阈值取 3 而不是 2：DHCP 漂移偶尔会在短时间内连着来两次
// （拿到 IP → 立刻又换），那仍是正常运维。
const FLAP_WINDOW_MS = HOUR_MS;
const FLAP_THRESHOLD = 3;

const pidOf = (entry) => {
  const p = entry?.pid;
  return typeof p === 'number' && Number.isFinite(p) ? p : null;
};

/**
 * 比较两次 `launchctl list` 快照，产出事件。
 * prev / next 是 Map<label, { pid, lastExit }>（parseLaunchctlList 的输出形状）。
 *
 * 两条刻意的静默：
 *   ① prev 为空（server 刚起来的第一次采样）——否则每次 server 重启都会把全部 unit 记成
 *      started，重启历史被 server 自己的重启刷屏，频率判定跟着失真。
 *   ② 某个 label 第一次出现（刚 install）或消失（刚 uninstall）——没有可比的前值/后值。
 */
export function diffRunningState(prev, next, now = Date.now()) {
  if (!prev || !(prev instanceof Map) || prev.size === 0) return [];
  if (!next || !(next instanceof Map)) return [];

  const events = [];
  for (const label of [...next.keys()].sort()) {
    if (!prev.has(label)) continue; // 第一次见到它
    const before = pidOf(prev.get(label));
    const after = pidOf(next.get(label));
    if (before === after) continue;

    const lastExit = next.get(label)?.lastExit ?? null;
    if (before !== null && after !== null) {
      events.push({ ts: now, label, kind: 'restarted', from: before, to: after, lastExit });
    } else if (after !== null) {
      events.push({ ts: now, label, kind: 'started', from: null, to: after, lastExit });
    } else {
      events.push({ ts: now, label, kind: 'stopped', from: before, to: null, lastExit });
    }
  }
  return events;
}

/** 有界追加，最旧的先被挤掉。 */
export function appendEvents(existing, incoming) {
  const merged = [...(existing || []), ...(incoming || [])];
  return merged.length <= MAX_SERVICE_EVENTS ? merged : merged.slice(merged.length - MAX_SERVICE_EVENTS);
}

/**
 * 某个 label 的重启形态。返回给 UI 与 doctor 判据用。
 * flapping 的定义从「最后一次退出码非 0」换成「短窗口内重启多次」——见文件头注。
 */
export function classifyRestartPattern(events, { label, now = Date.now() } = {}) {
  // `e.ts <= now` 不是多余的：`now - e.ts < WINDOW` 对**未来**时间戳的差值是负数，
  // 而负数恒 < 窗口 ⇒ 全部历史事件一起落进「1 小时内」⇒ 假 flapping 恒亮。
  // 触发路径：NTP 大幅回拨 / VM 快照回滚 / 有人手改过 service-events.json。
  const inWindow = (e, win) => e.ts <= now && now - e.ts < win;
  const ours = (events || []).filter((e) => e && e.label === label);
  const mine = ours.filter((e) => RESTART_KINDS.has(e.kind));

  // ★ 把「用户自己按的重启」从频率判据里摘掉。配置面板每次保存成功都给一个「立即重启」按钮，
  // 手机上改三次配置就凑够「1 小时 3 次」→ doctor 报「疑似崩溃重启循环」、面板变红、菜单栏 ◐，
  // 而根本没有东西崩过。恒亮的告警比没有告警更糟，见本文件头注。
  //
  // 每条 intent 只认领**紧随其后的第一条** restarted，不是抵消整个窗口：否则「重启完之后
  // 真的开始崩溃循环」就被一次主动重启永久打掩护了。
  const intentional = new Set();
  const intents = ours.filter((e) => e.kind === RESTART_INTENT_KIND).map((e) => e.ts).sort((a, b) => a - b);
  for (const at of intents) {
    const hit = mine.find((e) => !intentional.has(e) && e.ts >= at && e.ts - at < INTENT_WINDOW_MS);
    if (hit) intentional.add(hit);
  }
  const counted = mine.filter((e) => !intentional.has(e));

  const past = mine.filter((e) => e.ts <= now);
  const lastHour = counted.filter((e) => inWindow(e, FLAP_WINDOW_MS)).length;
  const last24h = counted.filter((e) => inWindow(e, DAY_MS)).length;
  // 「24 小时内重启 N 次」在 UI 上是当**事实**说的，所以还要给出手动那部分的条数 ——
  // 否则「一次崩溃 + 三次面板重启」会显示成「24 小时内 1 次 · 上次 刚刚」，而「上次」
  // 指向的那次并不在这 1 次里，同一行自相矛盾。
  const manual24h = mine.filter((e) => intentional.has(e) && inWindow(e, DAY_MS)).length;
  // lastRestartAt 取**全部**重启的最后一条：那是「上次重启在什么时候」这个事实，历史面板
  // 要如实显示，与「这些重启算不算异常」是两回事。
  const lastRestartAt = past.length ? Math.max(...past.map((e) => e.ts)) : null;
  return { lastHour, last24h, manual24h, flapping: lastHour >= FLAP_THRESHOLD, lastRestartAt };
}

// ## 快照的持久化（2026-08-14 第三轮审查修复的最大盲区）
//
// 修的是：`com.ccm.server` 自身的重启**结构性永远记不到**。两条叠加：
//   ① 命内：`launchctl list` 里 com.ccm.server 的 pid 就是采样进程自己（ps 实证 pid 恒定），
//      于是 diffRunningState 的 `before === after` 恒成立，永不产出事件；
//   ② 跨命：快照只在内存，server 重启即归零，新命首次采样走「prev 为空」的静默分支。
// 结果是最该被抓到的场景（server 自己在崩溃重启循环）成了唯一抓不到的。
//
// 把快照落盘之后，新命的首次采样拿得到**上一命**的 pid，server 换命即产出一条 restarted，
// 频率判据这才对 server 生效。首次运行（盘上没有快照）仍然静默——那是真的没有基线。
//
// 形状与 parseLaunchctlList 的输出一致：Map<label, {pid, lastExit}>，pid 可为 null。

/** Map → 可 JSON 序列化的普通对象。 */
export function serializeSnapshot(snapshot) {
  const out = {};
  if (!(snapshot instanceof Map)) return out;
  for (const [label, entry] of snapshot) {
    if (typeof label !== 'string' || !label) continue;
    out[label] = { pid: pidOf(entry), lastExit: typeof entry?.lastExit === 'number' ? entry.lastExit : null };
  }
  return out;
}

/**
 * 普通对象 → Map。**读不懂一律退化成空 Map**（＝没有基线 ⇒ 首次采样静默），
 * 绝不抛错、也绝不伪造事件：坏快照制造出来的假重启比没有历史更糟。
 * pid 为 null 的条目必须原样保留——那是周期 job 的常态，丢了会在下一轮被误判成 started。
 */
export function deserializeSnapshot(raw) {
  const map = new Map();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const [label, entry] of Object.entries(raw)) {
    if (typeof label !== 'string' || !label) continue;
    if (!entry || typeof entry !== 'object') continue;
    // pid 必须是 number 或 null；'x' 这种脏值整条丢弃，不要静默当成 null（那会伪造出 started）
    const hasPid = Object.hasOwn(entry, 'pid');
    if (!hasPid) continue;
    if (entry.pid !== null && !(typeof entry.pid === 'number' && Number.isFinite(entry.pid))) continue;
    map.set(label, { pid: entry.pid, lastExit: typeof entry.lastExit === 'number' ? entry.lastExit : null });
  }
  return map;
}

/** 读盘校验。读不懂一律当作「没有历史」，绝不抛错阻断 status。 */
export function validateServiceEvents(raw) {
  if (!Array.isArray(raw)) return [];
  const ok = raw.filter((e) => e
    && typeof e === 'object'
    && typeof e.ts === 'number'
    && Number.isFinite(e.ts)
    && typeof e.label === 'string'
    && e.label.length > 0
    && KINDS.has(e.kind));
  return ok.length <= MAX_SERVICE_EVENTS ? ok : ok.slice(ok.length - MAX_SERVICE_EVENTS);
}

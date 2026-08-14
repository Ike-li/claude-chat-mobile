// 常驻服务的重启历史：从两次 `launchctl list` 快照之间认出重启，并按**频率**判定异常。
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

const KINDS = new Set(['restarted', 'started', 'stopped']);

// 「进程重新开始了」的两种形态都计入频率：restarted 是 kickstart -k 那种瞬间换 PID，
// started 是 stop 之后又起来。stopped 不算 —— 那通常是用户主动停的。
const RESTART_KINDS = new Set(['restarted', 'started']);

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
  const mine = (events || []).filter((e) => e && e.label === label && RESTART_KINDS.has(e.kind));
  const lastHour = mine.filter((e) => now - e.ts < FLAP_WINDOW_MS).length;
  const last24h = mine.filter((e) => now - e.ts < DAY_MS).length;
  const lastRestartAt = mine.length ? Math.max(...mine.map((e) => e.ts)) : null;
  return { lastHour, last24h, flapping: lastHour >= FLAP_THRESHOLD, lastRestartAt };
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

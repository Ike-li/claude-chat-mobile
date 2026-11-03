// session-rename.js —— 网页端给会话改名（#458）：标题清洗 + 活会话的退出补写。
//
// 改名本身就是 SDK 的 renameSession：往 transcript 尾追加一条 custom-title，元数据后写者胜。
// 麻烦在活会话：CLI 追加会话元数据时会把**内存里的**标题当 custom-title 再写一遍（退出收尾必写），
// 而外部改名进不了它的内存——于是一个之前改过名的会话，网页刚改完、CLI 一退出又被写回旧名。
// SDK 的 Query 还没暴露 CLI 的 rename_session 控制请求，只能事后补：记下用户最后一次起的名，
// 等这个会话名下的实例全部退完（与 waitForSessionExits 同一个退出信号），读尾窗最后一条 custom-title，
// 不是用户的名字就再追加一次，保证后写者是用户。将来 SDK 暴露了那个控制请求，这套补写就该删掉。
//
// 管不到的：终端驾驶的会话不在本进程里，没有退出信号可挂（handler 那边给一句「可能被覆盖」的提示）；
// CLI 会话中途回写（例如压缩时）会让抽屉短暂显示回旧名，最终以退出时的补写为准。

export const SESSION_TITLE_MAX = 200;

// 换行与控制字符换成空格（直接删会把前后两段粘成一个词），trim，按字符截到上限。空了就是不合法（null）。
export function sanitizeSessionTitle(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  const title = [...cleaned].slice(0, SESSION_TITLE_MAX).join('').trim();
  return title || null;
}

export function createSessionRenamer({ renameSession, readLastCustomTitle, log = console }) {
  // sessionId → 等退出补写的那个名字。只留最后一次：活会话里连改几次，退出后只该补最后那个。
  const pending = new Map();
  // sessionId → 这个会话上一次写入的结算。改名与退出补写按会话排队：补写「查 pending → 读尾窗 → 追加」
  // 中途若插进一次改名，它会先查过 pending、再把前一次的名字写在新名字后面。
  const queues = new Map();

  function serial(sessionId, fn) {
    const run = (queues.get(sessionId) || Promise.resolve()).then(fn);
    const settled = run.catch(() => {});
    queues.set(sessionId, settled);
    settled.then(() => { if (queues.get(sessionId) === settled) queues.delete(sessionId); });
    return run;
  }

  function reconcile(sessionId, cwd, title) {
    return serial(sessionId, async () => {
      if (pending.get(sessionId) !== title) return; // 之后又改过名（或没有活实例时改过），这一次作废
      pending.delete(sessionId);
      try {
        if (await readLastCustomTitle(sessionId, cwd) === title) return;
        await renameSession(sessionId, title, { dir: cwd });
        log.info?.(`[session-rename] CLI 退出时写回了旧标题，已补写 sessionId=${sessionId}`);
      } catch (err) {
        log.warn?.(`[session-rename] 退出补写失败 sessionId=${sessionId}: ${err?.message || err}`);
      }
    });
  }

  // liveExits：这个会话名下还没退完的实例的退出确认（活的、正在关的都算）。
  // 返回的 afterExit 在补写结算后兑现；没有活实例时为 undefined。调用方不必等它。
  function rename({ sessionId, cwd, title, liveExits = [] }) {
    return serial(sessionId, async () => {
      await renameSession(sessionId, title, { dir: cwd });
      if (!liveExits.length) {
        pending.delete(sessionId);
        return { afterExit: undefined };
      }
      pending.set(sessionId, title);
      return { afterExit: Promise.all(liveExits).then(() => reconcile(sessionId, cwd, title)) };
    });
  }

  return { rename };
}

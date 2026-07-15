// smoke runner `reconnect` —— M3 碎片化验收（docs/design.md A5 自动化版）：
// 模拟"锁屏"：客户端强制断开 → 任务在服务端继续（4c）→ 重连 sync:since 续传 →
// 断言事件无缺口无重复、文本完整、任务正常收尾。
// 用法：npm run test:smoke -- --scenario reconnect
import { io } from 'socket.io-client';

const URL = process.env.CCM_SMOKE_URL || `http://127.0.0.1:${process.env.PORT || 3100}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 事件收集器：模拟 app.js 的 epoch 感知去重
function collector() {
  const events = [];
  let lastSeq = 0, curEpoch = null, dropped = 0;
  return {
    events,
    get lastSeq() { return lastSeq; },
    get epoch() { return curEpoch; },
    get dropped() { return dropped; },
    accept(ev) {
      if (ev.epoch && ev.epoch !== 'server') {
        if (ev.epoch !== curEpoch) { curEpoch = ev.epoch; lastSeq = 0; }
        if (ev.seq <= lastSeq) { dropped++; return false; } // 重复
        lastSeq = ev.seq;
      }
      events.push(ev);
      return true;
    }
  };
}

function connect(col, label) {
  const s = io(URL, { auth: { token: '' }, reconnection: false, timeout: 5000 });
  s.on('agent:event', ev => {
    if (!col.accept(ev)) return;
    const tag = ['text_delta', 'thinking_delta'].includes(ev.type) ? '' : `  [${label}|${ev.type}] seq=${ev.seq} ${JSON.stringify(ev.payload).slice(0, 80)}`;
    if (tag) console.log(tag);
  });
  return new Promise((res, rej) => {
    s.on('connect', () => res(s));
    s.on('connect_error', e => rej(new Error('connect_error: ' + e.message)));
    setTimeout(() => rej(new Error('connect 超时')), 6000);
  });
}

const waitFor = (col, pred, ms, label) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`等待 ${label} 超时 ${ms}ms`)), ms);
  const iv = setInterval(() => {
    const hit = col.events.find(pred);
    if (hit) { clearTimeout(t); clearInterval(iv); res(hit); }
  }, 100);
});

try {
  // ── 阶段 1：连接，发长任务，收到一段输出后"锁屏"（强制断开）──
  const col1 = collector();
  const s1 = await connect(col1, 'conn1');
  console.log('① 已连接，发起长任务');
  s1.emit('user:message', { text: '请从 1 数到 40，每个数字单独一行，不要解释。' });
  await waitFor(col1, e => e.type === 'text_delta', 120000, '首个 text_delta');
  // 再积累一点流式内容，确保断开时任务进行中
  await sleep(1200);
  const textBefore = col1.events.filter(e => e.type === 'text_delta').map(e => e.payload.text).join('');
  const cutSeq = col1.lastSeq;
  const cutEpoch = col1.epoch;
  const hadResultBeforeCut = col1.events.some(e => e.type === 'result');
  s1.disconnect();
  console.log(`② 已"锁屏"断开 @ seq=${cutSeq}（已收 ${textBefore.length} 字符，任务${hadResultBeforeCut ? '已完成(过快)' : '进行中'}）`);

  // ── 阶段 2：断开窗口——任务应在服务端继续跑（4c）──
  await sleep(5000);
  const health = await fetch(`${URL}/health`).then(r => r.json());
  console.log(`③ 断开 5s 后 /health: busy=${health.busy}, sessionId=${(health.sessionId || '').slice(0, 8)}…`);

  // ── 阶段 3：重连 + sync:since 续传 ──
  const col2 = collector();
  const s2 = await connect(col2, 'conn2');
  s2.emit('sync:since', { sessionId: health.sessionId, lastSeq: cutSeq });
  console.log('④ 已重连，请求续传 lastSeq=' + cutSeq);
  // WS-020：按 hadResultBeforeCut 分支。若 result 在断网【前】就已完成（模型过快），它的 seq < cutSeq，
  // sync:since 从 cutSeq+1 起补发不含它 → 旧的无条件 `waitFor(result, 180000)` 会空等满 180 秒误报失败。
  // 已完成路径改用确定性短延迟（给补发/收尾落地一点时间即可），未完成路径才等实时 result 收尾。
  if (hadResultBeforeCut) {
    console.log('   ⚠️ result 断网前已完成，跳过 180s 等待（存活类断言下方标 N/A）');
    await sleep(1500);
  } else {
    await waitFor(col2, e => e.type === 'result', 180000, '任务 result');
  }
  await sleep(500); // 收尾事件落地

  // ── 断言 ──
  const replay = col2.events.filter(e => e.epoch && e.epoch !== 'server');
  check('A5-断开期间任务存活', hadResultBeforeCut || replay.some(e => e.seq > cutSeq),
    hadResultBeforeCut ? '任务断前已完成（存活断言 N/A）' : `重连后收到 ${replay.length} 个事件（seq 最大 ${col2.lastSeq}）`);
  check('A5-epoch一致(同实例续传)', replay.every(e => e.epoch === cutEpoch), `epoch=${cutEpoch}`);

  // seq 连续性：补发+实时合并后，从 cutSeq+1 起无缺口、无重复
  const seqs = replay.map(e => e.seq).sort((a, b) => a - b);
  const uniq = new Set(seqs);
  let noGap = true;
  for (let i = cutSeq + 1; i <= seqs[seqs.length - 1]; i++) if (!uniq.has(i)) { noGap = false; break; }
  check('A5-续传无缺口', noGap, `seq ${cutSeq + 1}..${seqs[seqs.length - 1]}`);
  check('A5-续传无重复', uniq.size === seqs.length && col2.dropped === 0, `去重器丢弃=${col2.dropped}`);

  // 文本完整性：两段拼接应包含 1..40 全部数字（独立成行）
  const textAfter = col2.events.filter(e => e.type === 'text_delta').map(e => e.payload.text).join('');
  const full = textBefore + textAfter;
  const lines = new Set(full.split('\n').map(l => l.trim()).filter(Boolean));
  const missing = [];
  for (let n = 1; n <= 40; n++) if (!lines.has(String(n))) missing.push(n);
  check('A5-跨断线文本完整(1..40)', missing.length === 0,
    missing.length ? `缺失: ${missing.slice(0, 8).join(',')}${missing.length > 8 ? '…' : ''}` : `共 ${full.length} 字符`);

  // 恰好一轮 result（断线不应造成重复轮）
  const resultCount = col1.events.filter(e => e.type === 'result').length
                    + col2.events.filter(e => e.type === 'result').length;
  check('A5-恰一个result', resultCount === 1, `count=${resultCount}`);

  s2.close();

  // ── 阶段 4：迟到观察者（A5b 快照重放）——新连接零消息应即得 init+models ──
  const col3 = collector();
  const s3 = await connect(col3, 'conn3');
  const iEv = await waitFor(col3, e => e.epoch === 'server' && e.type === 'init', 3000, '重放 init').catch(() => null);
  const mEv = await waitFor(col3, e => e.epoch === 'server' && e.type === 'models', 3000, '重放 models').catch(() => null);
  check('A5b-迟到观察者init重放', !!iEv,
    iEv ? `slash×${iEv.payload?.slashCommands?.length ?? 0}` : '3s 内未收到');
  check('A5b-迟到观察者models重放', (mEv?.payload?.models?.length ?? 0) > 0,
    mEv ? `models×${mEv.payload.models.length}` : '3s 内未收到');
  s3.close();
} catch (err) {
  check('A5 执行异常', false, err.message);
} finally {
  console.log(`\n=== M3-A5 结果: ${results.filter(r => r.ok).length}/${results.length} 通过 ===`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}

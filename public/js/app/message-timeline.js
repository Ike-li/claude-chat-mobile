// 消息流时间戳（稀疏式）的 DOM 插入层：跨天插日期分隔行、间隔超阈值插一次 HH:mm。
// 判定与文案全在 logic.js 的纯函数里，这里只管「插不插、插哪、打不打戳」。
//
// 【为什么状态挂在 DOM 上而不是闭包变量】
// 判定需要「上一条主链气泡的时刻」。若用闭包变量存，切换会话时就得在 bindView/clearView 里手动
// 重置——而 sessionDomCache 是把整棵 #messages 子树存下来、切回时原序 appendChild 复原的，
// 闭包变量跟不上这个来回。改成每个气泡自带 data-ts、要用时从容器尾部反向找，状态天生随 DOM 走：
// 缓存复原后自动正确，没有任何需要记得重置的地方。
//
// 【反向扫描而不是 querySelectorAll】
// querySelectorAll('[data-ts]') 是 O(n)，每条消息都查一次就是 O(n²)——2000 条历史会明显卡。
// 从 lastElementChild 沿 previousElementSibling 往回走，步数只等于尾部连续的非气泡节点数
// （工具卡 / thinking / 系统条 / live 状态行）。但一个 agentic 回合可以连着堆几百张工具卡，
// 所以仍加上限：超了就当没找到，退化成「按首条处理」，绝不把主线程耗在这里。
import { MESSAGE_TIME_GAP_MS, formatMessageTimeMarker, normalizeMessageTs, resolveMessageTimeMarker } from '../logic/message-time.js';

const SCAN_LIMIT = 500;

export function createMessageTimeline({
  createElement,
  appendMessage,
  messagesEl,
  gapMs = MESSAGE_TIME_GAP_MS,
  now = () => Date.now(),
} = {}) {
  // 从 startNode 起沿 previousElementSibling 反向找最近一条带 data-ts 的节点。
  // 三态，缺一不可：number = 找到；null = 【确实没有】（会话首条）；undefined = 扫满上限、
  // 前一条在视野之外。后两者绝不能混同——判定层把 prevTs==null 当作「会话首条」无条件出日期行，
  // 若扫满也返回 null，一个堆了几百张工具卡的回合之后就会凭空多出一条整宽日期分隔行，
  // 看起来像会话在这里重新开始了。
  //
  // 反向逐个走而不是 querySelectorAll('[data-ts]')：后者 O(n)，每条消息查一次就是 O(n²)，
  // 2000 条历史会明显卡。这里的步数只等于尾部连续的非气泡节点数（工具卡 / thinking / 系统条）。
  function scanTsBackFrom(startNode) {
    let node = startNode;
    for (let steps = 0; steps < SCAN_LIMIT; steps++, node = node.previousElementSibling) {
      if (!node) return null;
      const ts = Number(node.dataset?.ts);
      if (Number.isFinite(ts) && ts > 0) return ts;
    }
    return undefined;
  }

  const lastTimestampIn = container => scanTsBackFrom(container?.lastElementChild ?? null);

  // day 行复用 .unread-divider 的两侧横线样式（见 app.css）；time 行是纯居中细字。
  // 文案一律 textContent —— 这里的内容来自时间格式化，没有任何理由走 innerHTML。
  //
  // 【已知取舍】「今天/昨天」在插入这一刻求值一次，此后不再刷新，而 marker 会随 sessionDomCache
  // 长期存活。挂着页面跨过本地午夜后，早先那行「今天 09:00」就成了假话（它其实是昨天）。
  // 不修的理由：要修得给 day 行挂 data-day-ts + 起一个跨午夜定时器批量重算，为 n=1 自托管
  // 场景引入一个常驻定时器不划算；且用户下拉刷新或切走再切回触发重渲染即自愈。
  // 若哪天真机上被反馈成困扰，改这里即可，判定层不用动。
  function buildMarker(marker) {
    const dayClass = marker.kind === 'day' ? ' msg-day-divider' : '';
    const node = createElement(
      `<div class="msg-frame${dayClass} text-center text-[11px] text-ink-faint"`
      + ` data-testid="msg-time-marker" data-marker-kind="${marker.kind}"></div>`);
    if (node) {
      // dataset 这次是冗余写（HTML 里已有 data-marker-kind）——留着是为了单测的假 createElement：
      // 它不解析 HTML 字符串，只有显式写 dataset 才能让「插的是哪种 marker」可断言。
      node.dataset.markerKind = marker.kind;
      node.textContent = formatMessageTimeMarker(marker, { now: now() });
    }
    return node;
  }

  // marker 必须先于气泡落地：unread-pill.spec.ts 用 :last-of-type 找锚点，marker 与气泡同为 div，
  // 一旦 marker 成了 #messages 的最后一个元素，那条断言会静默失效。
  //
  // prevTs 为 undefined 表示「扫满上限、前一条在视野之外」：宁可不插行也不能当成会话首条，
  // 后者会在一堆工具卡之后凭空插一条日期分隔行。仍要打戳，让再往后的消息有基准可依。
  function stamp(node, ts, prevTs, role, putMarker) {
    if (prevTs !== undefined) {
      const marker = resolveMessageTimeMarker({ ts, prevTs, role, gapMs });
      if (marker) {
        const markerNode = buildMarker(marker);
        if (markerNode) putMarker(markerNode);
      }
    }
    node.dataset.ts = String(ts);
  }

  return {
    // live 三处：在线 user 气泡 / 流式 assistant 气泡 / 离线乐观占位（后者传 null，见下）。
    // 离线占位刻意不打客户端 Date.now()：手机时钟若快几小时，那条 data-ts 会落在未来，而判定层
    // 「ts < prevTs → 不插行」的规则排在跨天之前，之后每条服务端时间都被判成倒流 —— 连日期行都
    // 永久消失，且该节点随 sessionDomCache 长期存活。转正时由 user_message 补服务端权威 ts。
    appendWithTime(node, rawTs, role) {
      const ts = normalizeMessageTs(rawTs);
      if (ts != null) stamp(node, ts, lastTimestampIn(messagesEl), role, appendMessage);
      return appendMessage(node);
    },

    // 历史回放：节点先进游离的 fragment，最后一次性插入 #messages。
    //
    // fragment 是【线性构建】的，所以基准不必每条反向扫，seed 一次之后顺着往下带即可：
    //  · 全量加载 loadHistory：seedPrevTs = null，这批就是整个会话的开头。
    //  · 增量追平 history_append：seedPrevTs = #messages 尾巴的戳，接上前一批。
    // 这样「全量 vs 增量」是一个数据（seed 值），不是一个布尔开关；也不再有「要不要偷看
    // #messages」这种把实现细节外泄给调用方的选项。
    // ★ 不能写成解构默认值 `{ seedPrevTs = null }`：默认值在【值为 undefined 时也会触发】，而
    // undefined 正是 scanTsBackFrom 的第三态哨兵（扫满上限、前一条在视野外）。压成 null 就等于
    // 告诉判定层「这是会话首条」，于是几百张工具卡之后的增量追平会凭空多一条日期分隔行。
    // 用 in 判断键是否存在：缺省（全量加载不传）才回落 null，显式传 undefined 一律原样保留。
    beginFragment(frag, opts = {}) {
      let prevTs = 'seedPrevTs' in opts ? opts.seedPrevTs : null;
      return (node, rawTs, role) => {
        const ts = normalizeMessageTs(rawTs);
        if (ts != null) {
          stamp(node, ts, prevTs, role, n => frag.appendChild(n));
          prevTs = ts;
        }
        return frag.appendChild(node);
      };
    },

    // 给已在 DOM 里的气泡补戳并把该插的时间行插在它【前面】。两处用：
    //  · 离线占位转正——它早就不在容器尾部了，拿尾巴当基准会错。
    //  · 拉历史在途时被闸门扣住、事后放行的增量（见 history-load-gate.js）。
    settleAt(node, rawTs, role) {
      const ts = normalizeMessageTs(rawTs);
      const parent = node?.parentNode;
      if (ts == null || !parent) return;      // 节点已被清屏摘掉 / ts 不可信 → 安全退化
      stamp(node, ts, scanTsBackFrom(node.previousElementSibling ?? null), role,
        markerNode => parent.insertBefore(markerNode, node));
    },
    lastTimestampIn,
  };
}

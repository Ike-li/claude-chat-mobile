// public/js/app/folder-drag.js —— 抽屉文件夹行长按拖动排序（2026-10-26，取代 #305 置顶）。
//
// 只挂在连接根的行上；拖的是整块：根的头行 + 展开区 + 紧随其后的子文件夹小节（composeProjects 保证它们相邻），
// 「无文件夹」与「不在已连接的文件夹里」不参与。按住 holdMs 不动（容差 moveTolerance）才拖起来，之前手指一动就交还
// 给浏览器滚动。拖起来后 #sessionPanel 加 folder-dragging，CSS 收起所有展开区与子文件夹小节，只剩各根的头行——
// 展开区高矮不一，不收起来的话越过一个展开的根要拖过它整段会话列表。收起与放下时各补一次 scrollTop，让被拖的行
// 尽量停在手指下；列表已经滚到顶时补不满，行会离开手指——所以之后只认手指的【位移】：行中线 = 拖起来时的中线 +
// 手指移动量（不认手指的绝对位置，否则手指落在收起后的空白处，一动行就被甩到最末）。行用 translateY 跟着手指走，
// 越过邻行中线时就地挪 DOM，松手时顺序变了才交给 onDrop（调用方发给服务端）。
//
// 三处要拦的浏览器默认行为：
// - 触屏 touchmove 在行上 preventDefault：不拦浏览器就开始滚动并发 pointercancel，拖动当场断掉；同时 stopPropagation，
//   文档上抽屉的左滑收起（drawer.js）收不到这次横向位移——会话行的侧滑曾因此把抽屉整个收走。
// - 松手补发的 click：拖起来又原地松手时浏览器照常补发（行挪过位置的话 Chrome 不发），不拦就把这一节展开或折叠。
//   拦法：文档 capture 阶段吞一次，下一次 pointerdown / keydown 撤掉。
// - 触屏长按的 contextmenu（Android 会补发）：拦掉，免得弹系统菜单。鼠标右键不拦。
//
// 拖动中行可能被局部重建换掉（instances 广播），那时手里的节点已不在文档里：放弃这次拖动，交给 onCancel 按服务端顺序重画。
export function attachFolderDrag(handle, {
  row,
  panel,
  onDrop,
  onCancel = () => {},
  haptic = () => {},
  holdMs = 500,
  moveTolerance = 10,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let doc = null; // 拖起来时才取：挂上来时行还在 el() 的模板文档里，没插进页面
  let timer = null;
  let startX = 0, startY = 0;
  let touchGesture = false;
  let dragging = false;
  let startOrder = [];
  let offset = 0; // 行中线 - 手指位置，拖起来那一刻量

  const rootRows = () => [...panel.children].filter(n => n.dataset?.dirKind === 'connected');
  const blockOf = (head) => {
    const nodes = [head];
    for (let n = head.nextElementSibling; n && (n.classList.contains('subtree-container') || n.dataset?.dirKind === 'subfolder'); n = n.nextElementSibling) nodes.push(n);
    return nodes;
  };
  const midY = n => { const r = n.getBoundingClientRect(); return r.top + r.height / 2; };
  // 量的是去掉 translateY 之后的位置（行在列表里的实际槽位）
  const restMidY = () => { row.style.transform = ''; return midY(row); };
  // 切换收起态前后各量一次，差多少就把面板滚多少：被拖的行留在手指下
  const keepRowInPlace = (change) => {
    const before = row.getBoundingClientRect().top;
    change();
    panel.scrollTop += row.getBoundingClientRect().top - before;
  };

  function cancelHold() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function armClickGuard() {
    const swallow = ev => { disarm(); ev.preventDefault(); ev.stopPropagation(); };
    const disarm = () => {
      doc.removeEventListener('click', swallow, true);
      doc.removeEventListener('pointerdown', disarm, true);
      doc.removeEventListener('keydown', disarm, true);
    };
    doc.addEventListener('click', swallow, true);
    doc.addEventListener('pointerdown', disarm, true);
    doc.addEventListener('keydown', disarm, true);
  }

  function start() {
    timer = null;
    if (!row.isConnected || rootRows().length < 2) return;
    doc = handle.ownerDocument;
    dragging = true;
    startOrder = rootRows().map(n => n.dataset.dir);
    haptic('tap');
    armClickGuard();
    keepRowInPlace(() => panel.classList.add('folder-dragging'));
    row.classList.add('folder-drag-active');
    offset = midY(row) - startY;
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onAbort, true);
  }

  function stop() {
    dragging = false;
    doc.removeEventListener('pointermove', onMove, true);
    doc.removeEventListener('pointerup', onUp, true);
    doc.removeEventListener('pointercancel', onAbort, true);
    row.classList.remove('folder-drag-active');
    row.style.transform = '';
  }

  function onMove(ev) {
    if (!row.isConnected) return onAbort();
    const y = ev.clientY + offset;
    const others = rootRows().filter(n => n !== row);
    const index = others.filter(n => midY(n) < y).length;
    const current = rootRows().indexOf(row); // 也等于排在它前面的 others 个数
    if (index !== current) {
      const nodes = blockOf(row);
      if (index < others.length) others[index].before(...nodes);
      else blockOf(others.at(-1)).at(-1).after(...nodes);
    }
    row.style.transform = `translateY(${y - restMidY()}px)`;
  }

  function onUp() {
    if (!row.isConnected) return onAbort();
    stop();
    keepRowInPlace(() => panel.classList.remove('folder-dragging'));
    const order = rootRows().map(n => n.dataset.dir);
    if (order.join('\n') !== startOrder.join('\n')) onDrop(order);
  }

  // 浏览器接管了手势（系统手势、来电），或拖动中行被重建换掉：不提交半截的顺序
  function onAbort() {
    stop();
    panel.classList.remove('folder-dragging');
    onCancel();
  }

  handle.addEventListener('pointerdown', ev => {
    touchGesture = ev.pointerType === 'touch';
    if (ev.button !== undefined && ev.button !== 0) return;
    if (ev.isPrimary === false || dragging) return;
    cancelHold();
    startX = ev.clientX;
    startY = ev.clientY;
    timer = setTimer(start, holdMs);
  });
  handle.addEventListener('pointermove', ev => {
    if (timer === null) return;
    if (Math.abs(ev.clientX - startX) > moveTolerance || Math.abs(ev.clientY - startY) > moveTolerance) cancelHold();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) handle.addEventListener(type, cancelHold);
  // touch 事件一直派给按下时的那个元素，挂在行上就收得到整次触摸；passive:false 才能 preventDefault
  handle.addEventListener('touchmove', ev => {
    if (!dragging) return;
    ev.preventDefault();
    ev.stopPropagation();
  }, { passive: false });
  handle.addEventListener('contextmenu', ev => { if (touchGesture) ev.preventDefault(); });
}

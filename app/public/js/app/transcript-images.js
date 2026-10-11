import { planTranscriptImages, transcriptImageDataUrl, transcriptImageFailureText } from '../logic/transcript-images.js';
import { t } from '../i18n.js';

// 会话里的图片（工具截图、用户贴图）：事件 / 历史条目只带引用，这里画缩略图格子并经 image:get 按需取。
//
// 【懒加载】格子进入可视区才取（IntersectionObserver）：工具卡默认收起，<details> 收着时内容不渲染、
// 观察不到相交，于是「打开会话」不会一次拉几十张截图，展开哪张卡才取哪张。没有 IO 的环境立即取。
// 【并发】最多 2 张同时在途：一张截图就是一条几百 KB 的 ack，并发多了会挤住弱网下的实时事件流。
// 【失败】取不到、超时、载荷不合规一律显示「图片无法加载」，点一下重试；绝不抛到外面打断整条消息的渲染。
// 【缓存】按「会话 + 引用」缓存 data URL，重绘（切回会话、history_append 重推）不重复取。
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 2;
const CACHE_MAX = 30;

const TILE_CLASS = 'transcript-image shrink-0 rounded-lg overflow-hidden';
const PLACEHOLDER_CLASS = 'min-w-[6rem] h-16 px-2 bg-sunk text-ink-faint text-xs flex items-center justify-center';

export function createTranscriptImages(context, { createElement, openPreviewUrl = () => {} } = {}) {
  const deps = context.dependencies || {};
  const cache = new Map(); // `${sessionId}\0${ref}` → data URL（Map 插入序当 LRU）
  const queue = [];
  let active = 0;
  const loaders = new WeakMap(); // 格子节点 → 进入可视区时要做的事
  let observer;

  function getObserver() {
    if (observer !== undefined) return observer;
    const IO = deps.window?.IntersectionObserver || globalThis.IntersectionObserver;
    observer = typeof IO === 'function'
      ? new IO(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          const run = loaders.get(entry.target);
          loaders.delete(entry.target);
          run?.();
        }
      })
      : null;
    return observer;
  }

  function whenVisible(node, run) {
    const io = getObserver();
    if (!io) { run(); return; }
    loaders.set(node, run);
    io.observe(node);
  }

  function request(scope, ref) {
    return new Promise(resolve => {
      const socket = context.socket;
      if (!socket) { resolve({ ok: false, code: 'offline' }); return; }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; resolve({ ok: false, code: 'timeout' }); }
      }, FETCH_TIMEOUT_MS);
      socket.emit('image:get', { instanceId: scope.instanceId || null, cwd: scope.cwd || null, sessionId: scope.sessionId || null, ref }, res => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      request(job.scope, job.ref)
        .catch(() => ({ ok: false, code: 'error' }))
        .then(res => {
          active--;
          try { job.done(res); } catch { /* 渲染失败不得卡住队列 */ }
          pump();
        });
    }
  }

  function remember(key, url) {
    cache.delete(key);
    cache.set(key, url);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function showLoaded(node, url) {
    node.dataset.state = 'loaded';
    node.className = `${TILE_CLASS} cursor-pointer active:opacity-80`;
    node.textContent = '';
    const img = createElement('<img class="block max-w-[8rem] max-h-32 object-contain">');
    img.alt = t('图片');
    // data URL 能拼出来不等于浏览器解得开（数据损坏、类型标错）：解不开同样落「无法加载」
    img.onerror = () => showFailed(node, 'decode_failed');
    img.src = url;
    node.appendChild(img);
    node.onclick = () => openPreviewUrl(t('图片'), url);
  }

  function showFailed(node, code, bytes, retry) {
    node.dataset.state = code === 'too_large' ? 'too_large' : 'error';
    node.className = `${TILE_CLASS} ${PLACEHOLDER_CLASS}`;
    node.textContent = transcriptImageFailureText(code, bytes);
    node.onclick = retry || null;
    if (retry) node.title = t('点按重试');
  }

  function load(node, tile, scope) {
    const key = `${scope.sessionId || ''}\u0000${tile.ref}`;
    const hit = cache.get(key);
    if (hit) { remember(key, hit); showLoaded(node, hit); return; }
    node.dataset.state = 'loading';
    queue.push({
      scope,
      ref: tile.ref,
      done: res => {
        const url = transcriptImageDataUrl(res);
        if (url) { remember(key, url); showLoaded(node, url); return; }
        const code = res?.code === 'too_large' ? 'too_large' : 'error';
        showFailed(node, code, res?.bytes ?? tile.bytes, code === 'too_large' ? null : () => load(node, tile, scope));
      },
    });
    pump();
  }

  // images：事件 / 历史条目上的引用列表；scope：{sessionId, cwd, instanceId}——取图要过的会话与范围校验用它。
  // 没有可显示的图返回 null，调用方什么都不挂。
  function render(images, scope = {}) {
    const plan = planTranscriptImages(images);
    if (!plan.length) return null;
    const wrap = createElement('<div class="flex flex-wrap gap-2 mt-1" data-testid="transcript-images"></div>');
    for (const tile of plan) {
      const node = createElement(`<button type="button" class="${TILE_CLASS} ${PLACEHOLDER_CLASS}" data-testid="transcript-image"></button>`);
      node.dataset.ref = tile.ref;
      if (tile.state === 'too_large') {
        showFailed(node, 'too_large', tile.bytes);
      } else {
        node.dataset.state = 'pending';
        node.textContent = t('图片加载中…');
        whenVisible(node, () => load(node, tile, scope));
      }
      wrap.appendChild(node);
    }
    return wrap;
  }

  return { render };
}

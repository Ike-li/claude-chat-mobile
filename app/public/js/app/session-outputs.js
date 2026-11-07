// 工作区 sheet 的「产出」tab：这个会话产出了哪些文件。只管这半边的数据，sheet 开合与 tab 切换归 workspacePanel。
// 每次切进来都重新拉：文件可能刚被删，也可能刚产出。
import { t } from '../i18n.js';
import { outputRowView, outputsOutsideText } from '../logic/session-outputs.js';
import { showPanelMessage } from './panel-message.js';

// 同 file:open：旧后端不认这个事件，ack 永远不来
const OUTPUTS_TIMEOUT_MS = 10_000;

export function createSessionOutputs(context, {
  el,
  haptic = () => {},
  getSessionId,
  openFile,
  now = () => Date.now(),
} = {}) {
  const body = context.dom.outputsBody;
  let loadGen = 0; // 切走再切回时，上一发迟到的回包不能盖掉这一发

  const showMessage = text => showPanelMessage(body, text);

  function rowFor(item) {
    const view = outputRowView(item, now());
    const row = el(`<button type="button" class="w-full flex items-center gap-2 px-4 py-2.5 border-b border-line-soft text-left${view.openable ? ' hover:bg-sunk/30 active:opacity-70' : ''}" data-testid="output-row"></button>`);
    row.disabled = !view.openable;
    const icon = el(`<span class="shrink-0 w-5 text-center${view.openable ? '' : ' opacity-50'}"></span>`);
    icon.textContent = view.icon;
    const text = el('<span class="flex-1 min-w-0"></span>');
    const name = el(`<span class="block truncate text-xs ${view.openable ? 'text-ink' : 'text-ink-faint'}"></span>`);
    name.textContent = view.name;
    const meta = el('<span class="block truncate text-[10px] text-ink-faint"></span>');
    meta.textContent = view.meta;
    text.append(name, meta);
    row.append(icon, text);
    row.onclick = () => {
      haptic('tap');
      openFile(item.path);
    };
    return row;
  }

  function render({ items, outsideCount }) {
    const outsideText = outputsOutsideText(outsideCount);
    if (!items.length && !outsideText) {
      showMessage(t('这个会话还没有产出文件。助手新建的文件和贴出链接的文件会列在这里。'));
      return;
    }
    body.replaceChildren(...items.map(rowFor));
    if (outsideText) {
      const outside = el('<div class="px-4 py-3 text-[11px] text-ink-faint" data-testid="outputs-outside"></div>');
      outside.textContent = outsideText;
      body.appendChild(outside);
    }
  }

  function open(cwd) {
    const gen = ++loadGen;
    const sessionId = getSessionId();
    if (!sessionId) {
      showMessage(t('发出第一条消息后，这里才会列出产出的文件。'));
      return;
    }
    showMessage(t('加载中…'));
    context.socket.timeout(OUTPUTS_TIMEOUT_MS).emit('session:outputs', { cwd, sessionId }, (err, response) => {
      if (gen !== loadGen) return;
      if (err) showMessage(t('拿不到列表：后端可能还没重启'));
      else if (response?.ok) render(response);
      else showMessage(response?.error || t('拿不到列表'));
    });
  }

  return { open };
}

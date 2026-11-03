import { t } from '../i18n.js';
import { describeResumeDivergence } from '../logic/resume-divergence.js';

// 续接会丢掉一段对话（SESSION-04）的面板。发送被服务端以 resume_divergent 拒收、话已回到输入框之后弹出：
//   「分叉到新会话」—— session:fork 从最新那条复制出新会话（服务端随即切过去），把输入框里的话挪进新会话的输入框；
//   「仍然发送」——   带上 ackDivergence（确认的是哪一段：最新那条的 uuid）重发，服务端放行并清掉结论；
//   取消 ——         什么都不做，话留在输入框里。
// 分叉后不替用户发出去：会话换了，先让人看一眼自己在哪儿再按发送。
// 成因与判据见 server 的 sessions/resume-anchor.js；面板文案在 logic/resume-divergence.js。
const FORK_ACK_MS = 20000; // 同 rewind-command 的 emitAsync：forkSession + resume 新会话，慢路径远超发送 ack

export function createResumeDivergencePrompt({
  socket,
  appConfirm = async () => false,
  addBar = () => {},
  // 面板开着时 instances 广播可能把视图换掉（同 requestSessionFork 的快照比对）：换了就不动，话在原会话的草稿里
  getCurrentSession = () => ({ sessionId: null }),
  resend = () => {},     // (opts) => 走 send() 重发输入框里的话
  takeDraft = () => null, // 取走输入框里的话并清掉本表面的草稿槽 → {text, attachments} | null
  putDraft = () => {},   // (sessionId, draft) 把话放进那个会话的输入框（正看着它）或它的草稿槽
} = {}) {
  async function prompt({ divergence, sessionId, cwd }) {
    const view = describeResumeDivergence(divergence);
    if (!view || !sessionId) return;
    // 已有确认框开着时 appConfirm 直接兑现 false：当取消处理，话在输入框里，不会丢
    const choice = await appConfirm({ title: view.title, body: view.body, okText: view.okText, altText: view.altText, tone: 'warning' });
    if (!choice) return;
    if (getCurrentSession().sessionId !== sessionId) {
      addBar(t('会话已切换，没有发送；那条消息在原会话的输入框里'), 'text-info');
      return;
    }
    if (choice === 'alt') {
      resend({ ackDivergence: divergence.newestUuid });
      return;
    }
    const draft = takeDraft();
    // 锚点语义同长按 assistant「从这里分叉」：保留最新那条所在的一轮，服务端按父链算出真正的 upToMessageId。
    // 带超时：话已从输入框取走，ack 丢了也得还回去
    socket.timeout(FORK_ACK_MS).emit('session:fork', { cwd, sessionId, uuid: divergence.newestUuid, keepAnchorTurn: true }, (err, res) => {
      if (err || !res?.ok || !res.sessionId) {
        if (draft) putDraft(sessionId, draft);
        addBar((!err && res?.error) || t('分叉失败'), 'text-danger');
        return;
      }
      if (draft) putDraft(res.sessionId, draft);
      addBar(t('已分叉到新会话，那条消息在输入框里，确认后发送'), 'text-info');
    });
  }
  return { prompt };
}

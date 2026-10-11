// app/compose-page.js —— 「这一个新会话页」的标识（2026-10-10 第四轮 review P2）
//
// 离线时在新会话页上打的消息都以 instanceId:null 入队。重放时同一页连打的几条要并成一个会话（第一条开出来的
// 实例，见 logic/outbox-send.js 的 planOutbox*Reuse），用户有意新开的另一页却要各开各的——两页的条目在
// instanceId / cwd 上一模一样，只能靠入队时记下「是哪一页」来分。每次显式新开会话页（＋、选文件夹）换一个。
// 标识沿用 clientMessageId 的生成法：只在本机比较相等，不要求不可猜；crypto.randomUUID 在非安全上下文
// （局域网 http）里不存在。
const defaultNewId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function createComposePage({ newId = defaultNewId } = {}) {
  let id = newId();
  return {
    id: () => id,
    renew() { id = newId(); },
  };
}

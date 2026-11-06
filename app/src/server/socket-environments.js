// socket-environments.js —— 保存的环境的 socket 面。判据在 sessions/saved-environments.js，这里只管设备闸与范围。
//
// 环境本身不扩大授权：开会话时 session:new 照常过 routeCwd。这里挡范围外的 cwd，是不让它出现在选择列表里。
import { normalizeEffortUiLevel } from '../agent/cli-settings-defaults.js';

export function registerEnvironmentSocketHandlers({ socket, on, store, isFolderAvailable, audit, actorFromSocket }) {
  on(socket, 'environments:list', (_payload, ack) => {
    if (typeof ack !== 'function') return;
    ack({ ok: true, environments: store.list().map(e => ({ ...e, available: isFolderAvailable(e.cwd) })) });
  });

  // on() 只拦 deviceApproved === false，这里收紧成「必须是 true」：环境是所有设备共享的（同 folders:reorder）。
  on(socket, 'environments:save', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.deviceApproved !== true) return ack({ ok: false, error: 'device_not_approved' });
    if (!normalizeEffortUiLevel(payload?.effort ?? null)) return ack({ ok: false, error: 'invalid_effort' });
    const id = payload?.id;
    // 文件夹断开后还能改名：cwd 没变就没有新的范围要判
    const cwdUnchanged = Boolean(id) && store.list().find(e => e.id === id)?.cwd === payload.cwd;
    if (!cwdUnchanged && !isFolderAvailable(payload?.cwd)) {
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'scope_violation', target: String(payload?.cwd), outcome: 'denied', meta: { via: 'environments:save' } });
      return ack({ ok: false, error: 'out_of_range' });
    }
    ack(id ? store.update(id, payload) : store.create(payload));
  });

  on(socket, 'environments:delete', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.deviceApproved !== true) return ack({ ok: false, error: 'device_not_approved' });
    ack(store.remove(payload?.id));
  });
}

// socket-folders.js —— 手机上「添加文件夹」「新建文件夹」的 socket 面（FOLDER-01）
//
// 判据全在 sessions/folders.js；写配置与热加载由组装根注入的 addConnectedFolder 负责。这里只做三件事：
// 取参、调用、留痕——越界尝试记 scope_violation（同文件浏览），扩授权面与在磁盘上建东西的成功操作各记一条。
import { browseFolderNames, createSubfolder, resolveFolderToAdd } from '../sessions/folders.js';

const OUT_OF_RANGE = new Set(['out_of_range', 'outside_home']);

export function registerFolderSocketHandlers({ socket, on, folderContext, addConnectedFolder, audit, actorFromSocket }) {
  const record = (action, target, outcome, meta) => audit.recordAudit({ actor: actorFromSocket(socket), action, target, outcome, meta });
  const recordIfOutOfRange = (res, target, via) => {
    if (!res.ok && OUT_OF_RANGE.has(res.error)) record('scope_violation', String(target), 'denied', { via });
  };

  on(socket, 'folders:browse', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const res = browseFolderNames(payload?.path ?? '', folderContext());
    recordIfOutOfRange(res, payload?.path, 'folders:browse');
    ack(res);
  });

  on(socket, 'folders:mkdir', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const res = createSubfolder(payload?.path ?? '', payload?.name, folderContext());
    recordIfOutOfRange(res, payload?.path, 'folders:mkdir');
    if (res.ok) record('folder_created', res.path, 'allowed');
    ack(res);
  });

  on(socket, 'folders:add', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const target = resolveFolderToAdd(payload?.path, folderContext());
    recordIfOutOfRange(target, payload?.path, 'folders:add');
    if (!target.ok) return ack(target);
    const res = addConnectedFolder(target.path);
    if (res.ok) record('folder_connected', target.path, 'allowed');
    ack(res);
  });
}

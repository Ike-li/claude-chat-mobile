import { realpathSync } from 'node:fs';
import { basename } from 'node:path';

export function registerFileSocketHandlers({
  socket,
  on,
  routeCwd,
  getWorkDirs,
  listDir,
  browseReadFile,
  audit,
  actorFromSocket,
  routeInstance,
  attributePath,
  rejectableSymlinkComponent,
  buildDiff,
  readPreview,
  logger = console,
}) {
  on(socket, 'browse:list', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const { cwd: requestedCwd, relPath, offset, maxEntries } = payload || {};
    const cwd = routeCwd(requestedCwd);
    const result = listDir(cwd, relPath, getWorkDirs(), { offset, maxEntries });
    if (result === null) {
      logger.warn(`[scope] 文件浏览越界拒绝（list）：cwd=${cwd} relPath=${JSON.stringify(relPath)}`);
      audit.recordAudit({
        actor: actorFromSocket(socket),
        action: 'scope_violation',
        target: cwd,
        outcome: 'denied',
        meta: { via: 'browse:list', relPath: typeof relPath === 'string' ? relPath : null },
      });
      return ack({ ok: false, error: '路径不在授权范围内，或不是目录' });
    }
    return ack({ ok: true, ...result });
  });

  on(socket, 'browse:read', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const { cwd: requestedCwd, relPath, offset, maxBytes, encoding } = payload || {};
    const cwd = routeCwd(requestedCwd);
    // encoding:'base64' → 附件/二进制按片 base64 回传（E18 附件预览）；其余值走默认文本模式
    const result = browseReadFile(cwd, relPath, getWorkDirs(), { offset, maxBytes, encoding });
    if (result === null) {
      logger.warn(`[scope] 文件浏览越界拒绝（read）：cwd=${cwd} relPath=${JSON.stringify(relPath)}`);
      audit.recordAudit({
        actor: actorFromSocket(socket),
        action: 'scope_violation',
        target: cwd,
        outcome: 'denied',
        meta: { via: 'browse:read', relPath: typeof relPath === 'string' ? relPath : null },
      });
      return ack({ ok: false, error: '路径不在授权范围内，或不是文件' });
    }
    return ack({ ok: true, ...result });
  });

  on(socket, 'tool:full', ({ instanceId, toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const agent = routeInstance(instanceId);
    if (!agent) return ack({ ok: false, error: '实例不存在' });
    if (typeof toolUseId !== 'string' || !toolUseId) return ack({ ok: false, error: '缺少 toolUseId' });
    const text = agent.getToolOutput(toolUseId);
    if (text == null) return ack({ ok: false, error: '全文不可用（已过期或未缓存）' });
    return ack({ ok: true, text });
  });

  on(socket, 'tool:preview', async ({ instanceId, toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const agent = routeInstance(instanceId);
    if (!agent) return ack({ ok: false, error: '实例不存在' });
    const toolInput = agent.getToolInput(toolUseId);
    if (!toolInput) return ack({ ok: false, error: '预览不可用（已过期或非文件工具）' });

    const filePath = toolInput.input?.file_path ?? toolInput.input?.notebook_path ?? null;
    const workDirs = getWorkDirs();
    const attribution = attributePath(filePath, workDirs, agent.cwd);
    if (!attribution) return ack({ ok: false, inWhitelist: false, error: '路径不在白名单工作目录内，预览已拒绝' });
    if (rejectableSymlinkComponent(attribution.resolved)) {
      return ack({ ok: false, inWhitelist: false, error: '路径含可疑符号链接，预览已拒绝' });
    }

    let realPath = attribution.resolved;
    try { realPath = realpathSync(attribution.resolved); } catch { /* deleted files are handled by readPreview */ }
    if (realPath !== attribution.resolved && !attributePath(realPath, workDirs, agent.cwd)) {
      return ack({ ok: false, inWhitelist: false, error: '路径解析后越出白名单，预览已拒绝' });
    }

    const diff = buildDiff(toolInput.name, toolInput.input);
    let snippet;
    if (toolInput.name === 'Read') {
      try { snippet = readPreview(realPath); }
      catch (error) { return ack({ ok: false, error: `读取失败：${error.message}` }); }
    }
    return ack({
      ok: true,
      name: toolInput.name,
      inWhitelist: true,
      attribution: { workdirLabel: basename(attribution.workDir), relPath: attribution.relPath },
      diff: diff || undefined,
      snippet,
    });
  });
}

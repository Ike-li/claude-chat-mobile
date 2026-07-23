import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { assertSafeRelPath } from '../files/git-workspace.js';

export function registerFileSocketHandlers({
  socket,
  on,
  routeCwd,
  getWorkDirs,
  listDir,
  browseReadFile,
  listGitChanges,
  readGitDiff,
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

  // cwd 是否落在白名单：attributePath 对绝对 cwd 做前缀判定（零 IO）；routeCwd 通常已归位，双闸防缺省。
  function cwdInWorkDirs(cwd, workDirs) {
    if (!cwd || !Array.isArray(workDirs)) return false;
    if (workDirs.includes(cwd)) return true;
    return Boolean(attributePath(cwd, workDirs, cwd));
  }

  // 工作区 git 变更列表（只读；与 statusline 三分计数分工）
  on(socket, 'git:status', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (typeof listGitChanges !== 'function') {
      return ack({ ok: false, code: 'unavailable', error: 'git 变更列表不可用' });
    }
    const { cwd: requestedCwd } = payload || {};
    const cwd = routeCwd(requestedCwd);
    const workDirs = getWorkDirs();
    if (!cwdInWorkDirs(cwd, workDirs)) {
      logger.warn(`[scope] git status 越界拒绝：cwd=${cwd}`);
      audit.recordAudit({
        actor: actorFromSocket(socket),
        action: 'scope_violation',
        target: cwd,
        outcome: 'denied',
        meta: { via: 'git:status' },
      });
      return ack({ ok: false, code: 'scope', error: '路径不在授权范围内' });
    }
    const result = await listGitChanges(cwd);
    if (!result?.ok) {
      return ack({
        ok: false,
        code: result?.code || 'git_error',
        error: result?.error || 'git status 失败',
      });
    }
    return ack({
      ok: true,
      branch: result.branch,
      staged: result.staged,
      unstaged: result.unstaged,
      untracked: result.untracked,
      truncated: result.truncated || false,
    });
  });

  // 单文件 unified patch（staged=diff --cached；unstaged=diff；untracked 走 browse:read）
  on(socket, 'git:diff', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (typeof readGitDiff !== 'function') {
      return ack({ ok: false, code: 'unavailable', error: 'git diff 不可用' });
    }
    const { cwd: requestedCwd, path: relPath, side } = payload || {};
    const cwd = routeCwd(requestedCwd);
    const workDirs = getWorkDirs();
    if (!cwdInWorkDirs(cwd, workDirs)) {
      logger.warn(`[scope] git diff 越界拒绝：cwd=${cwd}`);
      audit.recordAudit({
        actor: actorFromSocket(socket),
        action: 'scope_violation',
        target: cwd,
        outcome: 'denied',
        meta: { via: 'git:diff', relPath: typeof relPath === 'string' ? relPath : null },
      });
      return ack({ ok: false, code: 'scope', error: '路径不在授权范围内' });
    }
    if (!assertSafeRelPath(cwd, relPath)) {
      logger.warn(`[scope] git diff 路径拒绝：cwd=${cwd} path=${JSON.stringify(relPath)}`);
      audit.recordAudit({
        actor: actorFromSocket(socket),
        action: 'scope_violation',
        target: cwd,
        outcome: 'denied',
        meta: { via: 'git:diff', relPath: typeof relPath === 'string' ? relPath : null },
      });
      return ack({ ok: false, code: 'bad_path', error: '路径不合法或不在工作目录内' });
    }
    const result = await readGitDiff(cwd, relPath, side);
    if (!result?.ok) {
      return ack({
        ok: false,
        code: result?.code || 'git_error',
        error: result?.error || 'git diff 失败',
      });
    }
    return ack({
      ok: true,
      path: result.path,
      side: result.side,
      patch: result.patch,
      binary: result.binary || false,
      truncated: result.truncated || false,
      empty: result.empty || false,
    });
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

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
  searchFiles,
  writeFileInScope,
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
    const result = listDir(cwd, relPath, scopeDirsFor(cwd, getWorkDirs()), { offset, maxEntries });
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
    const result = browseReadFile(cwd, relPath, scopeDirsFor(cwd, getWorkDirs()), { offset, maxBytes, encoding });
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

  // cwd 是否授权：仅 workdirs 白名单本身（git worktree 路径须显式列入）。
  // attributePath 覆盖「cwd 是白名单子路径」的边角（例如临时落到子目录）。
  function cwdInWorkDirs(cwd, workDirs) {
    if (!cwd || !Array.isArray(workDirs)) return false;
    if (workDirs.includes(cwd)) return true;
    return Boolean(attributePath(cwd, workDirs, cwd));
  }

  // browse/write 的 scopeDirs：白名单即可（显式 workdir 已在列表内）。
  // 【为什么不收紧到单个 cwd】n=1 自托管、用户即 root：跨 workdir 的 relPath 读到的仍是用户自己的
  // 文件（直接切到那个工作区就能读），不构成越权。宽 scope 是有意的，收紧反而会挡掉「在 A 项目里
  // 让 claude 参考 B 项目代码」这类正常用法。真正的问题在审计归属，见 auditTargetFor（R10）。
  function scopeDirsFor(_cwd, workDirs) {
    return workDirs;
  }

  // R10（2026-08-06）：审计的 target 必须是【真实落点所属的 workdir】，不能是请求声明的 cwd。
  // 宽 scope 下 relPath 可以跨到别的 workdir，旧实现一律记声明 cwd——事后查「谁动过 B 项目的文件」
  // 会显示 A，审计指错项目。归属解析复用 attributePath（同 tool:preview 的判据）。
  // 解析不出（相对路径拼不成、或落在白名单外——那种情况调用方本就已 fail-closed）时回落声明 cwd。
  // 同区时不加 declaredCwd，避免给绝大多数记录塞冗余字段。
  function auditTargetFor(cwd, relPath) {
    if (typeof relPath !== 'string' || !relPath) return { target: cwd, extra: null };
    const attribution = attributePath(relPath, getWorkDirs(), cwd);
    if (!attribution || attribution.workDir === cwd) return { target: cwd, extra: null };
    return { target: attribution.workDir, extra: { declaredCwd: cwd } };
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
      conflicted: result.conflicted || [],
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

  // @ 文件引用候选：query 只做匹配、不拼路径（见 file-search.js 头注），故无需 assertSafeRelPath 复核——
  // 唯一的越界面是 cwd 本身，与 git:status 同一道闸。
  on(socket, 'files:search', async (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (typeof searchFiles !== 'function') {
      return ack({ ok: false, code: 'unavailable', error: '文件搜索不可用' });
    }
    const { cwd: requestedCwd, query, limit } = payload || {};
    const cwd = routeCwd(requestedCwd);
    const workDirs = getWorkDirs();
    if (!cwdInWorkDirs(cwd, workDirs)) {
      logger.warn(`[scope] files:search 越界拒绝：cwd=${cwd}`);
      audit.recordAudit({
        actor: actorFromSocket(socket),
        action: 'scope_violation',
        target: cwd,
        outcome: 'denied',
        meta: { via: 'files:search' },
      });
      return ack({ ok: false, code: 'scope', error: '路径不在授权范围内' });
    }
    const paths = await searchFiles(cwd, query, { limit });
    return ack({ ok: true, paths });
  });

  // 编辑器保存：V1 只改已存在文件（见 file-browse.js writeFileInScope 头注——不带 O_CREAT）。
  // writeFileInScope 自带范围门 + baseHash 冲突检测，这里只判「有没有开这个能力」（FILE_EDIT=off 时
  // app.js 不传 writeFileInScope，走 unavailable）+ 记审计（scope 违规复用标准 action，其余结果落
  // file_write——用户本人显式操作，不经 approval-store，审计是唯一事后可追溯的记录）。
  on(socket, 'files:write', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (typeof writeFileInScope !== 'function') {
      return ack({ ok: false, code: 'unavailable', error: '文件编辑未启用' });
    }
    const { cwd: requestedCwd, relPath, content, baseHash } = payload || {};
    const cwd = routeCwd(requestedCwd);
    const meta = { relPath: typeof relPath === 'string' ? relPath : null };
    const result = writeFileInScope(cwd, relPath, content, scopeDirsFor(cwd, getWorkDirs()), { baseHash });
    if (!result.ok && result.code === 'scope') {
      logger.warn(`[scope] 文件写回越界拒绝：cwd=${cwd} relPath=${JSON.stringify(relPath)}`);
      audit.recordAudit({ actor: actorFromSocket(socket), action: 'scope_violation', target: cwd, outcome: 'denied', meta: { via: 'files:write', ...meta } });
      return ack(result);
    }
    // R10：成功写入的 target 记真实落点所属 workdir（宽 scope 允许跨区 relPath）。
    const { target, extra } = auditTargetFor(cwd, relPath);
    const baseMeta = result.ok ? meta : { ...meta, code: result.code };
    audit.recordAudit({
      actor: actorFromSocket(socket),
      action: 'file_write',
      target,
      outcome: result.ok ? 'success' : 'denied',
      meta: extra ? { ...baseMeta, ...extra } : baseMeta,
    });
    return ack(result);
  });

  on(socket, 'tool:full', ({ instanceId, toolUseId } = {}, ack) => {
    if (typeof ack !== 'function') return;
    const agent = routeInstance(instanceId);
    if (!agent) return ack({ ok: false, error: '实例不存在' });
    if (typeof toolUseId !== 'string' || !toolUseId) return ack({ ok: false, error: '缺少 toolUseId' });
    const text = agent.getToolOutput(toolUseId);
    if (text == null) return ack({ ok: false, error: '全文不可用（已过期或未缓存）' });
    // getToolOutput 返回时已红线（base64 载荷被替换为占位符），纯文本工具输出不受影响。
    // 上限：live 卡片走 600/2000 截断，只有这条「展开全文」是裸全文。
    // 客户端拿到后要同步做 JSON pretty + hljs 高亮（都无长度闸），几 MB 的 Write 内容足以打爆手机标签页。
    // 与 file-preview 的 64KB 读片上限同量级，超出部分截断并明确告知，不静默丢。
    const MAX_TOOL_FULL_BYTES = 512 * 1024;
    if (text.length > MAX_TOOL_FULL_BYTES) {
      return ack({ ok: true, text: text.slice(0, MAX_TOOL_FULL_BYTES), truncated: true, totalLength: text.length });
    }
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

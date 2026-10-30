// 记录位置独立于 SDK 的进程 cwd；恢复读盘绝不改变活 SDK 的审批/工具路径。
import { resolveSessionLocation, transcriptCwdOf } from '../sessions/session-location.js';
import { readTranscriptTailEntries, sessionFileExists } from '../sessions/history.js';
import { readCliObservedState } from '../agent/cli-mirror-state.js';

export function createSessionRecovery({ agents, authorize, workspaceOf, onChange = () => {}, readSnapshot = () => null, baseDir }) {
  const diskOpts = baseDir ? { baseDir } : {};
  const inFlight = new WeakMap();
  function resolve(cwd, id, instance = null) {
    const extraRoots = instance?.authorizedRoot ? [instance.authorizedRoot] : [];
    const auth = c => authorize(c, extraRoots) || (c === instance?.cwd ? { path: c, projectKey: workspaceOf(c) } : null);
    // 显式请求别的项目时，不能借有效 instanceId 把兜底搜索转到实例自己的项目。
    const originalProject = instance?.projectCwd;
    const sameProject = cwd === instance?.cwd || cwd === instance?.transcriptCwd || auth(cwd)?.projectKey === originalProject;
    const projectCwd = (sameProject && originalProject) || workspaceOf(cwd, extraRoots);
    return resolveSessionLocation({ cwd, id, projectCwd, authorize: auth, ...diskOpts });
  }
  async function observed(id, cwd) {
    const entries = await readTranscriptTailEntries(id, cwd, diskOpts);
    const last = entries?.findLast(e => e && !e.isMeta && !e.isSidechain && !e.parent_tool_use_id && ['user', 'assistant'].includes(e.type));
    if (!last?.entrypoint || last.entrypoint === 'sdk-ts') return null;
    const state = await readCliObservedState(id, cwd, diskOpts);
    const snapshot = readSnapshot(id, cwd);
    return { ...state, model: snapshot?.state === 'fresh' ? snapshot.snapshot?.model?.id ?? state.model : state.model,
      effort: snapshot?.state === 'fresh' ? snapshot.snapshot?.effort ?? null : null };
  }
  async function recoverOnce(instance, requestedCwd, { observe = false } = {}) {
    const { sessionId, cwd, transcriptCwd } = instance;
    const result = await resolve(requestedCwd, sessionId, instance);
    const external = result.status === 'found' && (observe || result.cwd !== transcriptCwdOf(instance)) ? await observed(sessionId, result.cwd) : null;
    const stillExists = result.status === 'found' && await sessionFileExists(result.cwd, sessionId, diskOpts);
    if (agents.get(instance.instanceId) !== instance || instance.sessionId !== sessionId || instance.cwd !== cwd || instance.transcriptCwd !== transcriptCwd) return { status: 'stale' };
    if (result.status !== 'found') return result;
    if (!stillExists) return { status: 'stale' };
    // 授权可能在上面的 await 中热移除；不能提交失效的观察结果。
    const accepted = authorize(result.cwd, instance.authorizedRoot ? [instance.authorizedRoot] : []);
    if (!accepted && result.cwd !== cwd) return { status: 'scope' };
    const changed = result.cwd !== transcriptCwdOf(instance);
    if (result.cwd !== cwd) {
      instance.externalDirty = true; // 必须早于 mirror 以新位置重新定基线
      instance.transcriptCwd = result.cwd;
    } else if (transcriptCwd) {
      instance.externalDirty = true;
      delete instance.transcriptCwd;
    }
    if (accepted?.projectKey) instance.projectCwd = accepted.projectKey;
    if (external || changed) instance.externalObserved = external || { model: null, permissionMode: null, effort: null };
    if (changed) onChange(instance);
    return { ...result, changed };
  }
  function recover(instance, requestedCwd = transcriptCwdOf(instance), options = {}) {
    const key = `${instance.sessionId}\0${instance.cwd}\0${requestedCwd}\0${Boolean(options.observe)}`;
    const pending = inFlight.get(instance);
    if (pending?.key === key) return pending.promise;
    const promise = recoverOnce(instance, requestedCwd, options).finally(() => {
      if (inFlight.get(instance)?.promise === promise) inFlight.delete(instance);
    });
    inFlight.set(instance, { key, promise });
    return promise;
  }
  return { resolve, recover, observed };
}

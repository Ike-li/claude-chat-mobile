// SESSION-03：只定位，不移动文件；明确位置与自动迁移是两种不同的归属强度。
import { join } from 'node:path';
import { CLAUDE_PROJECTS_DIR } from '../shared/claude-home.js';
import { getProjectDir, isSafeSessionId, sessionFileExists, listProjectMemberDirs, transcriptOwnerCwd } from './history.js';

export const transcriptCwdOf = instance => instance?.transcriptCwd || instance?.cwd || null;
export const locationError = result => result.status === 'ambiguous'
  ? '这个会话存在多份记录，请从会话列表明确选择所在目录后重试'
  : result.status === 'scope' ? '会话目录不在已连接的文件夹里'
    : result.status === 'stale' ? '会话位置已变化，请重试' : '会话不存在';

export async function resolveSessionLocation({ cwd, projectCwd, id, authorize, baseDir = CLAUDE_PROJECTS_DIR }) {
  if (!isSafeSessionId(id)) return { status: 'invalid_id' };
  const initial = authorize?.(cwd);
  if (!initial || initial.kind === 'scratch-root') return { status: 'scope' };
  const exact = initial.path;
  if (await sessionFileExists(exact, id, { baseDir })) return { status: 'found', cwd: exact, relocated: exact !== cwd };
  const project = projectCwd || initial.projectKey;
  const projectAuth = authorize(project);
  if (!projectAuth) return { status: 'scope' };
  const members = await listProjectMemberDirs(projectAuth.path, baseDir, { authorize });
  const candidates = new Set();
  for (const candidate of [projectAuth.path, ...members.map(m => m.cwd)]) {
    const auth = authorize(candidate);
    if (!auth || auth.kind === 'scratch-root' || (auth.projectKey !== projectAuth.path && auth.path !== projectAuth.path)) continue;
    const target = auth.path;
    if (!(await sessionFileExists(target, id, { baseDir }))) continue;
    // 不把旧 transcript 的「没读出 cwd 就兼容放行」用于自动认领。
    const owner = await transcriptOwnerCwd(join(baseDir, getProjectDir(target), `${id}.jsonl`), getProjectDir(target));
    if (!owner || owner.normalize('NFC') !== target.normalize('NFC')) continue;
    candidates.add(target);
  }
  if (candidates.size > 1) return { status: 'ambiguous' };
  const target = [...candidates][0];
  return target ? { status: 'found', cwd: target, relocated: target !== cwd } : { status: 'not_found' };
}

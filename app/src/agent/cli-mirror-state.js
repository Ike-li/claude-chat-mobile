// cli-mirror-state.js —— 从 Claude CLI transcript 观察只读镜像的模型/权限态。
// 这里仅描述 CLI 已落盘的观察值；不得把它写回 Web 接管实例的偏好。

import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { CCM_PERMISSION_MODES } from './cli-settings-defaults.js';
// project 目录名编码走 shared 唯一实现：本文件曾自带第三份复制品（无 200 截断 + hash 后缀），
// 与 history/workdirs 分叉后会造成「历史同步正常、镜像观察态静默为空」的不对称失效。
import { encodeProjectDir } from '../shared/project-dir.js';
import { CLAUDE_PROJECTS_DIR } from '../shared/claude-home.js';

// 根路径走 shared 唯一实现（同 encodeProjectDir 的收敛理由，见上）。
const EMPTY_OBSERVED_STATE = Object.freeze({ model: null, permissionMode: null });
const TAIL_READ_BYTES = 512 * 1024;

export function extractCliObservedState(entries) {
  let model = null;
  let permissionMode = null;

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.isSidechain || entry.parent_tool_use_id) continue;
    if (entry.type === 'permission-mode') {
      permissionMode = typeof entry.permissionMode === 'string' && CCM_PERMISSION_MODES.includes(entry.permissionMode)
        ? entry.permissionMode
        : null;
    }
    if (entry.type !== 'assistant') continue;
    const candidate = typeof entry.message?.model === 'string' ? entry.message.model.trim() : '';
    if (candidate && candidate !== '<synthetic>') model = candidate;
  }

  return { model, permissionMode };
}

export async function readCliObservedState(sessionId, cwd, { baseDir = CLAUDE_PROJECTS_DIR, size = null } = {}) {
  if (typeof sessionId !== 'string' || !/^[0-9a-zA-Z_-]+$/.test(sessionId) || typeof cwd !== 'string') {
    return { ...EMPTY_OBSERVED_STATE };
  }
  const file = join(baseDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    const fh = await open(file, 'r');
    try {
      if (size == null) ({ size } = await fh.stat());
      if (!Number.isFinite(size) || size <= 0) return { ...EMPTY_OBSERVED_STATE };
      const end = Math.trunc(size);
      const start = end > TAIL_READ_BYTES ? end - TAIL_READ_BYTES : 0;
      const length = end - start;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, start);
      const entries = [];
      for (const line of buf.toString('utf8', 0, bytesRead).split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* 写入中或截断的半行不算观察值 */ }
      }
      return extractCliObservedState(entries);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return { ...EMPTY_OBSERVED_STATE };
  }
}

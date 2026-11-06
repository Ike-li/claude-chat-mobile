// saved-environments.js —— 保存的环境：新会话页一次带上的一组设置（文件夹、模型、effort、worktree）。
//
// 对照官方桌面端的「Save as environment」。桌面端还能选云端 / SSH，这里只有本机：一个实例只驱动一台机器上的 CLI。
// 不读写桌面端的 ccd-session-presets.json：那是它的内部文件，格式随时会变。
//
// 为什么允许新增落盘（docs/hard-rules.md §1）：claude 侧没有这个概念，也不能从 transcript 重建。
// 它和文件夹顺序不同，是用户亲手存的数据：读坏了不挡启动，但原文件要先备份，否则下一次保存就把它盖掉了。
// 写盘照 folder-order.js：200ms 防抖、退出时同步 flush。ack 的含义是「内存已接受」，不保证已落盘。
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { createSerialWriter, writeFileAtomic } from '../shared/serial-writer.js';
import { dataFile } from '../shared/data-dir.js';

const NAME_MAX = 60;

export function createSavedEnvironmentsStore({ file = dataFile('environments.json'), log = console, debounceMs = 200 } = {}) {
  let environments = load(file, log);
  let changed = false; // 从没改过就不在退出时写：没用这个功能的安装不凭空多一个文件

  const writer = createSerialWriter(async (shouldCommit) => {
    await writeFileAtomic(file, JSON.stringify(environments), shouldCommit);
  }, { onError: e => log.error(`[saved-environments] 保存失败（本次运行照常生效，重启后可能丢失）: ${e?.message || e}`) });

  let saveTimer = null;
  function save() {
    changed = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; writer.request(); }, debounceMs);
  }

  function validate(input, selfId = null) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || [...name].length > NAME_MAX) return { ok: false, error: 'invalid_name' };
    if (typeof input.cwd !== 'string' || !input.cwd) return { ok: false, error: 'invalid_cwd' };
    if (environments.some(e => e.name === name && e.id !== selfId)) return { ok: false, error: 'duplicate_name' };
    return {
      ok: true,
      fields: {
        name,
        cwd: input.cwd,
        model: typeof input.model === 'string' && input.model ? input.model : null,
        effort: typeof input.effort === 'string' && input.effort ? input.effort : null,
        worktree: input.worktree === true,
      },
    };
  }

  function create(input) {
    const checked = validate(input);
    if (!checked.ok) return checked;
    const environment = { id: randomUUID(), ...checked.fields };
    environments = [...environments, environment];
    save();
    return { ok: true, environment };
  }

  function update(id, input) {
    if (!environments.some(e => e.id === id)) return { ok: false, error: 'not_found' };
    const checked = validate(input, id);
    if (!checked.ok) return checked;
    const environment = { id, ...checked.fields };
    environments = environments.map(e => (e.id === id ? environment : e));
    save();
    return { ok: true, environment };
  }

  function remove(id) {
    if (!environments.some(e => e.id === id)) return { ok: false, error: 'not_found' };
    environments = environments.filter(e => e.id !== id);
    save();
    return { ok: true };
  }

  function flushSaveSync() {
    clearTimeout(saveTimer);
    saveTimer = null;
    writer.fence();
    if (!changed) return;
    // 不往外抛：调用方是 shutdown()，后面还有 io.close 和兜底退出。uncaughtException 只记日志，抛出去进程就挂着不退了
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeOwnerOnlyFile(file, JSON.stringify(environments));
    } catch (e) {
      log.error(`[saved-environments] 退出时保存失败（这次的改动会丢失）: ${e?.message || e}`);
    }
  }

  return { list: () => environments.map(e => ({ ...e })), create, update, remove, flushSaveSync };
}

function isStoredEnvironment(e) {
  return typeof e?.id === 'string' && e.id
    && typeof e.name === 'string' && e.name
    && typeof e.cwd === 'string' && e.cwd
    && (e.model === null || typeof e.model === 'string')
    && (e.effort === null || typeof e.effort === 'string')
    && typeof e.worktree === 'boolean';
}

function load(file, log) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return []; // 没有文件是新装的常态
  }
  let valid = [];
  let intact = false;
  try {
    const raw = JSON.parse(text);
    if (Array.isArray(raw)) {
      valid = raw.filter(isStoredEnvironment);
      intact = valid.length === raw.length;
    }
  } catch { /* 按损坏处理 */ }
  if (intact) return valid;
  // 只留最新一份：文件是原子写的，损坏基本只来自手改，同名备份也才在卸载清单里
  const kept = `${file}.corrupt`;
  log.warn(`[saved-environments] ${file} 有读不懂的内容，已备份到 ${kept}，能读的 ${valid.length} 条照常用`);
  try { copyFileSync(file, kept); } catch { /* 备份失败也不挡启动 */ }
  return valid;
}

// 默认实例：server 全局共用一份（同 folder-order.js；n=1 单用户，环境是所有设备共享的）
export const savedEnvironments = createSavedEnvironmentsStore();

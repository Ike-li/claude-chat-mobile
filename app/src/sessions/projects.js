// projects.js —— 抽屉的「项目」清单（2026-09-24「已连接的文件夹」）
//
// 官方桌面端的侧栏按项目分组。这里的项目 = 已连接的文件夹（按配置顺序）+ 其下有会话的子文件夹
// + 无文件夹（scratch 根）。worktree 不自成项目，跟随所属仓库（由授权判据的 projectKey 决定）。
//
// 子项目只能从 ~/.claude/projects 反查：目录名是有损编码，读 transcript 记下的 cwd（projectCwdsOf），
// 再问授权判据它归哪个项目——已删的目录、禁区、连接范围外的，判据都答 null，于是自然不列。
// 这份清单只管展示分组，不授予任何访问：打开会话时每个 cwd 仍要单独过授权判据。
import { readdir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { projectCwdsOf } from './history.js';
import { SCRATCH_DIR_RE } from './folder-access.js';
import { projectDirDescendantPrefix } from '../shared/project-dir.js';

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// 扫出已连接文件夹之下、自己不是连接根的项目 → [{ key, root }]。
// 一个 project 目录可能落着几个 cwd（编码撞名），各自成项目；逐份 transcript 的归属由 history.js 按文件缓存。
export async function discoverSubProjects({ connected = [], baseDir, authorize }) {
  let names;
  try {
    names = (await readdir(baseDir, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name);
  } catch { return []; }
  // 前缀只是候选筛选（`/code/app-x` 编码后也以 `-code-app-` 开头；根的编码被截断时更宽），归属由下面的授权判据答
  const prefixes = connected.map(projectDirDescendantPrefix);
  const candidates = new Set(names.filter(n => prefixes.some(p => n.startsWith(p))));
  // 会话删光之后 project 目录还在（SDK 只删 jsonl）：没有 transcript 就没有归属，自然不算项目
  const cwds = (await Promise.all([...candidates].map(name => projectCwdsOf(join(baseDir, name))))).flat();

  const known = new Set(connected);
  const found = new Map();
  for (const cwd of cwds) {
    const auth = authorize(cwd);
    if (auth?.kind !== 'connected') continue;
    const key = auth.projectKey;
    if (known.has(key) || found.has(key)) continue;
    // worktree 的项目键是仓库：仓库本身落在哪个连接根里，要对仓库再判一次
    const owner = key === auth.path ? auth : authorize(key);
    if (owner?.kind === 'connected') found.set(key, { key, root: owner.root });
  }
  return [...found.values()].sort(byKey);
}

// 「无文件夹」项目有没有会话：transcript 记的 cwd 落在 scratch 根下某个 mkdtemp 形态目录里（或它下面）。
// 只决定抽屉里这一节显不显示（官方侧栏也只列有会话的项目），不认领任何会话。
// 目录名只用来挑候选，不按名字判形态：根的路径长到编码被截断时，scratch 目录的目录名截到 200 再接 hash，里面
// 不再有完整的 scratch 那一段，这一节就永远不显示（2026-10-10 第五轮 review 同类）；候选里还会混进根自己、
// 根下别的目录与前 200 个字符相同的邻居，所以看 cwd 的第一段是不是 scratch 形态。cwd 落在更深处也算：会话中途
// 进了 scratch 目录下面的子目录（如托管 worktree）时，CLI 把 transcript 整份搬进那个子目录的 project 目录，
// 只认 scratch 目录本身的话重启后这一节就没了（2026-10-10 review P2）。
export async function hasScratchSessions({ baseDir, scratchRoot }) {
  const prefix = projectDirDescendantPrefix(scratchRoot);
  const root = scratchRoot.normalize('NFC'); // 与编码同口径：编码前先 NFC 归一
  const inScratchDir = c => SCRATCH_DIR_RE.test(relative(root, c.normalize('NFC')).split(sep)[0]);
  let names;
  try {
    names = (await readdir(baseDir, { withFileTypes: true }))
      .filter(e => e.isDirectory() && e.name.startsWith(prefix))
      .map(e => e.name);
  } catch { return false; }
  for (const name of names) {
    if ((await projectCwdsOf(join(baseDir, name))).some(inScratchDir)) return true;
  }
  return false;
}

// 组出下发给前端的清单。连接根在这里现算（加 / 删文件夹后立刻准确，不等下一次扫盘）；
// subProjects 是扫盘结果与活实例的项目键之并，所属根已被移出清单的丢掉。
export function composeProjects({ connected = [], subProjects = [], scratchRoot = null }) {
  const out = [];
  const seen = new Set();
  for (const root of connected) {
    if (seen.has(root)) continue;
    seen.add(root);
    out.push({ key: root, root, label: basename(root), kind: 'connected' });
    for (const s of subProjects.filter(x => x.root === root).sort(byKey)) {
      if (seen.has(s.key)) continue;
      seen.add(s.key);
      out.push({ key: s.key, root, label: `${basename(root)} › ${relative(root, s.key)}`, kind: 'subfolder' });
    }
  }
  // label 留空：「无文件夹」的文案归前端 i18n
  if (scratchRoot) out.push({ key: scratchRoot, root: scratchRoot, label: null, kind: 'scratch' });
  return out;
}

// 扫盘结果的持有者：单飞（在途时再来的请求合并成跑完后补跑一次），结果变了才通知。
// 扫描抛错保留上一次的结果——一次读盘失败就清空，抽屉的子项目会整片闪没。
// start 周期补扫：终端里在新子目录开的会话只有扫盘认得出；shouldScan 为假（没人在看）时跳过这一趟。
export function createProjectIndex({ discover, onChange }) {
  let current = null; // null = 还没扫过（≠ 没有子项目）
  let signature = null;
  let inflight = null;
  let again = false;
  async function run() {
    try {
      const next = await discover();
      const sig = JSON.stringify(next);
      if (sig !== signature) {
        signature = sig;
        current = next;
        onChange(next);
      }
    } catch { /* 保留上一次的结果 */ }
  }
  function refresh() {
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = run().finally(() => {
      inflight = null;
      if (again) {
        again = false;
        refresh();
      }
    });
    return inflight;
  }
  let timer = null;
  function start(intervalMs, shouldScan) {
    if (timer) return;
    refresh();
    timer = setInterval(() => { if (shouldScan()) refresh(); }, intervalMs);
    timer.unref?.();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }
  return { refresh, get: () => current, start, stop };
}

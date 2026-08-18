// CLI 的 project 目录名编码 —— 与 claude CLI / Agent SDK 逐字节对齐的唯一实现。
//
// ~/.claude/projects/<encodeProjectDir(cwd)>/<sessionId>.jsonl 是 CLI 落 transcript 的位置，
// 本仓要读它就必须算出**完全相同**的目录名。规则（截断与 hash 取自 sdk.mjs 的 Co()/EZ()/v_()，
// 已与 CLI 2.1.225 二进制里的 gw()/T$g() 逐条核对同源）：
//   1. 先 NFC 归一，**无条件、不分平台**（理由见下）
//   2. 非字母数字 → '-'
//   3. 结果超过 200 字符则截到 200，再接 '-' + hash 的 36 进制
//
// ★ 归一这步要对齐 CLI，不是对齐 SDK —— 上游这两者本身不一致（2026-08-09 分别从两个产物直接读出）：
//     SDK 0.3.201  Pr(e) = process.platform === "darwin" ? e.normalize("NFC") : e   ← 平台门控
//     CLI 2.1.225  xp(e) = e.normalize("NFC")                                        ← 无条件
//   写 transcript 的是 CLI，跟它。macOS 上两种写法行为完全相同，分歧只在 Linux（headless
//   那条入口的常见平台）且路径含 NFD 形式非 ASCII 时显形：那时 SDK 式写法会把同一个目录编成两个名字。
//   对应回归用例在 tests/unit/history-files.test.mjs，且**只有 Linux 容器能鉴别它**（macOS 上恒绿）。
//
// 那个 200 是贴着文件系统单段 255 字节上限设的，不是美观阈值：不截断算出的名字**根本建不出目录**，
// 所有 stat/read 直接 ENAMETOOLONG，而 history.js 里那些 `catch { return null }` 会把异常吞成
// 「没有会话」——表现为该 workdir 会话列表恒空、镜像同步失效，同时 CLI 自己一切正常。
//
// ★ 为什么收敛成一份：此前 history.js 的 getProjectDir 与 workdirs.js 的 projectDirKey 各存一份
// 复制品，注释都写着「与 CLI 同规则」，而两份都漏了截断与 NFC——声称对齐但从没对齐。要改编码规则
// 只改这里。
//
// 调用方负责先把 cwd 解析成真实路径（CLI 编码前会 realpath），workdirs.resolveWorkdirs 已 realpathSync。
// 本函数保持纯函数、不做任何 I/O。

const MAX_SEGMENT = 200;

// SDK v_()：hash*31 累加并强制 |0 维持 32 位有符号语义。逐字节对齐上游，勿「优化」。
function hash32(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}

export function encodeProjectDir(cwd) {
  const raw = String(cwd || '');
  const normalized = raw.normalize('NFC'); // 对齐 CLI 的 xp()：无条件归一，不做平台判断
  const sanitized = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SEGMENT) return sanitized;
  // hash 喂的是**归一后、sanitize 前**的原串（对齐 SDK 的 EZ(e)，不是 EZ(t)）——这里错一个字节就白修
  return `${sanitized.slice(0, MAX_SEGMENT)}-${Math.abs(hash32(normalized)).toString(36)}`;
}

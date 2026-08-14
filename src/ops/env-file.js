// .env 的结构化读写：按行改，不重排、不丢注释、不动不认识的 key。
//
// 为什么不复用 scripts/setup.js 的 buildEnvContent：那是三行正则往 .env.example 模板里填值，
// 不保结构、不支持增删，且它自己的注释就写着「模板格式一变就静默不替换」。dotenv 只有 parser
// 没有 serializer，所以序列化这块只能自己写 —— 也正是最容易写错的一块。
//
// ## serializeEnvValue 的三个坑（写错的后果是 server 起不来，不是「配置没生效」）
//   1. 裸值会被行内 `#` 截断 —— NTFY_TOPIC=topic#1 解析出来是 "topic"
//   2. 双引号内 dotenv 会展开 \n \t 等转义 —— 路径里的反斜杠会被吃掉
//   3. 单引号内 dotenv 不做任何展开（最安全），但值本身含单引号就包不住
// 判据靠 tests/unit/env-file.test.mjs 的 round-trip property test 锁死：
// 拿 dotenv 自己的 parser 当 oracle，serialize→parse 必须一字不差。

// 换行与控制字符：.env 是行格式，塞进去只会产生一个语法错误的文件。校验期（env-schema）会先拦
// 一道，这里再兜底并**明确抛错** —— 静默替换掉用户输入比报错更糟。
//
// 用 charCode 逐字符判而不是正则字符类：控制字符在正则里只能写成字面量或 \u 转义，前者会把
// 裸控制字节写进源文件（diff / 编辑器 / ESLint no-control-regex 都会出问题），后者在经过若干
// 编辑环节后又容易被还原成前者。显式循环没有这个歧义。
function hasControlChars(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true; // C0 控制字符（含 \n \r \t）与 DEL
  }
  return false;
}

// 什么样的值可以裸写。**这是白名单，不是黑名单** —— 早前列"危险字符"的写法漏掉了 `$`，
// 于是 `pa$$word`、`x${HOME}y` 裸写进 .env，用户 `source` 一下就被 shell 展开成别的东西
// （property test 当场抓到）。黑名单要求"每遇到一个新字符都正确归类"，而那正是会失败的那一步
// —— 同 CLAUDE.md 里那条「白名单而非黑名单」的教训。
//
// 名单里这些字符在 shell 与 dotenv 两侧都是纯字面：字母数字、`_-.` 、路径的 `/`、
// URL 的 `:@+=`、逗号。其余一律加单引号。
const BARE_SAFE = /^[A-Za-z0-9_\-./:@+=,]+$/;

// 这个值能不能被安全地写进 .env。**唯一的否定条件是含单引号**，理由见 serializeEnvValue。
// 供 env-schema 在校验期提前拦一道 —— 否则用户填完点保存，才在写盘那一刻收到一句抛错。
export function isSerializableEnvValue(value) {
  const s = String(value ?? '');
  return !hasControlChars(s) && !s.includes("'");
}

// ## 为什么含单引号的值一律拒绝，而不是"换一种引号"
//
// `.env` 有**两个**消费者，两边的转义规则不一样，必须同时满足：
//   ① dotenv（server 启动时读它）
//   ② shell（用户调试时 `source .env`）
//
// 实测三种包裹（2026-08-14）：
//                dotenv 无损?          shell source 安全?
//   裸值          被行内 # 截断         安全（无特殊字符时）
//   单引号 '…'    ✓ 零展开              ✓ 完全字面
//   双引号 "…"    ✓（值不含 \ 和 "）    ✗ $(...) 会执行
//   反引号 `…`    ✓ 零展开              ✗ 整个值被当命令执行
//
// 也就是说**单引号是唯一两边都过关的包法**，而它恰恰包不住自身。对含单引号的值，
// 任何选择都会在某一侧失守 —— 与其挑一侧牺牲，不如明确说"这个值我表达不了"。
//
// 这条判断有过一次真实的反面教材：上一版为了 round-trip 正确性改用了反引号，
// 结果把「值里有个撇号」变成了 shell 命令注入（`K=\`it's x'; id -un > PWNED; :\`` 实测被执行），
// 而它自己上面那行注释刚说过反引号在 shell 里危险。**两个消费者的判断必须一起做，不能轮流做。**
export function serializeEnvValue(value) {
  const s = String(value ?? '');
  if (hasControlChars(s)) {
    throw new Error('配置值不能包含换行或控制字符');
  }
  if (BARE_SAFE.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  throw new Error("配置值不能包含单引号（'）：.env 里唯一对 dotenv 与 shell 都安全的包裹方式是单引号，而它包不住自身");
}

// 敏感项对外只报「设了没 + 多长」。绝不回显明文 —— 与 src/ops/doctor-runtime.js 的脱敏纪律同源。
export function maskSecret(value) {
  const s = typeof value === 'string' ? value : '';
  return { set: s.length > 0, length: s.length };
}

// 行首是不是某个 key 的赋值行。容忍 `export KEY=`（有人习惯这么写）与两侧空白。
function keyOfLine(line) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return m ? m[1] : null;
}

const APPEND_HEADER = '# ===== 以下由设置面板写入 =====';

// changes: { KEY: string | null }
//   string → 改已有行 / 追加新行
//   null   → **整行删除**（不是写 KEY=）。src/server/config.js:22,39-43 启动时会删掉所有空串
//            key，留一行 `KEY=` 毫无意义，还会挡住从 shell export 同名变量。
//   缺席   → 不动
export function applyEnvChanges(text, changes) {
  const entries = Object.entries(changes || {});
  if (entries.length === 0) return text;

  const src = String(text ?? '');
  const lines = src.split('\n');
  const pending = new Map(entries);
  // 删除与替换对「同名 key 重复」的处理必须不同，见下方循环里的两条注释。
  const deletions = new Set(entries.filter(([, v]) => v === null).map(([k]) => k));
  const out = [];

  // 从后往前扫：dotenv 的生效语义是**后者覆盖前者**。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const key = keyOfLine(line);
    if (key === null) {
      out.unshift(line);
      continue;
    }
    // 删除：**全部**同名行一并丢弃。只删最后一行的话，上面那个被覆盖的旧值会复活 ——
    // 用户以为清空了，配置却静默回退到一个更老的值。
    if (deletions.has(key)) {
      pending.delete(key);
      continue;
    }
    if (!pending.has(key)) {
      out.unshift(line);
      continue;
    }
    // 替换：只改最后一行。前面的重复行不影响生效值，是用户的历史，不该替他清理。
    const value = pending.get(key);
    pending.delete(key);
    out.unshift(`${key}=${serializeEnvValue(value)}`);
  }

  // 剩下的是新 key。删除一个本来就不存在的 key 是 no-op。
  const additions = [...pending].filter(([, v]) => v !== null);
  if (additions.length === 0) return out.join('\n');

  const body = out.join('\n');
  const parts = [body];
  if (body && !body.endsWith('\n')) parts.push('\n'); // 原文件末尾无换行时别粘行
  if (body.trim() && !body.includes(APPEND_HEADER)) parts.push(`\n${APPEND_HEADER}\n`);
  parts.push(additions.map(([k, v]) => `${k}=${serializeEnvValue(v)}`).join('\n'));
  parts.push('\n');
  return parts.join('');
}

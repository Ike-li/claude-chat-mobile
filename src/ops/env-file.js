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

// 需要引用的信号：空值、含任一种引号/反斜杠/井号、或有空白字符。
// 反引号也算：.env 常被 `source` 进 shell，裸值里的反引号会被当命令替换执行。
const NEEDS_QUOTE = /[#'"`\\\s]/;

export function serializeEnvValue(value) {
  const s = String(value ?? '');
  if (hasControlChars(s)) {
    throw new Error('配置值不能包含换行或控制字符');
  }
  if (s && !NEEDS_QUOTE.test(s)) return s;
  // 单引号：dotenv 对其内容不做任何转义展开，是最安全的包法。
  if (!s.includes("'")) return `'${s}'`;
  // 反引号：dotenv 对它同样不做展开（实测确认），是含单引号时的首选。
  if (!s.includes('`')) return `\`${s}\``;
  // 三种引号只剩双引号。dotenv 在双引号内**只展开 \n / \r，从不把 \\ 折回 \ 、
  // 也不把 \" 折回 "** —— 所以「转义后再靠 parser 还原」这条路根本不通（早前就错在这里：
  // 反斜杠每存一次翻一倍，含 \n 字面量的值甚至会解析出一个真换行）。
  // 只有当值本身不含这两个字符时，双引号才是无损的。
  if (!s.includes('"') && !s.includes('\\')) return `"${s}"`;
  // 同时含单引号 + 反引号 + (双引号或反斜杠)：三种引号都表达不了，与其静默损坏不如拒绝。
  throw new Error('配置值不能同时包含单引号、反引号与双引号/反斜杠');
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

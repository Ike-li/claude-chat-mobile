// public/js/canonicalize.js —— 审批完整性绑定的规范化 + 指纹核心（LLD §5.5，承接 AD-7/NFR-17）
// 前后端共享同一份文件（浏览器原生 ESM 加载 /js/canonicalize.js；Node 端 agent.js 用相对路径 import
// 同一文件）——"机制强度==双端一致性强度"，任一端 NFC/键排序/数字格式化行为不同都会使合法审批在
// 校验步被误判为篡改。哈希用 crypto.subtle（Web Crypto，Node 20+ 与所有现代浏览器均全局可用，SHA-256
// 是标准化算法、不存在跨实现漂移风险，不必像 NFC/键排序那样自造以保证一致）。
//
// 注：浏览器 crypto.subtle 要求安全上下文（HTTPS 或 localhost）——纯局域网 http:// 访问时不可用，
// 调用方（app.js）需自行判定 typeof crypto?.subtle 后优雅降级（跳过前端预检，不阻塞渲染）；本文件
// 不做这层降级判断，纯粹提供计算能力。

function canonicalizeValue(v) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalize: 数值不合法（NaN/Infinity）');
    return String(v); // JS 内部 1.0 与 1 是同一个 Number 值，String() 恒输出 "1"，天然满足"1.0==1"
  }
  if (t === 'string') return JSON.stringify(v.normalize('NFC'));
  if (Array.isArray(v)) return '[' + v.map(canonicalizeValue).join(',') + ']'; // 保序，顺序即语义，不排序
  if (t === 'object') {
    const keys = Object.keys(v).sort(); // Unicode 码点字典序：本场景 key 均为工具参数名（ASCII），JS 默认字符串比较足够
    return '{' + keys.map(k => JSON.stringify(k.normalize('NFC')) + ':' + canonicalizeValue(v[k])).join(',') + '}';
  }
  throw new Error(`canonicalize: 不支持的值类型：${t}`);
}

// 词法路径归一化（折叠 ./ 与 ../、去尾斜杠）——刻意不 resolve 符号链接，与 §3.4.1 WorkdirScopeGuard
// 相反：那里范围是权限边界必须 resolve 真实落点；这里完整性层管"用户看到的路径 == 指纹的路径"的
// 展示一致性，resolve 符号链接反而会让展示路径与指纹背离。不用 node:path（浏览器不可用）——纯字符串
// 操作，前后端逐字节一致正是本函数存在的理由，不碰文件系统（不存在的路径也能正常计算）。
function normalizeLexicalPath(p) {
  if (typeof p !== 'string' || !p) return p;
  const isAbsolute = p.startsWith('/');
  const stack = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length && stack[stack.length - 1] !== '..') stack.pop();
      else if (!isAbsolute) stack.push('..');
    } else stack.push(part);
  }
  return (isAbsolute ? '/' : '') + stack.join('/');
}

// op = {tool, args, cwd}：canUseTool 三要素。只取这三个字段——reqId/时间戳等易变字段天然不在其中，
// 不是"剔除"逻辑而是"只取"逻辑：调用方即便传入携带额外字段的对象，本函数也只看这三个。
export function canonicalizeOp(op) {
  const { tool, args, cwd } = op || {};
  return canonicalizeValue({ tool, args, cwd: normalizeLexicalPath(cwd) });
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintHex(op) {
  const canonical = canonicalizeOp(op);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return toHex(digest);
}

export async function verifyIntegrity(fp, op) {
  return (await fingerprintHex(op)) === fp;
}

// elicitation.js —— MCP elicitation（#460）：把 SDK 的 ElicitationRequest 归一成卡片能直接画的形状，并按同一份
// 字段描述校验作答。
//
// 为什么只在服务端：前后端互不 import（check-import-boundaries 硬闸），而「支持哪些 schema」与「什么作答算合法」
// 必须只有一份。所以这里把 requestedSchema 归一成 fields 随事件下发，前端只照着画；作答回来再按同一份 fields 校验。
//
// 子集照 MCP 规范：elicitation 的 schema 只许扁平对象 + 原始类型属性——string（minLength / maxLength / format）、
// number / integer（minimum / maximum）、boolean、单选枚举（enum [+ enumNames] 或 oneOf [{ const, title }]）。
// 超出就 unsupported：卡片只给拒绝 / 取消，绝不替用户瞎填。
// 文本都是第三方内容，这里只截长度不转义——前端一律 textContent 渲染。

const MESSAGE_MAX = 4000;
const LABEL_MAX = 200;
const URL_PROTOCOLS = new Set(['http:', 'https:']);
const STRING_FORMATS = new Set(['email', 'uri', 'date', 'date-time']);

const text = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function enumOptions(prop) {
  if (Array.isArray(prop.enum)) {
    if (!prop.enum.every(v => typeof v === 'string')) return null;
    const names = Array.isArray(prop.enumNames) ? prop.enumNames : [];
    return prop.enum.map((value, i) => ({ value, label: typeof names[i] === 'string' && names[i] ? names[i] : value }));
  }
  if (Array.isArray(prop.oneOf)) {
    if (!prop.oneOf.every(o => typeof o?.const === 'string')) return null;
    return prop.oneOf.map(o => ({ value: o.const, label: typeof o.title === 'string' && o.title ? o.title : o.const }));
  }
  return undefined;
}

function describeField(name, prop, required) {
  if (!prop || typeof prop !== 'object') return null;
  const base = { name, title: text(prop.title, LABEL_MAX), description: text(prop.description, MESSAGE_MAX), required };
  if (prop.type === 'string') {
    const options = enumOptions(prop);
    if (options === null) return null;
    if (options) return compact({ ...base, type: 'enum', options, default: options.some(o => o.value === prop.default) ? prop.default : undefined });
    if (prop.format !== undefined && !STRING_FORMATS.has(prop.format)) return null;
    return compact({
      ...base, type: 'string', format: prop.format, minLength: num(prop.minLength), maxLength: num(prop.maxLength),
      default: typeof prop.default === 'string' ? prop.default : undefined,
    });
  }
  if (prop.type === 'number' || prop.type === 'integer') {
    return compact({ ...base, type: prop.type, minimum: num(prop.minimum), maximum: num(prop.maximum), default: num(prop.default) });
  }
  if (prop.type === 'boolean') {
    return compact({ ...base, type: 'boolean', default: typeof prop.default === 'boolean' ? prop.default : undefined });
  }
  return null;
}

function describeForm(schema) {
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    return { unsupported: true, unsupportedReason: '表单结构不是扁平对象' };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = [];
  for (const [name, prop] of Object.entries(schema.properties)) {
    const field = describeField(name, prop, required.has(name));
    if (!field) return { unsupported: true, unsupportedReason: `字段「${name}」的类型不受支持` };
    fields.push(field);
  }
  return { fields };
}

function describeUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return { unsupported: true, unsupportedReason: '链接无法解析' }; }
  if (!URL_PROTOCOLS.has(parsed.protocol)) return { unsupported: true, unsupportedReason: '只支持 http / https 链接' };
  return { url: parsed.href, urlOrigin: parsed.origin };
}

// 事件 payload（不含 requestId / createdAt / expiresAt，由 agent 补）。
export function describeElicitation(request = {}) {
  const mode = request.mode === 'url' ? 'url' : 'form';
  return compact({
    serverName: text(request.serverName, LABEL_MAX) || 'MCP',
    message: text(request.message, MESSAGE_MAX) || '',
    mode,
    title: text(request.title, LABEL_MAX),
    displayName: text(request.displayName, LABEL_MAX),
    description: text(request.description, MESSAGE_MAX),
    elicitationId: mode === 'url' ? text(request.elicitationId, LABEL_MAX) : undefined,
    ...(mode === 'url' ? describeUrl(request.url) : describeForm(request.requestedSchema)),
  });
}

const fieldName = f => f.title || f.name;
const charLength = s => [...s].length;

function formatOk(format, v) {
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (format === 'uri') { try { return Boolean(new URL(v).protocol); } catch { return false; } }
  if (format === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }
  if (format === 'date-time') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
  return true;
}

function fieldError(f, v) {
  const label = fieldName(f);
  if (f.type === 'string') {
    if (typeof v !== 'string') return `「${label}」应为文本`;
    if (f.minLength !== undefined && charLength(v) < f.minLength) return `「${label}」至少 ${f.minLength} 个字`;
    if (f.maxLength !== undefined && charLength(v) > f.maxLength) return `「${label}」最多 ${f.maxLength} 个字`;
    if (f.format && !formatOk(f.format, v)) return `「${label}」格式不对（${f.format}）`;
    return null;
  }
  if (f.type === 'number' || f.type === 'integer') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return `「${label}」应为数字`;
    if (f.type === 'integer' && !Number.isInteger(v)) return `「${label}」应为整数`;
    if (f.minimum !== undefined && v < f.minimum) return `「${label}」不能小于 ${f.minimum}`;
    if (f.maximum !== undefined && v > f.maximum) return `「${label}」不能大于 ${f.maximum}`;
    return null;
  }
  if (f.type === 'boolean') return typeof v === 'boolean' ? null : `「${label}」应为是或否`;
  if (f.type === 'enum') return f.options.some(o => o.value === v) ? null : `「${label}」不在可选项里`;
  return `「${label}」的类型不受支持`;
}

// 作答校验。必填项缺失或空串算没填；可选项没给就不进 content。多出来的键一律拒收（不替服务器收它没要的东西）。
export function validateElicitationContent(fields, content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return { ok: false, error: '作答内容不是表单对象' };
  const byName = new Map(fields.map(f => [f.name, f]));
  for (const key of Object.keys(content)) {
    if (!byName.has(key)) return { ok: false, field: key, error: `表单里没有「${key}」这一项` };
  }
  const out = {};
  for (const f of fields) {
    const v = content[f.name];
    if (v === undefined || v === null || v === '') {
      if (f.required) return { ok: false, field: f.name, error: `「${fieldName(f)}」必填` };
      continue;
    }
    const error = fieldError(f, v);
    if (error) return { ok: false, field: f.name, error };
    out[f.name] = v;
  }
  return { ok: true, content: out };
}

// logic/elicitation.js —— MCP elicitation 卡片（#460）的纯函数。
// 字段描述（fields）由服务端从 requestedSchema 归一后下发，校验也只在服务端（前后端互不 import，同一份规则只放一处）；
// 这里只把表单控件里的原始值转成要交上去的 content，以及卡片上的几处文案判定。

// raw：{ [name]: string | boolean }，string 来自 input / select 的 value，boolean 来自复选框。
// 没填的可选项不放进 content；数字解析不了就原样交上去，让服务端说清楚哪一项不对。
export function elicitationContentFromInputs(fields, raw = {}) {
  const content = {};
  for (const f of fields || []) {
    const v = raw[f.name];
    if (f.type === 'boolean') {
      if (typeof v === 'boolean') content[f.name] = v;
      continue;
    }
    if (typeof v !== 'string' || v === '') continue;
    if (f.type === 'number' || f.type === 'integer') {
      const n = Number(v);
      content[f.name] = Number.isFinite(n) ? n : v;
    } else if (f.format === 'date-time' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(v)) {
      // datetime-local 给的是不带时区的本地时刻；服务端要带 Z / 偏移的 ISO
      const d = new Date(v);
      content[f.name] = Number.isNaN(d.getTime()) ? v : d.toISOString();
    } else {
      content[f.name] = v;
    }
  }
  return content;
}

export function elicitationHeading(card = {}) {
  return card.title || card.displayName || card.serverName || '';
}

// OAuth 回调常指向主机本机：手机上打开，回调落不到主机，授权会失败
export function isHostLocalOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false;
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '0.0.0.0' || host.endsWith('.localhost');
}

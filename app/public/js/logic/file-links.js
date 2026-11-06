// 消息里的 href 是不是本机文件。模型写的是相对会话 cwd 的路径，浏览器按 CCM 自己的
// `/` 解析只会落到 Cannot GET，所以渲染时要认出来，点击时交给工作区 sheet。

// 与 DOMPurify 的 URI 白名单同一份：这些 scheme 冒号后就算全是数字也不是行号（tel:10086）
const BROWSER_SCHEMES = /^(?:https?|ftps?|mailto|tel|callto|sms|cid|xmpp|matrix)$/i;
const LOCAL_FILE_URL = /^file:\/\/(?:localhost)?(?=\/)/i;
const LINE_SUFFIX = /:(\d+)(?:-\d+)?(?::\d+)?$/;

function decodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function parseFileLink(href) {
  if (!href || href.startsWith('//')) return null;
  const target = href.replace(LOCAL_FILE_URL, '');
  const [, rawPath, fragment = ''] = /^([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/s.exec(target);
  const lineSuffix = LINE_SUFFIX.exec(rawPath);
  const path = lineSuffix ? rawPath.slice(0, lineSuffix.index) : rawPath;
  if (!path) return null;
  // foo.js:12 形似 scheme：冒号后整段就是行号才算文件，否则是外部协议
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(rawPath);
  if (scheme && (BROWSER_SCHEMES.test(scheme[1]) || lineSuffix?.index !== scheme[1].length)) return null;
  const line = lineSuffix?.[1] ?? /^L(\d+)/.exec(fragment)?.[1];
  return { path: decodePath(path), line: line ? Number(line) : null };
}

// 第 line 行（从 1 起）在 text 里的起止偏移；分页读的文件可能还没读到那一行，回 null
export function lineSpan(text, line) {
  let start = 0;
  for (let n = 1; n < line; n += 1) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) return null;
    start = newline + 1;
  }
  if (start === text.length) return null; // 这一页正好断在目标行之前，行首的空区间不算读到
  const end = text.indexOf('\n', start);
  return { start, end: end < 0 ? text.length : end };
}

// sanitizer.js —— 日志脱敏模块
// 功能：过滤日志/终端输出中的敏感信息（token、API key、密码等），防止泄露。
// 用途：交互日志（LOG_INTERACTIONS=1）、stderr 输出、启动打印等所有日志场景。

// 15 种敏感信息正则模式（含 Anthropic key）
const PATTERNS = [
  // 1. API keys (sk-*, key-*, api-*) 长度 ≥15 字符
  [/\b(sk|key|api)[-_][A-Za-z0-9][A-Za-z0-9_-]{15,}\b/g, '***'],

  // 2. GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],

  // 3. JWT tokens (eyJ 开头的 base64.base64.base64 结构)
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, '***'],

  // 4. PEM private keys
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, '***'],

  // 5. Bearer tokens
  [/Bearer\s+[A-Za-z0-9._\-]{20,}/g, 'Bearer ***'],

  // 6. 环境变量赋值（大写严格匹配，避免误杀）
  [/([A-Z_]*(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z_]*\s*=\s*)\S+/g, '$1***'],

  // 7. 环境变量赋值（混合大小写，要求值 ≥8 字符）
  [/([A-Za-z_]*(key|secret|token|password|passwd|credential)[A-Za-z_]*\s*=\s*)\S{8,}/gi, '$1***'],

  // 8. AWS session tokens
  [/\b(aws_session_token|AWS_SESSION_TOKEN)\s*=\s*\S+/gi, '***'],

  // 9. OAuth access/refresh tokens（≥20 字符）
  [/\b(access_token|refresh_token)[:=]\s*[A-Za-z0-9._\-]{20,}\b/g, '$1:***'],

  // 10. SSH key fingerprints (MD5: xx:xx:xx:...)
  [/\b[0-9a-f]{2}(:[0-9a-f]{2}){15,}\b/g, '***'],

  // 11. URL 凭据 (scheme://user:pass@host)
  [/\b([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\s:/@]+:)[^\s/@]+(@)/g, '$1***$2'],

  // 12. HTTP Basic auth header
  [/(?:Basic\s+)[A-Za-z0-9+/=]{8,}/gi, 'Basic ***'],

  // 13. AWS access keys (AKIA/ASIA 开头的 20 字符)
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '***'],

  // 14. Telegram Bot tokens (数字:字符串，支持 URL 编码的冒号 %3A)
  [/\b(bot)?\d{6,}(?::|%3[Aa])[A-Za-z0-9_-]{20,}\b/g, '***'],

  // 15. Anthropic API keys (sk-ant-* 格式，常见于 Claude API)
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '***'],
];

// ANSI 转义序列正则（CSI/OSC/C1 控制字符）
const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * 去除 ANSI 转义序列和控制字符（保留 \t \n \r）
 */
export function stripControlSequences(text) {
  if (typeof text !== 'string') return '';
  text = text.replace(ANSI_ESCAPE_RE, '');
  text = text.replace(CONTROL_CHARS_RE, '');
  return text;
}

/**
 * 主脱敏函数：应用所有敏感模式替换
 */
export function sanitize(text) {
  if (typeof text !== 'string') return '';

  // 1. 先去除控制序列
  text = stripControlSequences(text);

  // 2. 应用 15 种敏感模式替换
  for (const [pattern, replacement] of PATTERNS) {
    text = text.replace(pattern, replacement);
  }

  return text;
}

/**
 * Token 掩码显示（保留前 4 后 4 字符，中间用 **** 替换）
 * 用于启动时安全打印 AUTH_TOKEN
 */
export function maskToken(token) {
  if (!token || typeof token !== 'string') return '***';
  if (token.length < 12) return '***';  // 太短的 token 全部隐藏
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

/**
 * 路径脱敏：隐藏用户主目录和工作目录（防止泄露文件系统结构）
 */
export function sanitizePath(path) {
  if (typeof path !== 'string') return '';

  // 替换常见路径前缀
  const replacements = [
    [/\/Users\/[^/]+/g, '<home>'],         // macOS
    [/\/home\/[^/]+/g, '<home>'],          // Linux
    [/C:\\Users\\[^\\]+/gi, '<home>'],     // Windows
    [/\/tmp\//g, '<tmp>/'],
    [/\/var\//g, '<var>/'],
    [/C:\\Windows\\/gi, '<windows>\\'],
    [/C:\\Program Files/gi, '<program-files>'],
  ];

  for (const [pattern, replacement] of replacements) {
    path = path.replace(pattern, replacement);
  }

  return path;
}

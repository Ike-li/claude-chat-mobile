// test/sanitizer.test.mjs —— sanitizer.js 纯函数单测（零 IO、零依赖）
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, stripControlSequences, maskToken, sanitizePath } from '../sanitizer.js';

// ── stripControlSequences ──────────────────────────────────────────────────

test('stripControlSequences: 纯文本原样返回', () => {
  assert.equal(stripControlSequences('hello world'), 'hello world');
});

test('stripControlSequences: ANSI SGR 颜色序列被剥除', () => {
  assert.equal(stripControlSequences('\x1b[31mred\x1b[0m'), 'red');
});

test('stripControlSequences: 24-bit 颜色序列被剥除', () => {
  assert.equal(stripControlSequences('\x1b[38;2;255;0;0mhi\x1b[0m'), 'hi');
});

test('stripControlSequences: OSC 序列（标题设置）被剥除', () => {
  assert.equal(stripControlSequences('\x1b]0;title\x07rest'), 'rest');
});

test('stripControlSequences: 保留 \\t \\n \\r', () => {
  assert.equal(stripControlSequences('a\tb\nc\r'), 'a\tb\nc\r');
});

test('stripControlSequences: 控制字符（\\x00–\\x08 等）被剥除', () => {
  assert.equal(stripControlSequences('\x00\x01\x07\x1f'), '');
});

test('stripControlSequences: 非字符串返回空串', () => {
  assert.equal(stripControlSequences(null), '');
  assert.equal(stripControlSequences(undefined), '');
  assert.equal(stripControlSequences(123), '');
});

// ── sanitize ───────────────────────────────────────────────────────────────

test('sanitize: 普通文本原样返回', () => {
  assert.equal(sanitize('hello world'), 'hello world');
});

test('sanitize: sk-* API key 被脱敏', () => {
  const result = sanitize('key: sk-abcdefghij1234567890'); // gitleaks:allow
  assert.ok(!result.includes('sk-abcdefghij'), '应脱敏 sk- key');
  assert.match(result, /\*\*\*/);
});

test('sanitize: Anthropic key sk-ant-* 被脱敏', () => {
  const result = sanitize('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
  assert.ok(!result.includes('sk-ant-'), '应脱敏 Anthropic key');
});

test('sanitize: GitHub token ghp_* 被脱敏', () => {
  const result = sanitize('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef');
  assert.ok(!result.includes('ghp_ABCDEFGHIJKLMNO'), '应脱敏 GitHub token');
});

test('sanitize: JWT 被脱敏', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'; // gitleaks:allow
  const result = sanitize(`auth: ${jwt}`);
  assert.ok(!result.includes('eyJhbGciOiJIUzI1NiJ9.'), '应脱敏 JWT');
  assert.match(result, /\*\*\*/);
});

test('sanitize: Bearer token 被脱敏', () => {
  const result = sanitize('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345');
  assert.match(result, /Bearer \*\*\*/);
  assert.ok(!result.includes('abcdefghijklmnop'), '应脱敏 Bearer 值');
});

test('sanitize: 大写环境变量赋值被脱敏', () => {
  const result = sanitize('AUTH_TOKEN=mysecrettoken123456');
  assert.ok(!result.includes('mysecrettoken123456'), '应脱敏环境变量值');
  assert.match(result, /AUTH_TOKEN=\*\*\*/);
});

test('sanitize: URL 凭据 user:pass@host 被脱敏', () => {
  const result = sanitize('postgres://admin:s3cr3tPa55@db.example.com/mydb');
  assert.ok(!result.includes('s3cr3tPa55'), '应脱敏 URL 密码');
  assert.ok(result.includes('@'), '@ 符号保留');
});

test('sanitize: AWS access key AKIA* 被脱敏', () => {
  const result = sanitize('AKIAIOSFODNN7EXAMPLE');
  assert.ok(!result.includes('AKIAIOSFODNN7EXAMPLE'), '应脱敏 AWS key');
});

test('sanitize: ANSI 序列先被剥除再脱敏', () => {
  const result = sanitize('\x1b[31mAUTH_TOKEN=secret12345\x1b[0m');
  assert.ok(!result.includes('\x1b'), '应先剥除 ANSI');
  assert.ok(!result.includes('secret12345'), '应脱敏 token 值');
});

test('sanitize: 非字符串返回空串', () => {
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
  assert.equal(sanitize(42), '');
});

// ── maskToken ──────────────────────────────────────────────────────────────

test('maskToken: 正常长度 token 保留首尾各 4 字符', () => {
  assert.equal(maskToken('abcd1234WXYZ5678'), 'abcd****5678');
});

test('maskToken: 恰好 12 字符（等于阈值）', () => {
  assert.equal(maskToken('abcd12345678'), 'abcd****5678');
});

test('maskToken: 不足 12 字符全部隐藏', () => {
  assert.equal(maskToken('short'), '***');
  assert.equal(maskToken('12345678901'), '***'); // 11 chars
});

test('maskToken: 空串 / null / undefined 返回 ***', () => {
  assert.equal(maskToken(''), '***');
  assert.equal(maskToken(null), '***');
  assert.equal(maskToken(undefined), '***');
});

// ── sanitizePath ───────────────────────────────────────────────────────────

test('sanitizePath: macOS 用户目录被替换为 <home>', () => {
  assert.equal(sanitizePath('/Users/you/code/project'), '<home>/code/project');
});

test('sanitizePath: Linux 用户目录被替换为 <home>', () => {
  assert.equal(sanitizePath('/home/ubuntu/project'), '<home>/project');
});

test('sanitizePath: /tmp 路径被替换', () => {
  assert.equal(sanitizePath('/tmp/myfile.txt'), '<tmp>/myfile.txt');
});

test('sanitizePath: /var 路径被替换', () => {
  assert.equal(sanitizePath('/var/log/app.log'), '<var>/log/app.log');
});

test('sanitizePath: 不匹配路径原样返回', () => {
  assert.equal(sanitizePath('/etc/hosts'), '/etc/hosts');
});

test('sanitizePath: 非字符串返回空串', () => {
  assert.equal(sanitizePath(null), '');
  assert.equal(sanitizePath(undefined), '');
});

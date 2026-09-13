// tests/unit/logic-format.test.mjs —— format.js 纯函数单测（基础格式化与转义原语）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esc,
  ansiToHtml,
  urlBase64ToUint8Array,
  formatRttMs,
  rttToneClass,
  userBubbleFold,
  formatUptime,
} from '../../app/public/js/logic/format.js';
import { setLang } from '../../app/public/js/i18n.js';

// formatUptime 内部走 t()，而 setLang 是模块级全局状态、同进程内别的测试文件会改它。
// 每个 test 前重置，避免受执行顺序影响（惯例同 logic-general-nav.test.mjs）。
test.beforeEach(() => setLang('zh'));

test.describe('esc —— HTML 字符转义', () => {
  test('典型输入：普通文本不转义，保留空格和标点', () => {
    assert.equal(esc('hello world'), 'hello world');
    assert.equal(esc('Plain text 123!'), 'Plain text 123!');
  });

  test('典型输入：转义 5 种核心字符 & < > " \'', () => {
    assert.equal(esc('&'), '&amp;');
    assert.equal(esc('<'), '&lt;');
    assert.equal(esc('>'), '&gt;');
    assert.equal(esc('"'), '&quot;');
    assert.equal(esc("'"), '&#39;');
    assert.equal(esc('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  });

  test('典型输入：HTML 标签与常见 XSS 注入片段', () => {
    assert.equal(
      esc('<script>alert("xss & \'injection\'")</script>'),
      '&lt;script&gt;alert(&quot;xss &amp; &#39;injection&#39;&quot;)&lt;/script&gt;'
    );
    assert.equal(
      esc('<img src="x" onerror="alert(1)">'),
      '&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;'
    );
  });

  test('边界：空串、null、undefined', () => {
    assert.equal(esc(''), '');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
  });

  test('边界：非字符串（0、负数、布尔值）转为字符串后转义', () => {
    assert.equal(esc(0), '0');
    assert.equal(esc(-42), '-42');
    assert.equal(esc(false), 'false');
    assert.equal(esc(true), 'true');
  });

  test('边界：连续重复特殊字符与超长串', () => {
    assert.equal(esc('<<<<>>>>&&&&'), '&lt;&lt;&lt;&lt;&gt;&gt;&gt;&gt;&amp;&amp;&amp;&amp;');
    const input = '<>'.repeat(500);
    const expected = '&lt;&gt;'.repeat(500);
    assert.equal(esc(input), expected);
  });
});

test.describe('ansiToHtml —— ANSI 转义序列转 HTML', () => {
  test('典型输入：纯文本与 HTML 特殊字符转义', () => {
    assert.equal(ansiToHtml('hello world'), 'hello world');
    assert.equal(ansiToHtml('<div>&"\'</div>'), '&lt;div&gt;&amp;&quot;&#39;&lt;/div&gt;');
  });

  test('典型输入：24-bit RGB 前景色 (\\x1b[38;2;R;G;Bm) 转 span 标签', () => {
    assert.equal(
      ansiToHtml('\x1b[38;2;255;0;0mRed\x1b[0m'),
      '<span style="color:rgb(255,0,0)">Red</span>'
    );
    assert.equal(
      ansiToHtml('\x1b[38;2;0;128;255mBlueText\x1b[0m'),
      '<span style="color:rgb(0,128,255)">BlueText</span>'
    );
  });

  test('典型输入：空重置序列 \\x1b[m 同样能闭合标签', () => {
    assert.equal(
      ansiToHtml('\x1b[38;2;10;20;30mDark\x1b[m'),
      '<span style="color:rgb(10,20,30)">Dark</span>'
    );
  });

  test('典型输入：多段连续颜色与重置', () => {
    const input = '\x1b[38;2;255;0;0mRed\x1b[0m Plain \x1b[38;2;0;255;0mGreen\x1b[0m';
    const expected = '<span style="color:rgb(255,0,0)">Red</span> Plain <span style="color:rgb(0,255,0)">Green</span>';
    assert.equal(ansiToHtml(input), expected);
  });

  test('安全边界：末尾未闭合的 span 会被自动配平补齐，防止破坏宿主 DOM', () => {
    assert.equal(
      ansiToHtml('\x1b[38;2;1;2;3mUnclosed'),
      '<span style="color:rgb(1,2,3)">Unclosed</span>'
    );
    assert.equal(
      ansiToHtml('\x1b[38;2;1;1;1mA\x1b[38;2;2;2;2mB'),
      '<span style="color:rgb(1,1,1)">A<span style="color:rgb(2,2,2)">B</span></span>'
    );
  });

  test('安全边界：着色文本内部的 HTML 特殊字符必须先经过 esc 转义', () => {
    assert.equal(
      ansiToHtml('\x1b[38;2;255;255;255m<script>alert(1)</script>\x1b[0m'),
      '<span style="color:rgb(255,255,255)">&lt;script&gt;alert(1)&lt;/script&gt;</span>'
    );
  });

  test('边界：非 24-bit 颜色 SGR（粗体、下划线、8/16色）被吞除控制序列并保留文本', () => {
    assert.equal(ansiToHtml('\x1b[1mBold\x1b[0m'), 'Bold');
    assert.equal(ansiToHtml('\x1b[4mUnderline\x1b[24m'), 'Underline');
    assert.equal(ansiToHtml('\x1b[31mClassicRed\x1b[0m'), 'ClassicRed');
  });

  test('边界：空串与无文字的纯 ANSI 序列', () => {
    assert.equal(ansiToHtml(''), '');
    assert.equal(ansiToHtml('\x1b[0m'), '');
    assert.equal(ansiToHtml('\x1b[m'), '');
    assert.equal(ansiToHtml('\x1b[38;2;0;0;0m\x1b[0m'), '<span style="color:rgb(0,0,0)"></span>');
  });

  test('边界：RGB 分量通道极值 (0 与 255)', () => {
    assert.equal(
      ansiToHtml('\x1b[38;2;0;0;0mBlack\x1b[0m'),
      '<span style="color:rgb(0,0,0)">Black</span>'
    );
    assert.equal(
      ansiToHtml('\x1b[38;2;255;255;255mWhite\x1b[0m'),
      '<span style="color:rgb(255,255,255)">White</span>'
    );
  });

  test('边界：无 open 时的重置序列不产生游离 </span> 标签', () => {
    assert.equal(ansiToHtml('Normal\x1b[0mText\x1b[mEnd'), 'NormalTextEnd');
  });

  test('边界：null / undefined 输入（当前真实行为：抛出 TypeError）', () => {
    assert.throws(() => ansiToHtml(null), TypeError);
    assert.throws(() => ansiToHtml(undefined), TypeError);
  });
});

test.describe('urlBase64ToUint8Array —— URL-safe Base64 转 Uint8Array', () => {
  test('典型输入：标准无 padding 字符串', () => {
    // "Hello" -> base64 "SGVsbG8=" -> urlBase64 "SGVsbG8"
    const actual = urlBase64ToUint8Array('SGVsbG8');
    assert.deepEqual(actual, new Uint8Array([72, 101, 108, 108, 111]));
  });

  test('典型输入：URL-safe 替换字符 - 与 _（对应标准 base64 的 + 与 /）', () => {
    // [251, 255] -> base64 "+/8=" -> urlBase64 "-_8"
    const actual = urlBase64ToUint8Array('-_8');
    assert.deepEqual(actual, new Uint8Array([251, 255]));
  });

  test('边界：长度模 4 余 0（无需补 padding）', () => {
    // [1, 2, 3] -> base64 "AQID" (长度 4)
    assert.deepEqual(urlBase64ToUint8Array('AQID'), new Uint8Array([1, 2, 3]));
    // [1, 2, 3, 4, 5, 6] -> base64 "AQIDBAUG" (长度 8)
    assert.deepEqual(urlBase64ToUint8Array('AQIDBAUG'), new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  test('边界：长度模 4 余 2（需要补 2 个 =）', () => {
    // [1] -> base64 "AQ==" -> urlBase64 "AQ" (长度 2)
    assert.deepEqual(urlBase64ToUint8Array('AQ'), new Uint8Array([1]));
  });

  test('边界：长度模 4 余 3（需要补 1 个 =）', () => {
    // [1, 2] -> base64 "AQI=" -> urlBase64 "AQI" (长度 3)
    assert.deepEqual(urlBase64ToUint8Array('AQI'), new Uint8Array([1, 2]));
  });

  test('边界：空串返回空 Uint8Array', () => {
    const res = urlBase64ToUint8Array('');
    assert.deepEqual(res, new Uint8Array([]));
    assert.equal(res.length, 0);
  });

  test('边界：全 0 与全 0xFF 极值字节', () => {
    assert.deepEqual(urlBase64ToUint8Array('AAAA'), new Uint8Array([0, 0, 0]));
    assert.deepEqual(urlBase64ToUint8Array('____'), new Uint8Array([255, 255, 255]));
  });

  test('边界：非法输入（null/undefined 抛 TypeError，长度模 4 余 1 抛异常）', () => {
    assert.throws(() => urlBase64ToUint8Array(null), TypeError);
    assert.throws(() => urlBase64ToUint8Array(undefined), TypeError);
    // 模 4 余 1 在 base64 中不合法（atob 抛 DOMException）
    assert.throws(() => urlBase64ToUint8Array('A'));
  });
});

test.describe('formatRttMs —— 延迟数值格式化', () => {
  test('典型输入：毫秒级整数（< 1000）输出 Xms', () => {
    assert.equal(formatRttMs(5), '5ms');
    assert.equal(formatRttMs(42), '42ms');
    assert.equal(formatRttMs(150), '150ms');
    assert.equal(formatRttMs(780), '780ms');
  });

  test('典型输入：秒级延迟（≥ 1000）保留 1 位小数输出 Xs', () => {
    assert.equal(formatRttMs(1200), '1.2s');
    assert.equal(formatRttMs(1550), '1.6s');
    assert.equal(formatRttMs(2345), '2.3s');
  });

  test('典型输入：毫秒级小数四舍五入', () => {
    assert.equal(formatRttMs(42.4), '42ms');
    assert.equal(formatRttMs(42.6), '43ms');
    assert.equal(formatRttMs(0.4), '0ms');
    assert.equal(formatRttMs(0.6), '1ms');
  });

  test('边界：0 毫秒为合法非负数值，输出 0ms', () => {
    assert.equal(formatRttMs(0), '0ms');
  });

  test('边界：分档阈值 1000ms 前后及临界点', () => {
    assert.equal(formatRttMs(999), '999ms');
    assert.equal(formatRttMs(999.4), '999ms');
    // 999.5 落在 [999.5, 1000) 之间，< 1000 进入 Math.round 产生 1000ms
    assert.equal(formatRttMs(999.5), '1000ms');
    assert.equal(formatRttMs(1000), '1.0s');
    assert.equal(formatRttMs(1049), '1.0s');
    assert.equal(formatRttMs(1050), '1.1s');
  });

  test('边界：大值与超大值', () => {
    assert.equal(formatRttMs(60_000), '60.0s');
    assert.equal(formatRttMs(3_600_000), '3600.0s');
    assert.equal(formatRttMs(Number.MAX_SAFE_INTEGER), '9007199254741.0s');
  });

  test('边界：负数与非有限数返回空串', () => {
    assert.equal(formatRttMs(-1), '');
    assert.equal(formatRttMs(-0.001), '');
    assert.equal(formatRttMs(-1000), '');
    assert.equal(formatRttMs(NaN), '');
    assert.equal(formatRttMs(Infinity), '');
    assert.equal(formatRttMs(-Infinity), '');
  });

  test('边界：非 number 类型（null、undefined、空串、数字字符串等）返回空串', () => {
    assert.equal(formatRttMs(null), '');
    assert.equal(formatRttMs(undefined), '');
    assert.equal(formatRttMs(''), '');
    assert.equal(formatRttMs('42'), '');
    assert.equal(formatRttMs(true), '');
    assert.equal(formatRttMs({}), '');
    assert.equal(formatRttMs([]), '');
  });
});

test.describe('rttToneClass —— 延迟色阶档位判定', () => {
  test('档位 1 (good)：0 <= ms < 150', () => {
    // 边界与典型值
    assert.equal(rttToneClass(0), 'good');
    assert.equal(rttToneClass(50), 'good');
    assert.equal(rttToneClass(149), 'good');
    assert.equal(rttToneClass(149.99), 'good');
  });

  test('档位 2 (ok)：150 <= ms < 400', () => {
    // 边界与典型值
    assert.equal(rttToneClass(150), 'ok');
    assert.equal(rttToneClass(250), 'ok');
    assert.equal(rttToneClass(399), 'ok');
    assert.equal(rttToneClass(399.99), 'ok');
  });

  test('档位 3 (warn)：400 <= ms < 1000', () => {
    // 边界与典型值
    assert.equal(rttToneClass(400), 'warn');
    assert.equal(rttToneClass(700), 'warn');
    assert.equal(rttToneClass(999), 'warn');
    assert.equal(rttToneClass(999.99), 'warn');
  });

  test('档位 4 (bad)：ms >= 1000', () => {
    // 边界、典型值与超大值
    assert.equal(rttToneClass(1000), 'bad');
    assert.equal(rttToneClass(1000.01), 'bad');
    assert.equal(rttToneClass(2500), 'bad');
    assert.equal(rttToneClass(60_000), 'bad');
    assert.equal(rttToneClass(Number.MAX_SAFE_INTEGER), 'bad');
  });

  test('边界：负数与非有限数返回空串', () => {
    assert.equal(rttToneClass(-1), '');
    assert.equal(rttToneClass(-0.001), '');
    assert.equal(rttToneClass(-150), '');
    assert.equal(rttToneClass(NaN), '');
    assert.equal(rttToneClass(Infinity), '');
    assert.equal(rttToneClass(-Infinity), '');
  });

  test('边界：非 number 类型（null、undefined、空串、字符串）返回空串', () => {
    assert.equal(rttToneClass(null), '');
    assert.equal(rttToneClass(undefined), '');
    assert.equal(rttToneClass(''), '');
    assert.equal(rttToneClass('100'), '');
    assert.equal(rttToneClass(false), '');
    assert.equal(rttToneClass({}), '');
  });
});

test.describe('userBubbleFold —— 用户气泡长消息折叠决策', () => {
  test('典型输入：普通单行简短文本不折叠', () => {
    assert.deepEqual(userBubbleFold('hello'), { fold: false, lines: 1 });
    assert.deepEqual(userBubbleFold('Short prompt to Claude'), { fold: false, lines: 1 });
  });

  test('典型输入：多行但未超 foldLines (默认 10) 不折叠', () => {
    const text = 'Line 1\nLine 2\nLine 3\nLine 4';
    assert.deepEqual(userBubbleFold(text), { fold: false, lines: 4 });
  });

  test('典型输入：超 foldLines (默认 10) 触发折叠', () => {
    const text = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join('\n');
    assert.deepEqual(userBubbleFold(text), { fold: true, lines: 15 });
  });

  test('典型输入：单行长文本按 cols (默认 30) 自动折行估算', () => {
    // 60 字符 -> 2 行
    assert.deepEqual(userBubbleFold('a'.repeat(60)), { fold: false, lines: 2 });
    // 75 字符 -> ceil(75/30) = 3 行
    assert.deepEqual(userBubbleFold('a'.repeat(75)), { fold: false, lines: 3 });
  });

  test('边界：分档阈值刚好 10 行 vs 11 行（lines > foldLines 判定）', () => {
    // 刚好 10 行：不折叠 (fold: false)
    const tenLines = Array.from({ length: 10 }, (_, i) => `${i + 1}`).join('\n');
    assert.deepEqual(userBubbleFold(tenLines), { fold: false, lines: 10 });

    // 单行刚好 300 字符 (300 / 30 = 10 行)：不折叠
    assert.deepEqual(userBubbleFold('x'.repeat(300)), { fold: false, lines: 10 });

    // 刚好 11 行：折叠 (fold: true)
    const elevenLines = Array.from({ length: 11 }, (_, i) => `${i + 1}`).join('\n');
    assert.deepEqual(userBubbleFold(elevenLines), { fold: true, lines: 11 });

    // 单行 301 字符 (ceil(301 / 30) = 11 行)：折叠
    assert.deepEqual(userBubbleFold('x'.repeat(301)), { fold: true, lines: 11 });
  });

  test('边界：空行处理（每个空行算 1 行）', () => {
    // 单换行产生 2 个空段 -> 2 行
    assert.deepEqual(userBubbleFold('\n'), { fold: false, lines: 2 });
    // 双换行产生 3 个空段 -> 3 行
    assert.deepEqual(userBubbleFold('\n\n'), { fold: false, lines: 3 });
    // 10 个连续换行产生 11 个空段 -> 11 行，触发折叠
    assert.deepEqual(userBubbleFold('\n'.repeat(10)), { fold: true, lines: 11 });
    // 空行与非空行穿插
    assert.deepEqual(userBubbleFold('top\n\nbottom'), { fold: false, lines: 3 });
  });

  test('边界：空串、null、undefined 返回 { fold: false, lines: 0 }', () => {
    assert.deepEqual(userBubbleFold(''), { fold: false, lines: 0 });
    assert.deepEqual(userBubbleFold(null), { fold: false, lines: 0 });
    assert.deepEqual(userBubbleFold(undefined), { fold: false, lines: 0 });
  });

  test('边界：非字符串输入自动转为字符串计算', () => {
    assert.deepEqual(userBubbleFold(0), { fold: false, lines: 1 });
    assert.deepEqual(userBubbleFold(12345), { fold: false, lines: 1 });
    assert.deepEqual(userBubbleFold(false), { fold: false, lines: 1 });
  });

  test('自定义 options：指定 foldLines 与 cols', () => {
    // cols = 10, foldLines = 2
    // 20 字符 -> 2 行 -> 不折叠
    assert.deepEqual(
      userBubbleFold('01234567890123456789', { foldLines: 2, cols: 10 }),
      { fold: false, lines: 2 }
    );
    // 21 字符 -> 3 行 -> 触发折叠
    assert.deepEqual(
      userBubbleFold('01234567890123456789x', { foldLines: 2, cols: 10 }),
      { fold: true, lines: 3 }
    );
    // foldLines = 0：只要有内容就折叠
    assert.deepEqual(
      userBubbleFold('single line', { foldLines: 0 }),
      { fold: true, lines: 1 }
    );
  });
});

test.describe('formatUptime —— 运行时长格式化', () => {
  test('秒档 (0s - 59s)：输出 X 秒', () => {
    assert.equal(formatUptime(0), '0 秒');
    assert.equal(formatUptime(999), '0 秒');
    assert.equal(formatUptime(1000), '1 秒');
    assert.equal(formatUptime(45_000), '45 秒');
    assert.equal(formatUptime(59_000), '59 秒');
    assert.equal(formatUptime(59_999), '59 秒');
  });

  test('分档 (1min - 59min)：输出 X 分钟（不附带余秒）', () => {
    assert.equal(formatUptime(60_000), '1 分钟');
    assert.equal(formatUptime(61_000), '1 分钟');
    assert.equal(formatUptime(5 * 60_000), '5 分钟');
    assert.equal(formatUptime(59 * 60_000), '59 分钟');
    assert.equal(formatUptime(59 * 60_000 + 59_000), '59 分钟');
    assert.equal(formatUptime(3_599_999), '59 分钟');
  });

  test('小时档 (1h - 23h59m)：输出 X 小时 Y 分', () => {
    assert.equal(formatUptime(3_600_000), '1 小时 0 分');
    assert.equal(formatUptime(90 * 60_000), '1 小时 30 分');
    assert.equal(formatUptime(12 * 3_600_000 + 45 * 60_000), '12 小时 45 分');
    assert.equal(formatUptime(23 * 3_600_000 + 59 * 60_000), '23 小时 59 分');
    assert.equal(formatUptime(86_400_000 - 1), '23 小时 59 分');
  });

  test('天档 (>= 24h)：输出 X 天 Y 小时', () => {
    assert.equal(formatUptime(86_400_000), '1 天 0 小时');
    assert.equal(formatUptime(25 * 3_600_000), '1 天 1 小时');
    assert.equal(formatUptime(3 * 86_400_000 + 14 * 3_600_000), '3 天 14 小时');
    assert.equal(formatUptime(365 * 86_400_000 + 5 * 3_600_000), '365 天 5 小时');
  });

  test('边界：负数与非有限数返回空串', () => {
    assert.equal(formatUptime(-1), '');
    assert.equal(formatUptime(-1000), '');
    assert.equal(formatUptime(NaN), '');
    assert.equal(formatUptime(Infinity), '');
    assert.equal(formatUptime(-Infinity), '');
  });

  test('边界：非 number 类型（null、undefined、空串、字符串）返回空串', () => {
    assert.equal(formatUptime(null), '');
    assert.equal(formatUptime(undefined), '');
    assert.equal(formatUptime(''), '');
    assert.equal(formatUptime('120'), '');
    assert.equal(formatUptime(true), '');
    assert.equal(formatUptime({}), '');
  });
});

// ---- i18n：formatUptime 的单位随语言切换（zh 秒/分钟/小时/分/天 → en s/min/h/d）----
test.describe('formatUptime —— en 语言下的单位', () => {
  test('四档单位全部随语言切换', () => {
    setLang('en');
    try {
      assert.equal(formatUptime(0), '0 s');
      assert.equal(formatUptime(45_000), '45 s');
      assert.equal(formatUptime(60_000), '1 min');
      assert.equal(formatUptime(3_600_000), '1 h 0 min');
      assert.equal(formatUptime(90 * 60_000), '1 h 30 min');
      assert.equal(formatUptime(86_400_000), '1 d 0 h');
      assert.equal(formatUptime(25 * 3_600_000), '1 d 1 h');
    } finally {
      setLang('zh');
    }
  });
});

test.after(() => setLang('zh'));

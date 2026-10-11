// tests/unit/logic-widget.test.mjs —— 桌面端 show_widget 图表的显示决策与 SVG 主题化（logic/widget.js）
// 桌面端的 SVG 依赖宿主样式表提供的 class（c-purple / t / ts / arr…）和变量（var(--b)…），
// 原样当图片显示会变成黑方块；作为 <img> 还必须有 xmlns 和固有尺寸，否则要么不渲染、要么缩成 300×150。
// 色板表按 visualize 工具 read_me 的公开原表抄在这里当规格，不从实现里导出——实现抄错一格这里就红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { widgetDisplayMode, themeWidgetSvg, widgetSvgDataUri, widgetTitleText, WIDGET_CODE_MAX } from '../../app/public/js/logic/widget.js';

// read_me「Color palette」原表：50 / 100 / 200 / 400 / 600 / 800 / 900
const RAMPS = {
  purple: ['#EEEDFE', '#CECBF6', '#AFA9EC', '#7F77DD', '#534AB7', '#3C3489', '#26215C'],
  teal: ['#E1F5EE', '#9FE1CB', '#5DCAA5', '#1D9E75', '#0F6E56', '#085041', '#04342C'],
  coral: ['#FAECE7', '#F5C4B3', '#F0997B', '#D85A30', '#993C1D', '#712B13', '#4A1B0C'],
  pink: ['#FBEAF0', '#F4C0D1', '#ED93B1', '#D4537E', '#993556', '#72243E', '#4B1528'],
  gray: ['#F1EFE8', '#D3D1C7', '#B4B2A9', '#888780', '#5F5E5A', '#444441', '#2C2C2A'],
  blue: ['#E6F1FB', '#B5D4F4', '#85B7EB', '#378ADD', '#185FA5', '#0C447C', '#042C53'],
  green: ['#EAF3DE', '#C0DD97', '#97C459', '#639922', '#3B6D11', '#27500A', '#173404'],
  amber: ['#FAEEDA', '#FAC775', '#EF9F27', '#BA7517', '#854F0B', '#633806', '#412402'],
  red: ['#FCEBEB', '#F7C1C1', '#F09595', '#E24B4A', '#A32D2D', '#791F1F', '#501313'],
};
const STOP = { 50: 0, 100: 1, 200: 2, 400: 3, 600: 4, 800: 5, 900: 6 };
// read_me「Light/dark mode quick pick」
const PICK = {
  light: { fill: 50, stroke: 600, title: 800, sub: 600 },
  dark: { fill: 800, stroke: 200, title: 100, sub: 200 },
};

const ARCH = '<svg width="100%" viewBox="0 0 680 530" role="img"><title>架构</title>'
  + '<g class="node c-purple" onclick="sendPrompt(\'x\')"><rect x="200" y="20" width="280" height="56" rx="8" stroke-width="0.5"/>'
  + '<text class="th" x="340" y="38">手机 / PWA</text><text class="ts" x="340" y="56">单页应用</text></g>'
  + '<rect x="30" y="100" width="620" height="390" fill="none" stroke="var(--b)"/></svg>';

const styleOf = svg => {
  const m = /<style>([\s\S]*?)<\/style>/.exec(svg);
  assert.ok(m, '主题化后的 SVG 里必须有注入的 <style>');
  return m[1];
};
// 在注入的 CSS 里找「选择器列表含 sel」的那条规则的声明块
const ruleFor = (css, sel) => {
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].split(',').map(s => s.trim()).includes(sel)) return m[2];
  }
  return null;
};

test.describe('widgetDisplayMode：显示成图、显示提示，还是退回一行工具调用', () => {
  test('完整 SVG → svg', () => {
    assert.equal(widgetDisplayMode({ title: 'a', kind: 'svg', code: ARCH }), 'svg');
    assert.equal(widgetDisplayMode({ kind: 'svg', code: '\n <svg viewBox="0 0 1 1"></svg>\n' }), 'svg');
  });

  test('交互组件 → html（不需要源码）', () => {
    assert.equal(widgetDisplayMode({ title: 'calc', kind: 'html' }), 'html');
  });

  test('kind=svg 但源码不是 svg 开头、没闭合、超限 → null（退回）', () => {
    assert.equal(widgetDisplayMode({ kind: 'svg', code: '<div><svg></svg></div>' }), null);
    assert.equal(widgetDisplayMode({ kind: 'svg', code: '<svg viewBox="0 0 1 1"><rect/>' }), null, '半截 SVG（没闭合）');
    assert.equal(widgetDisplayMode({ kind: 'svg', code: '<svgx></svgx>' }), null);
    const big = '<svg>' + 'x'.repeat(WIDGET_CODE_MAX) + '</svg>';
    assert.equal(widgetDisplayMode({ kind: 'svg', code: big }), null, '超过上限');
    // 上限按条压到 64K：回放缓冲与历史缓存都按条数封顶，单条过大会在常驻内存里成倍累积（真实图约 4.5KB）
    const svg65k = '<svg viewBox="0 0 1 1">' + 'x'.repeat(65 * 1024) + '</svg>';
    assert.equal(widgetDisplayMode({ kind: 'svg', code: svg65k }), null, '65KB 的 SVG 已超上限');
  });

  test('缺字段、未知 kind、非对象 → null', () => {
    for (const w of [undefined, null, 'svg', [], {}, { kind: 'svg' }, { kind: 'svg', code: 42 }, { kind: 'png', code: ARCH }]) {
      assert.equal(widgetDisplayMode(w), null, JSON.stringify(w));
    }
  });
});

test.describe('themeWidgetSvg：补齐宿主样式，让 SVG 能单独当图片显示', () => {
  for (const theme of ['light', 'dark']) {
    test(`${theme}：九个色板的填充/描边/标题/副标题按 read_me 选色`, () => {
      const css = styleOf(themeWidgetSvg(ARCH, { theme }));
      const p = PICK[theme];
      for (const [name, ramp] of Object.entries(RAMPS)) {
        const c = hex => ramp[STOP[hex]];
        for (const sel of [`.c-${name}>rect`, `.c-${name}>circle`, `.c-${name}>ellipse`, `rect.c-${name}`, `circle.c-${name}`, `ellipse.c-${name}`]) {
          const body = ruleFor(css, sel);
          assert.ok(body, `${sel} 没有规则：这一类节点会画成黑块`);
          assert.match(body, new RegExp(`fill:${c(p.fill)}`, 'i'), `${sel} 填充应为 ${p.fill}`);
          assert.match(body, new RegExp(`stroke:${c(p.stroke)}`, 'i'), `${sel} 描边应为 ${p.stroke}`);
        }
        for (const sel of [`.c-${name}>.t`, `.c-${name}>.th`]) {
          assert.match(ruleFor(css, sel) ?? '', new RegExp(`fill:${c(p.title)}`, 'i'), `${sel} 标题字应为 ${p.title}`);
        }
        assert.match(ruleFor(css, `.c-${name}>.ts`) ?? '', new RegExp(`fill:${c(p.sub)}`, 'i'), `.c-${name}>.ts 副标题字应为 ${p.sub}`);
      }
    });
  }

  test('文字 class 与变量都有定义，深浅两套不同', () => {
    const light = styleOf(themeWidgetSvg(ARCH, { theme: 'light' }));
    const dark = styleOf(themeWidgetSvg(ARCH, { theme: 'dark' }));
    for (const css of [light, dark]) {
      for (const v of ['--p', '--s', '--t', '--bg2', '--b']) assert.match(css, new RegExp(`${v}:#[0-9a-f]{6}`, 'i'), `变量 ${v} 未定义`);
      for (const sel of ['.t', '.ts', '.th']) assert.match(ruleFor(css, sel) ?? '', /fill:var\(--[ps]\)/, `${sel} 没有文字颜色`);
      for (const sel of ['.arr', '.leader', '.box']) assert.ok(ruleFor(css, sel), `${sel} 没有规则`);
    }
    const varOf = (css, v) => new RegExp(`${v}:(#[0-9a-f]{6})`, 'i').exec(css)[1];
    assert.notEqual(varOf(light, '--p'), varOf(dark, '--p'), '深浅主题的主文字色必须不同，否则深色下看不见字');
  });

  test('未知主题按浅色处理', () => {
    assert.equal(themeWidgetSvg(ARCH, { theme: 'sepia' }), themeWidgetSvg(ARCH, { theme: 'light' }));
  });

  test('缺 xmlns 时补上（没有它 <img> 根本不渲染）；已有的不重复', () => {
    const out = themeWidgetSvg(ARCH, { theme: 'light' });
    assert.match(out, /^<svg[^>]* xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    const withNs = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
    assert.equal(themeWidgetSvg(withNs, { theme: 'light' }).match(/xmlns=/g).length, 1);
  });

  test('用到 xlink: 而没声明时补 xmlns:xlink（否则 XML 解析失败）', () => {
    const out = themeWidgetSvg('<svg viewBox="0 0 10 10"><use xlink:href="#a"/></svg>', { theme: 'light' });
    assert.match(out, /xmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/);
  });

  test('百分比宽度按 viewBox 换成固有尺寸；绝对尺寸保留', () => {
    const out = themeWidgetSvg(ARCH, { theme: 'light' });
    const open = /^<svg[^>]*>/.exec(out)[0];
    assert.match(open, / width="680"/);
    assert.match(open, / height="530"/);
    assert.doesNotMatch(open, /100%/);
    const fixed = themeWidgetSvg('<svg width="300" height="200" viewBox="0 0 600 400"></svg>', { theme: 'light' });
    assert.match(fixed, /^<svg[^>]* width="300" height="200"/);
  });

  test('引号里带 > 的属性不会把开标签切错', () => {
    const out = themeWidgetSvg('<svg data-x="a>b" viewBox="0 0 10 10"><rect/></svg>', { theme: 'light' });
    assert.match(out, /^<svg[^>]*data-x="a>b"[^]*?><style>/);
    assert.match(out, /<\/style><rect\/><\/svg>$/);
  });

  test('原内容一字不动，样式插在开标签之后', () => {
    const out = themeWidgetSvg(ARCH, { theme: 'dark' });
    const body = ARCH.slice(ARCH.indexOf('>') + 1);
    assert.ok(out.endsWith(body), '开标签之后的原文必须原样保留');
    assert.match(out, /^<svg[^>]*><style>/);
  });

  test('背景色：合法颜色写进根元素，含注入字符的值丢弃', () => {
    assert.match(styleOf(themeWidgetSvg(ARCH, { theme: 'light', background: '#FBFAF6' })), /background:#FBFAF6/);
    assert.match(styleOf(themeWidgetSvg(ARCH, { theme: 'dark', background: 'rgb(28, 27, 26)' })), /background:rgb\(28, 27, 26\)/);
    const evil = themeWidgetSvg(ARCH, { theme: 'light', background: 'red}</style><script>x()</script>' });
    assert.doesNotMatch(evil, /script/);
    assert.doesNotMatch(styleOf(evil), /background/);
  });

  test('不是 svg 开头、开标签残缺、自闭合 → null', () => {
    assert.equal(themeWidgetSvg('<div></div>', { theme: 'light' }), null);
    assert.equal(themeWidgetSvg('<svg viewBox="0 0 1 1"', { theme: 'light' }), null);
    assert.equal(themeWidgetSvg('<svg viewBox="0 0 1 1"/>', { theme: 'light' }), null);
    assert.equal(themeWidgetSvg(null, { theme: 'light' }), null);
  });
});

test.describe('widgetSvgDataUri', () => {
  test('data:image/svg+xml 开头，解码后就是主题化后的 SVG', () => {
    const uri = widgetSvgDataUri(ARCH, { theme: 'dark' });
    const prefix = 'data:image/svg+xml;charset=utf-8,';
    assert.ok(uri.startsWith(prefix));
    assert.equal(decodeURIComponent(uri.slice(prefix.length)), themeWidgetSvg(ARCH, { theme: 'dark' }));
    assert.doesNotMatch(uri.slice(prefix.length), /[<>"#\s]/, '编码后不得残留会截断 URI 的字符');
  });

  test('源码不合格 → null', () => {
    assert.equal(widgetSvgDataUri('<div/>', { theme: 'light' }), null);
  });

  // 孤立代理字符能经合法的 JSON 转义（\\ud800）一路到前端；encodeURIComponent 遇到它直接抛 URIError——
  // live 路径会在工具卡插入之前抛出，历史路径会中断整块渲染、历史闸门永远关不上。必须退回，不能抛。
  test('孤立代理字符：不抛错，返回 null 走回退', () => {
    for (const code of ['<svg viewBox="0 0 1 1"><text>\ud800</text></svg>', '<svg viewBox="0 0 1 1"><text>\udfff x</text></svg>']) {
      assert.doesNotThrow(() => widgetSvgDataUri(code, { theme: 'light' }));
      assert.equal(widgetSvgDataUri(code, { theme: 'dark' }), null);
    }
    assert.ok(widgetSvgDataUri('<svg viewBox="0 0 1 1"><text>\ud83d\ude00</text></svg>', { theme: 'light' }), '成对的代理（emoji）照常出图');
  });
});

test.describe('widgetTitleText', () => {
  test('下划线标识符转成可读空格；非字符串记空串；超长截断', () => {
    assert.equal(widgetTitleText('ccm_architecture_overview'), 'ccm architecture overview');
    assert.equal(widgetTitleText(undefined), '');
    assert.equal(widgetTitleText('a'.repeat(200)).length <= 80, true);
  });
});

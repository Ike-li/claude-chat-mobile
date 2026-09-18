#!/usr/bin/env node
/**
 * demo 站构建：把主仓 dev 分支的 app/public/ 原样搬过来，只动两处。
 *
 *   1. index.html 里的绝对路径 → 相对路径
 *      产品跑在自己的 origin 根上，所以前端写的是 /js/app.js、/css/app.css。
 *      GitHub Pages 的项目站根是 /claude-chat-mobile/，绝对路径会解析到组织根上 404。
 *      <base> 标签救不了——它只影响相对路径，对 /x 无效。所以只能构建期重写。
 *      （JS 模块之间的 import 全是相对路径，一行都不用动。）
 *
 *   2. <script src="/socket.io/socket.io.js"> → demo-data.js + demo-socket.js
 *      这个文件平时由 Socket.io server 自动提供，静态站没有它，正好当注入点。
 *
 * 除此之外前端一个字节都不改——演示站展示的必须是真前端，不是它的仿制品。
 *
 * 用法：node demo/_build/build.cjs [--ref dev]
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEMO_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(DEMO_DIR, '_src');
const REPO = path.resolve(DEMO_DIR, '..');

const refArg = process.argv.indexOf('--ref');
const REF = refArg !== -1 ? process.argv[refArg + 1] : 'dev';

/** 产物之外的东西不能被清掉：_src / _build 是源码，README 是文档。 */
const KEEP = new Set(['_src', '_build', 'README.md']);

function log(msg) { process.stdout.write(`[demo-build] ${msg}\n`); }

function cleanProducts() {
  for (const name of fs.readdirSync(DEMO_DIR)) {
    if (KEEP.has(name)) continue;
    // safe-rm: 目录段由 __dirname 算出、只删 demo/ 下的上一轮构建产物，KEEP 护住源码
    fs.rmSync(path.join(DEMO_DIR, name), { recursive: true, force: true });
  }
}

function exportFrontend() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-demo-'));
  log(`从 ${REF} 导出 app/public → ${tmp}`);
  const tar = execFileSync('git', ['archive', REF, 'app/public'], {
    cwd: REPO, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer',
  });
  execFileSync('tar', ['-x', '-C', tmp], { input: tar });
  return { tmp, publicDir: path.join(tmp, 'app', 'public') };
}

/**
 * 演示站的 CSP。产品靠 server 发响应头（app/src/server/http.js 的 setSecurityHeaders），
 * 静态站发不了头，只能用 meta——**必须排在任何资源引用之前**才生效。
 *
 * 比产品更严的一格是 `connect-src 'none'`：演示站的后端是浏览器内的一层脚本，
 * 不需要任何网络连接。写死 'none' 之后「demo 不会把你输入的东西发出去」就不再
 * 依赖「shim 里没写 fetch」这个约定，而是浏览器强制执行——哪怕将来谁往 shim 里
 * 加了一行上报，它也发不出去。
 *
 * meta 形态下 frame-ancestors 会被浏览器忽略（只认响应头），GitHub Pages 又不允许
 * 自定义头，所以点击劫持这一格拿不到防护。演示站没有任何会改变状态的真实操作，
 * 这里接受该限制，不假装它被挡住了。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "font-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/**
 * CSS 里的 url(/…) 也得重写，而且和 HTML 不同：CSS 的相对路径是相对**该 CSS 文件自己**
 * 的位置，不是相对页面。css/app.css 引 /vendor/x 要写成 ../vendor/x。
 *
 * 【这条是线上才暴露的】本地验收的 server 根是 gh-pages 根，而那里**恰好也有**一份
 * 同名的 vendor/source-serif-*.woff2（landing 自己的字体），于是 /vendor/… 命中了它、
 * 返回 200。线上 ike-li.github.io/vendor/… 是组织站根、不属于本仓库 → 404。
 * 修法之外，verify.mjs 的 server 也改成只在 /claude-chat-mobile/ 前缀下服务，
 * 让本地与线上的路径语义等价——否则同形态的问题还会再发生一次。
 */
function rewriteCssUrls(css, depthFromDemoRoot) {
  const up = '../'.repeat(depthFromDemoRoot);
  return css.replace(/url\((['"]?)\/(?!\/)/g, `url($1${up}`);
}

/**
 * index.html 的三处重写。
 * 绝对路径正则只吃 ="/ 紧邻的形式，所以 https://… 的外链不会被误伤。
 */
function rewriteIndex(html) {
  let out = html.replace(/(\s(?:src|href))="\/(?!\/)/g, '$1="./');

  const headOpen = out.match(/<head[^>]*>/i);
  if (!headOpen) throw new Error('没找到 <head>——无法注入 CSP，构建中止');
  out = out.replace(headOpen[0], headOpen[0]
    + `\n  <meta http-equiv="Content-Security-Policy" content="${CSP}">`);

  const socketTag = /<script[^>]*src="\.\/socket\.io\/socket\.io\.js"[^>]*><\/script>/;
  if (!socketTag.test(out)) {
    throw new Error('没找到 socket.io 的 script 标签——前端引入方式变了，注入点失效，构建中止');
  }
  out = out.replace(socketTag,
    '<!-- 演示站：真 socket.io 客户端换成浏览器内的假后端，见 _src/demo-socket.js -->\n'
    + '  <script src="./demo-data.js"></script>\n'
    + '  <script src="./demo-socket.js"></script>\n'
    + '  <script src="./demo-overlay.js"></script>');

  return out;
}

function main() {
  const { tmp, publicDir } = exportFrontend();
  if (!fs.existsSync(publicDir)) throw new Error(`导出为空：${publicDir} 不存在`);

  cleanProducts();

  for (const name of fs.readdirSync(publicDir)) {
    fs.cpSync(path.join(publicDir, name), path.join(DEMO_DIR, name), { recursive: true });
  }

  const indexPath = path.join(DEMO_DIR, 'index.html');
  const rewritten = rewriteIndex(fs.readFileSync(indexPath, 'utf8'));
  fs.writeFileSync(indexPath, rewritten);

  // 所有 .css 里的 url(/…)：按该文件相对 demo/ 的深度算 ../ 前缀
  let cssCount = 0;
  const walkCss = (dir, depth) => {
    for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, name.name);
      if (name.isDirectory()) { walkCss(p, depth + 1); continue; }
      if (!name.name.endsWith('.css')) continue;
      const before = fs.readFileSync(p, 'utf8');
      const after = rewriteCssUrls(before, depth);
      if (after !== before) { fs.writeFileSync(p, after); cssCount += 1; }
    }
  };
  for (const name of fs.readdirSync(DEMO_DIR)) {
    if (KEEP.has(name)) continue;
    const p = path.join(DEMO_DIR, name);
    if (fs.statSync(p).isDirectory()) walkCss(p, 1);
    else if (name.endsWith('.css')) {
      const before = fs.readFileSync(p, 'utf8');
      const after = rewriteCssUrls(before, 0);
      if (after !== before) { fs.writeFileSync(p, after); cssCount += 1; }
    }
  }
  log(`重写了 ${cssCount} 个 css 里的绝对 url()`);

  for (const name of fs.readdirSync(SRC_DIR)) {
    fs.cpSync(path.join(SRC_DIR, name), path.join(DEMO_DIR, name));
  }

  // safe-rm: tmp 来自本函数上方的 mkdtempSync
  fs.rmSync(tmp, { recursive: true, force: true });

  const files = fs.readdirSync(DEMO_DIR).filter(n => !KEEP.has(n));
  log(`完成：${files.length} 个顶层条目`);
}

main();

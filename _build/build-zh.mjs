#!/usr/bin/env node
/**
 * 生成 /zh/index.html —— 首页的静态中文版。
 *
 * 为什么需要它：首页是「一份 HTML + JS 切字典」的双语实现，DOM 里的静态内容是英文，
 * 中文只在运行时注入。搜索引擎抓到的永远是英文那一份，**整站的中文内容可索引量是 0**
 * ——中文搜「Claude Code 手机」到不了这个站。hreflang 也无从谈起：它要求每种语言
 * 有各自的 URL，而这里只有一个。
 *
 * 做法：用真浏览器加载首页、切到中文、把渲染结果 dump 成静态 HTML。
 * 不用正则替换 data-i18n 节点——`data-i18n-html` 的值里有嵌套标签，
 * 正则数不对闭合位置，而数错了不会报错，只会悄悄吃掉半段文案。
 *
 * 英文首页本身一个字节不改（见 injectCrossLinks 的注释），所以本脚本可重复运行。
 *
 * 用法：node _build/build-zh.mjs
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = 'https://ike-li.github.io/claude-chat-mobile';

// gh-pages 是孤儿分支、没有自己的 node_modules。playwright 装在主工作树里，
// 位置用 git 问出来而不是写死——worktree 可以被挪走。
const MAIN_REPO = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: ROOT, encoding: 'utf8' }).trim());
const { chromium } = await import(pathToFileURL(join(MAIN_REPO, 'node_modules/playwright/index.mjs')).href);

const ZH_TITLE = 'Claude Chat Mobile — 电脑上的 Claude Code，手机上接着用';
const ZH_DESC = '自托管的手机端 Claude Code 界面：通过 Agent SDK 驱动你自己终端里的 '
  + 'claude CLI，同一个会话、同一套本机配置。为触控重排，不是投屏。';

/** dump 出来的 HTML 要做的字符串级修正。顺序有依赖，别重排。 */
function postProcess(html) {
  // 1. 去掉 i18n 脚本：内容已经静态成中文，留着只会在加载后按 localStorage 再切一次，
  //    把刚渲染好的中文又刷成英文。
  const scriptStart = html.indexOf('<script>\n  const I18N = {');
  if (scriptStart === -1) throw new Error('没找到 I18N 脚本块——首页结构变了，中止');
  const scriptEnd = html.indexOf('</script>', scriptStart);
  if (scriptEnd === -1) throw new Error('I18N 脚本块没有闭合标签，中止');
  html = html.slice(0, scriptStart) + html.slice(scriptEnd + '</script>'.length);

  // 2. 相对路径下沉一级。页面从 / 搬到 /zh/，所有 ./x 都要变 ../x。
  //    三种写法各自处理：属性、srcset 里逗号后的第二个起、CSS 的 url()。
  //    属性名清单是逐个数出来的，不是凭印象列的——第一版漏了 <video poster>，
  //    本地验收当场抓到 404。改动首页结构后要重跑验收，别只信这行正则。
  html = html.replace(/(\s(?:href|src|srcset|data-srcset|data-src|poster|content))="\.\//g, '$1="../');
  html = html.replace(/,\s*\.\//g, ', ../');
  html = html.replace(/url\(\.\//g, 'url(../');

  // 3. 语言切换器：EN 改成真链接。
  //    必须是 <a> 而不是 onclick —— 搜索引擎靠真实链接在两个语言版本间爬行，
  //    hreflang 只是提示，不传递可达性。
  html = html.replace(
    /<button data-lang="en"[^>]*>EN<\/button>/,
    '<a class="langlink" href="../" hreflang="en" lang="en">EN</a>',
  );
  html = html.replace(
    /<button data-lang="zh"[^>]*>中文<\/button>/,
    '<button class="active" aria-current="true">中文</button>',
  );
  // 上一步换出来的 <a> 要吃到 button 的那套样式
  html = html.replace(
    /\.langtoggle button \{/,
    '.langtoggle a.langlink { text-decoration:none; }\n  .langtoggle button, .langtoggle a.langlink {',
  );

  // 4. head：标题、描述、canonical、hreflang、OG 全部换成中文版的。
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${ZH_TITLE}</title>`);
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${ZH_DESC}">`,
  );
  // 英文首页自己已经有一组 hreflang，dump 时一并带了过来。先删干净再写，
  // 否则两组叠在一起 —— 同一 hreflang 值出现两次，Google 会整组忽略。
  html = html.replace(/\s*<link rel="alternate" hreflang="[^"]*" href="[^"]*">/g, '');
  html = html.replace(
    /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${SITE}/zh/">\n`
    + `<link rel="alternate" hreflang="zh-CN" href="${SITE}/zh/">\n`
    + `<link rel="alternate" hreflang="en" href="${SITE}/">\n`
    + `<link rel="alternate" hreflang="x-default" href="${SITE}/">`,
  );
  html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${ZH_TITLE}">`);
  html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${ZH_DESC}">`);
  html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${SITE}/zh/">`);
  html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${ZH_TITLE}">`);
  html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${ZH_DESC}">`);
  html = html.replace(/<meta property="og:locale" content="[^"]*">/, '');
  html = html.replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${SITE}/og-image.jpg">`);
  html = html.replace(/<meta name="twitter:image" content="[^"]*">/, `<meta name="twitter:image" content="${SITE}/og-image.jpg">`);
  html = html.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n<meta property="og:locale" content="zh_CN">');

  // 5. JSON-LD：url / description / inLanguage 指向中文版
  html = html.replace(`"url": "${SITE}/",`, `"url": "${SITE}/zh/",`);
  html = html.replace(
    /"description": "Self-hosted mobile web UI for Claude Code[^"]*",/,
    `"description": "${ZH_DESC}",`,
  );
  html = html.replace('"inLanguage": ["en", "zh-CN"]', '"inLanguage": "zh-CN"');

  return html;
}

const page = await (await chromium.launch()).newPage();
await page.goto(`file://${join(ROOT, 'index.html')}`, { waitUntil: 'load' });
await page.click('.langtoggle button[data-lang="zh"]');
await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');

const rendered = `<!DOCTYPE html>\n${await page.evaluate(() => document.documentElement.outerHTML)}\n`;
await page.context().browser().close();

// 渲染结果必须真的是中文，否则说明点击没生效而我们正要写出一份英文副本
if (!rendered.includes('手机')) throw new Error('渲染结果里没有中文——语言切换没生效，中止');

mkdirSync(join(ROOT, 'zh'), { recursive: true });
const out = postProcess(rendered);
writeFileSync(join(ROOT, 'zh', 'index.html'), out);

console.log(`zh/index.html 已生成 (${(out.length / 1024).toFixed(0)} KB)`);

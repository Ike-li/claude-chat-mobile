// 重建 sitemap.xml。
//
// lastmod 取每个页面对应文件的 git 最后提交日期，本次工作区里已改动的取今天。
// 不给全站刷同一个日期：假的新鲜度信号被识破后，整份 sitemap 的 lastmod 都会被忽略。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://ike-li.github.io/claude-chat-mobile';
const TODAY = new Date().toISOString().slice(0, 10);

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty = new Set(
  git(['status', '--porcelain'])
    .split('\n').filter(Boolean)
    .map((l) => l.slice(3).trim()),
);

// URL 路径 -> 磁盘文件
const fileFor = (urlPath) => {
  const rel = urlPath.replace(/^\//, '');
  return rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel;
};

const lastmod = (urlPath) => {
  const file = fileFor(urlPath);
  if (!existsSync(`${ROOT}/${file}`)) throw new Error(`sitemap 指向不存在的文件: ${file}`);
  if (dirty.has(file)) return TODAY;
  const d = git(['log', '-1', '--format=%cs', '--', file]);
  return d || TODAY;
};

// 站点地图的内容轴。priority 按「对陌生访客的价值」排，不是按更新频率。
const ENTRIES = [
  ['/', 'weekly', '1.0'],
  ['/zh/', 'weekly', '1.0'],
  ['/demo/', 'monthly', '0.9'],
  ['/en/compare.html', 'monthly', '0.9'],
  ['/en/quickstart.html', 'monthly', '0.9'],
  ['/en/security.html', 'monthly', '0.9'],
  ['/docs-site/', 'weekly', '0.9'],
  ['/diagrams/', 'monthly', '0.8'],
];

// 手册正文页：目录里有什么就收什么，不再手工维护清单（漏一页等于那页永不被抓）。
const HANDBOOK_HIGH = new Set(['overview', 'quickstart', 'production-deploy', 'security-model']);
for (const name of git(['ls-files', 'docs-site/pages']).split('\n')) {
  if (!name.endsWith('.html')) continue;
  const slug = name.replace('docs-site/pages/', '').replace('.html', '');
  ENTRIES.push([`/docs-site/pages/${slug}.html`, 'monthly', HANDBOOK_HIGH.has(slug) ? '0.8' : '0.6']);
}

// 架构图：13 张图 + 索引页（索引页已在上面）
for (const name of git(['ls-files', 'diagrams']).split('\n')) {
  if (!name.endsWith('.html') || name.endsWith('index.html')) continue;
  ENTRIES.push([`/${name}`, 'monthly', '0.6']);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * 页面上引用的图片，转成 sitemap 的 image 扩展。
 *
 * 只取 <img> 的 src，不取 <source srcset>：同一张图的 webp/png/多尺寸是同一个
 * 资源的不同编码，全列进去等于让 Google 把一张图当成五张去抓。
 * title 用图片自己的 alt —— 那是现成且属实的描述，另写一份只会和页面对不上。
 */
function imagesOf(urlPath) {
  const file = fileFor(urlPath);
  if (!file.endsWith('.html') || !existsSync(`${ROOT}/${file}`)) return [];
  const html = readFileSync(`${ROOT}/${file}`, 'utf8');
  const dir = urlPath.replace(/[^/]*$/, '');
  const out = new Map();
  for (const [, tag] of html.matchAll(/(<img\s[^>]*>)/g)) {
    const src = tag.match(/\ssrc="([^"]+)"/)?.[1];
    const alt = tag.match(/\salt="([^"]*)"/)?.[1];
    if (!src || src.startsWith('data:') || !alt) continue;
    // 相对路径按所在页面的目录解析；new URL 负责吃掉 ../
    const abs = new URL(src, `${BASE}${dir}`).href;
    if (!abs.startsWith(BASE)) continue;
    out.set(abs, alt);
  }
  return [...out].map(([loc, title]) => [loc, title]);
}

// 首页与中文首页上的演示视频。数据与首页 VideoObject 同源，别在这里另编一套。
const VIDEO = {
  '/': ['Driving your terminal claude CLI from a phone',
    'A reply streams in, tool cards appear inline, then a git push is approved from the phone.'],
  '/zh/': ['在手机上驾驶你终端里的 claude CLI',
    '回复流式吐出、工具卡就地展开，然后在手机上放行一次 git push。'],
};

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
  '        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"',
  '        xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">',
  ...ENTRIES.map(([p, freq, pri]) => {
    const rows = [
      '  <url>',
      `    <loc>${BASE}${p}</loc>`,
      `    <lastmod>${lastmod(p)}</lastmod>`,
      `    <changefreq>${freq}</changefreq>`,
      `    <priority>${pri}</priority>`,
    ];
    for (const [loc, title] of imagesOf(p)) {
      rows.push('    <image:image>', `      <image:loc>${esc(loc)}</image:loc>`,
        `      <image:title>${esc(title)}</image:title>`, '    </image:image>');
    }
    if (VIDEO[p]) {
      const [title, desc] = VIDEO[p];
      rows.push('    <video:video>',
        `      <video:thumbnail_loc>${BASE}/demo-poster.jpg</video:thumbnail_loc>`,
        `      <video:title>${esc(title)}</video:title>`,
        `      <video:description>${esc(desc)}</video:description>`,
        `      <video:content_loc>${BASE}/demo.mp4</video:content_loc>`,
        '      <video:duration>25</video:duration>',
        '      <video:family_friendly>yes</video:family_friendly>',
        '    </video:video>');
    }
    rows.push('  </url>');
    return rows.join('\n');
  }),
  '</urlset>',
  '',
].join('\n');

const before = readFileSync(`${ROOT}/sitemap.xml`, 'utf8');
writeFileSync(`${ROOT}/sitemap.xml`, xml);

const count = (s) => (s.match(/<loc>/g) || []).length;
console.log(`loc: ${count(before)} → ${count(xml)}`);

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

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...ENTRIES.map(([p, freq, pri]) => [
    '  <url>',
    `    <loc>${BASE}${p}</loc>`,
    `    <lastmod>${lastmod(p)}</lastmod>`,
    `    <changefreq>${freq}</changefreq>`,
    `    <priority>${pri}</priority>`,
    '  </url>',
  ].join('\n')),
  '</urlset>',
  '',
].join('\n');

const before = readFileSync(`${ROOT}/sitemap.xml`, 'utf8');
writeFileSync(`${ROOT}/sitemap.xml`, xml);

const count = (s) => (s.match(/<loc>/g) || []).length;
console.log(`loc: ${count(before)} → ${count(xml)}`);

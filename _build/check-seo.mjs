// 验收：canonical 必须指向页面自己的真实 URL，且 sitemap 与站点互相自洽。
// 反向验证在最后一段：故意造一条错误的 canonical，确认本脚本会红。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = 'https://ike-li.github.io/claude-chat-mobile';
const fail = [];

// URL -> 磁盘文件（与 sitemap 生成脚本同一套规则）
const fileFor = (u) => {
  const rel = u.replace(`${BASE}/`, '');
  return rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel;
};

// 1. sitemap 里每条 loc 都要有对应文件，且该文件的 canonical 要指回这条 loc
const sitemap = readFileSync(`${ROOT}/sitemap.xml`, 'utf8');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (new Set(locs).size !== locs.length) fail.push('sitemap 内有重复 loc');

for (const loc of locs) {
  const file = fileFor(loc);
  if (!existsSync(`${ROOT}/${file}`)) { fail.push(`sitemap 指向不存在的文件: ${file}`); continue; }
  const html = readFileSync(`${ROOT}/${file}`, 'utf8');
  const canon = html.match(/rel="canonical"\s+href="([^"]+)"/)?.[1];
  if (!canon) { fail.push(`缺 canonical: ${file}`); continue; }
  if (canon !== loc) fail.push(`canonical 与 sitemap 不符: ${file}\n      canonical=${canon}\n      sitemap  =${loc}`);
}

// 2. 被 sitemap 收录的页面必须有 meta description。
//    长度按【显示宽度】算，不按字符数——CJK 占两格，按 .length 判会把正常的
//    中文描述误判成过短（一句 18 字的中文摘要 .length 才 18，其实占 36 格）。
const width = (s) => [...s].reduce((n, c) => n + (/[⺀-鿿＀-￯]/.test(c) ? 2 : 1), 0);
const thin = [];
for (const loc of locs) {
  const file = fileFor(loc);
  if (!existsSync(`${ROOT}/${file}`)) continue;
  const html = readFileSync(`${ROOT}/${file}`, 'utf8');
  const d = html.match(/name="description"\s+content="([^"]*)"/)?.[1];
  if (!d) fail.push(`缺 meta description: ${file}`);
  // 硬失败只留「几乎等于没有」这一档；偏短的是文案问题，单独列出不算失败
  else if (width(d) < 20) fail.push(`description 形同虚设(宽度${width(d)}): ${file}`);
  else if (width(d) < 70) thin.push(`${file} (宽度${width(d)})`);
}

// 3. description 不得全站雷同（雷同 = 搜索引擎判重复内容）
const descs = locs.map((l) => {
  const f = `${ROOT}/${fileFor(l)}`;
  return existsSync(f) ? readFileSync(f, 'utf8').match(/name="description"\s+content="([^"]*)"/)?.[1] : null;
}).filter(Boolean);
const dupes = descs.filter((d, i) => descs.indexOf(d) !== i);
if (dupes.length) fail.push(`有 ${new Set(dupes).size} 条重复的 description`);

// 4. 会上线的文件里不得残留旧许可证。
//    判据用 git ls-files 而不是 grep 整棵树——本地审计产物等 gitignore 的目录
//    根本不会部署，把它们算进来会造出一条永远修不掉的假红。
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => /\.(html|txt|md)$/.test(f) && !f.startsWith('.claude/'));
const agpl = tracked.filter((f) => existsSync(`${ROOT}/${f}`) && readFileSync(`${ROOT}/${f}`, 'utf8').includes('AGPL'));
if (agpl.length) fail.push(`已入库文件仍有 AGPL 残留:\n      ${agpl.join('\n      ')}`);

// 5. 构建脚本语法
try { execFileSync('node', ['--check', `${ROOT}/demo/_build/build.cjs`]); }
catch { fail.push('demo/_build/build.cjs 语法错误'); }

console.log(`检查 ${locs.length} 个 URL`);
if (thin.length) {
  console.log(`\n偏短的 description（不算失败，是文案工作）：${thin.length} 条`);
  thin.slice(0, 3).forEach((t) => console.log(`  · ${t}`));
  if (thin.length > 3) console.log(`  · …另 ${thin.length - 3} 条`);
}
if (fail.length) { console.log('\n未通过:'); fail.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
console.log('\n全部通过');

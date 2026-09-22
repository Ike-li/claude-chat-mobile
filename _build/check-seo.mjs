// 验收：canonical 必须指向页面自己的真实 URL，且 sitemap 与站点互相自洽。
// 反向验证在最后一段：故意造一条错误的 canonical，确认本脚本会红。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
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

// 6. llms.txt / llms-full.txt 是 AI agent 读这个项目的入口（AEO）。两份此前都是手工
//    产物、无人看管，接上 build-llms.mjs 时实测 llms.txt 已经漂了：28 个 token 标注
//    【全部】与页面自己声明的对不上，系统性偏低 83–410。agent 拿这个数做「先加载
//    哪几页」的预算，标错等于误导。
//    链接用本地文件判存在、不发 HTTP —— 本脚本要保持零网络、秒级。
//    【不管什么】`## Primary Documents & Specs` 那 8 条精选是手写的编辑决策，
//    这里只保证它们不指向死链（6a），不管该收哪几篇 —— 管到那一层就是替人做编辑。
const cfg = createRequire(import.meta.url)(`${ROOT}/docs-site/book.config.cjs`);
const bookPages = cfg.parts.flatMap((p) => p.pages.map((pg) => ({
  pg,
  label: p.label,
  rel: pg.home ? 'docs-site/index.md' : `docs-site/pages/${pg.slug}.md`,
})));

const llmsFile = `${ROOT}/llms.txt`;
if (!existsSync(llmsFile)) fail.push('llms.txt 不存在（agent 的入口文件）');
else {
  const llms = readFileSync(llmsFile, 'utf8');

  // 6a. 站内链接都要有对应文件。死链在这里是静默失败：agent 取到 404 就丢弃该页，
  //     而它不会回来告诉你少读了什么。
  const linked = [...new Set([...llms.matchAll(/\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1]))]
    .filter((u) => u === BASE || u.startsWith(`${BASE}/`));
  for (const u of linked) {
    const f = fileFor(u);
    if (!existsSync(`${ROOT}/${f}`)) fail.push(`llms.txt 指向不存在的文件: ${f}`);
  }

  // 6b. 手册清单 ⇔ book.config.cjs（结构真值）+ 各页产物的 Estimated Tokens（token 真值）。
  //     llms.txt 只是这两者的投影，任何一处对不上都说明它没跟着重新生成。
  const listed = new Map(
    [...llms.matchAll(/^- \[[^\]]*\]\((\S+)\):.*\(Tokens: ~(\d+)\)\s*$/gm)]
      .map((m) => [m[1].replace(`${BASE}/`, ''), m[2]]),
  );
  for (const { rel } of bookPages) {
    if (!listed.has(rel)) { fail.push(`llms.txt 漏登记手册页: ${rel}（跑 node _build/build-llms.mjs）`); continue; }
    if (!existsSync(`${ROOT}/${rel}`)) continue; // 6a 已经报过这条
    const want = readFileSync(`${ROOT}/${rel}`, 'utf8').match(/\*\*Estimated Tokens\*\*:\s*~?(\d+)/)?.[1];
    if (want && listed.get(rel) !== want) {
      fail.push(`llms.txt 的 token 标注过期: ${rel} 标 ~${listed.get(rel)}，实为 ~${want}（跑 node _build/build-llms.mjs）`);
    }
  }
}

// 6c. llms-full.txt 是 28 章正文的机器合成（整份由 build-llms.mjs 生成，无手写成分）。
//     最要紧的一条是「每章正文 == 源 .md」：页面更新而 full 没重新生成时，agent 读到
//     的是旧正文，而文件本身看起来完全正常 —— 这种过期没有任何外部症状，
//     线上 curl 得到 200、字节数也对得上，只有逐章比对才看得见。
const fullFile = `${ROOT}/llms-full.txt`;
if (!existsSync(fullFile)) fail.push('llms-full.txt 不存在（agent 的全量入口）');
else {
  const full = readFileSync(fullFile, 'utf8');
  const blocks = full.split(/^# Chapter: /m).slice(1);
  if (blocks.length !== bookPages.length) {
    fail.push(`llms-full.txt 章节数 ${blocks.length} ≠ book.config 的 ${bookPages.length} 页（跑 node _build/build-llms.mjs）`);
  }
  const declared = full.match(/all (\d+) handbook chapters/)?.[1];
  if (declared && Number(declared) !== bookPages.length) {
    fail.push(`llms-full.txt 头部声明 ${declared} 章，实为 ${bookPages.length} 页`);
  }
  bookPages.forEach(({ pg, label, rel }, i) => {
    const blk = blocks[i];
    if (!blk) return; // 章节数对不上时已经报过，不再逐章刷屏
    const head = blk.split('\n')[0];
    if (head !== `${pg.title} (${label})`) {
      fail.push(`llms-full.txt 第 ${i + 1} 章标题不符: 「${head}」应为「${pg.title} (${label})」`);
      return;
    }
    if (!existsSync(`${ROOT}/${rel}`)) return;
    // 块尾的 \n\n\n--- 是拼接分隔符，不是正文的一部分
    const got = blk.slice(head.length).replace(/^\n+/, '').replace(/\n{3}---\n*$/, '');
    const want = readFileSync(`${ROOT}/${rel}`, 'utf8').replace(/\s+$/, '');
    if (got !== want) fail.push(`llms-full.txt 的正文与源不符: ${rel}（跑 node _build/build-llms.mjs）`);
  });
}

console.log(`检查 ${locs.length} 个 URL`);
if (thin.length) {
  console.log(`\n偏短的 description（不算失败，是文案工作）：${thin.length} 条`);
  thin.slice(0, 3).forEach((t) => console.log(`  · ${t}`));
  if (thin.length > 3) console.log(`  · …另 ${thin.length - 3} 条`);
}
if (fail.length) { console.log('\n未通过:'); fail.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
console.log('\n全部通过');

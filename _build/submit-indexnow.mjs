#!/usr/bin/env node
/**
 * 把 sitemap 里的 URL 提交给 IndexNow（Bing / Yandex / Seznam 共用一个端点）。
 *
 * 为什么用它：GitHub 上所有外链都是 nofollow，Pages 站几乎拿不到自然入口，
 * 光有 sitemap 也要等爬虫自己来。IndexNow 是主动推送，而且**不需要账号验证**
 * ——站点根放一个 key 文件就算证明所有权。Google 不在这条链上（它只认
 * Search Console，必须人工），所以这条是补充，不是替代。
 *
 * 前提：key 文件必须已经部署上线且可访问，否则整批提交被判无效所有权。
 * 所以本脚本会先自己 curl 一次 key 文件，拿不到就中止。
 *
 * 用法：node _build/submit-indexnow.mjs [--dry-run]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST = 'ike-li.github.io';
const BASE = `https://${HOST}/claude-chat-mobile`;
const DRY = process.argv.includes('--dry-run');

const keyFile = readdirSync(ROOT).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) throw new Error('站点根没有 IndexNow key 文件（形如 <32位十六进制>.txt）');
const key = keyFile.replace('.txt', '');
if (readFileSync(join(ROOT, keyFile), 'utf8').trim() !== key) {
  throw new Error('key 文件的内容必须与文件名（去掉 .txt）逐字相同');
}

const keyUrl = `${BASE}/${keyFile}`;
const probe = await fetch(keyUrl).catch(() => null);
if (!probe?.ok) {
  console.error(`key 文件线上取不到：${keyUrl} → ${probe ? probe.status : '请求失败'}`);
  console.error('gh-pages 还没部署或还没生效。等 Pages 构建完再跑。');
  process.exit(1);
}
if ((await probe.text()).trim() !== key) throw new Error('线上 key 文件内容与本地不符');

const urlList = [...readFileSync(join(ROOT, 'sitemap.xml'), 'utf8')
  .matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

console.log(`key 已验证：${keyUrl}`);
console.log(`待提交 ${urlList.length} 个 URL`);
if (DRY) { console.log('(--dry-run，未实际提交)'); process.exit(0); }

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key, keyLocation: keyUrl, urlList }),
});

// IndexNow 的 200/202 都算受理；422 通常是 key 或 host 对不上
console.log(`IndexNow 响应：${res.status} ${res.statusText}`);
const body = await res.text();
if (body) console.log(body.slice(0, 400));
process.exit(res.status === 200 || res.status === 202 ? 0 : 1);

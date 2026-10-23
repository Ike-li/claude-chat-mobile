// about.js —— 设置「关于」页（#303）的数据：作者、仓库、许可证原文、第三方组件清单。版本号不在这里，
// 前端复用 service:status 的 versions（同一份查询，「宿主机」页与「关于」页不会各说一个数）。
//
// 许可证原样读出、原样下发：不改写、不翻译，前端也只用 textContent 放进去。
//
// 组件清单按「实际分发」算，不拿 dependencies 减 devDependencies：装机是 `npm ci --omit=dev`，分发出去的是
// 锁文件里的非 dev 条目（含间接依赖），且只算本机真装上了的——别的平台的可选包锁文件里有、磁盘上没有。
// 浏览器端的 Socket.IO 客户端是服务端从 socket.io 包里吐出的 /socket.io/socket.io.js，发到手机上运行，
// 不在 vendor 目录、也不是一个独立安装的包，单列一条。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件在 app/src/ops/，仓库根是三层向上（少一层会落到 app/ 下，且不报错）
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function readJson(path) {
  const text = readText(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// npm 的 person 字符串：'Name <email> (url)'，email 与 url 都可省
function personOf(author) {
  if (author && typeof author === 'object') return { name: author.name ?? null, url: author.url ?? null };
  const m = /^([^<(]*?)\s*(?:<[^>]*>)?\s*(?:\(([^)]*)\))?\s*$/.exec(String(author ?? ''));
  return { name: m?.[1] || null, url: m?.[2] || null };
}

function repositoryUrlOf(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return null;
  return String(raw).replace(/^git\+/, '').replace(/\.git$/, '');
}

function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map(l => l?.type ?? l).filter(Boolean).join(' OR ') || null;
  return null;
}

function socketIoBrowserClient(rootDir) {
  const head = readText(join(rootDir, 'node_modules/socket.io/client-dist/socket.io.js'))?.slice(0, 400);
  const version = head && /Socket\.IO v(\d+\.\d+\.\d+)/.exec(head)?.[1];
  if (!version) return null;
  return { name: 'socket.io-client', version, license: /Released under the (\S+) License/.exec(head)?.[1] ?? null, scope: 'browser' };
}

function listComponents(rootDir) {
  const lock = readJson(join(rootDir, 'package-lock.json'));
  const out = [];
  const seen = new Set();
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (!path || entry?.dev || entry?.link) continue;
    const pkg = readJson(join(rootDir, path, 'package.json'));
    if (!pkg) continue; // 锁文件里有、本机没装（别的平台的可选包）
    const name = pkg.name || path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const id = `${name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name, version: pkg.version ?? null, license: licenseOf(pkg), scope: 'server' });
  }
  const client = socketIoBrowserClient(rootDir);
  if (client) out.push(client);
  return out.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
}

export function readAboutInfo({ rootDir }) {
  const pkg = readJson(join(rootDir, 'package.json')) ?? {};
  return {
    ok: true,
    author: personOf(pkg.author),
    repository: repositoryUrlOf(pkg.repository),
    license: readText(join(rootDir, 'LICENSE')),
    notice: readText(join(rootDir, 'NOTICE')),
    thirdPartyNotices: readText(join(rootDir, 'app/public/vendor/THIRD-PARTY-NOTICES.md')),
    components: listComponents(rootDir),
  };
}

// server 用的那一份：原文与组件清单在进程生命周期内不变，首次请求时读一次
let cached = null;
export function aboutInfo() {
  return (cached ??= readAboutInfo({ rootDir: REPO_ROOT }));
}

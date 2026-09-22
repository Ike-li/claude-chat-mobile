// cf-access.js —— Cloudflare Access JWT 校验（纵深防御）。
// 经隧道的公网请求（Host = CF_ACCESS_HOSTNAME）强制带合法 Access JWT；LAN/本机（其他 Host）回退 AUTH_TOKEN。
// CF_ACCESS_HOSTNAME/TEAM/AUD 三者缺一则整层关闭（isPublicHost 恒 false、全回退 token），向后兼容。
// 支持本地缓存（cf-access-certs.json）与优雅超时/冷却退避，彻底防御由于网络超时、DNS 无法访问、或恶意刷 key 导致的 Socket 卡死崩溃。

import { decodeProtectedHeader, jwtVerify, createLocalJWKSet } from 'jose';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';
import { dataFile } from '../shared/data-dir.js';
import { isBareHostname } from '../shared/public-target.js';

// CCM_DATA_DIR 是受支持的状态根——同 devices.js/sessions.js；生产迁出仓库，测试/探测隔离真实证书缓存。
// （否则任何跑 initCfAccess 的测试会真发网络拉取并覆盖生产 cf-access-certs.json）。
const CACHE_FILE = dataFile('cf-access-certs.json');

let hostname = '';   // 公网主机名（小写、无端口）
let issuer = '';     // https://<team>.cloudflareaccess.com
let aud = '';        // Access 应用 Application Audience (AUD) tag
let enabled = false;

let localJwks = null;         // 内存中的 JWKS JSON 对象
let localResolver = null;     // jose 本地 Key Set 查找解析器
let lastFetchTime = 0;        // 上次远程拉取的时间戳（防止短时间内恶意刷未知 kid 导致频繁网络调用）
const FETCH_COOLDOWN_MS = 30000; // 30 秒网络拉取冷却时间
// 证书拉取超时：经本地代理出网时实测 ~2.5s，2s 必超 → 启动拉证书失败致公网 fail-closed 锁死。
// 与 ntfy 的 NTFY_TIMEOUT_MS 同为 8s，但是两件独立的事（证书 vs 推送），不抽共享常量——改一边不该牵动另一边。
const CERTS_FETCH_TIMEOUT_MS = 8000;

// 从本地文件中加载缓存的 JWKS 密钥
function loadLocalJwks() {
  try {
    const raw = readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.keys)) {
      localJwks = data;
      localResolver = createLocalJWKSet(localJwks);
      console.log(`[cf-access] 成功载入本地缓存的 Cloudflare Access 证书（含 ${localJwks.keys.length} 个密钥）。`);
      return true;
    }
  } catch (e) {
    // 缓存不存在或损坏不报错，由后续使用时或后台拉取补充
  }
  return false;
}

// 远程拉取最新 JWKS，带超时，拉取成功后会持久化到本地
async function fetchRemoteJwks() {
  const now = Date.now();
  if (now - lastFetchTime < FETCH_COOLDOWN_MS) {
    console.log(`[cf-access] 距离上次同步小于 ${FETCH_COOLDOWN_MS / 1000} 秒，跳过此次网络拉取。`);
    return false;
  }
  lastFetchTime = now;

  const url = `${issuer}/cdn-cgi/access/certs`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CERTS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      throw new Error(`HTTP 异常: ${res.status}`);
    }
    const data = await res.json();
    if (data && Array.isArray(data.keys)) {
      localJwks = data;
      localResolver = createLocalJWKSet(localJwks);
      
      try {
        mkdirSync(dirname(CACHE_FILE), { recursive: true });
        writeOwnerOnlyFile(CACHE_FILE, JSON.stringify(data, null, 2));
        console.log(`[cf-access] 成功从 ${url} 获取最新证书并保存到本地。`);
      } catch (err) {
        console.warn(`[cf-access] 缓存证书写入文件失败: ${err.message}`);
      }
      return true;
    }
    throw new Error('JWKS 格式非法');
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`[cf-access] 拉取远程证书失败 (url: ${url})，将使用本地缓存: ${err.message}`);
    return false;
  }
}

// 「三项 env 齐全」这条启用判据本身。导出给不方便调 initCfAccess 的场合——
// scripts/qr.js 只想知道「公网二维码该不该带令牌」，不该为这一个布尔值去拉 JWKS、发网络请求。
// initCfAccess 内部也用它：判据只此一份，否则两处迟早各判出一套结论，
// 而那种漂移的表现是「二维码扫开进不去」，没有任何报错指向真因。
export function accessConfigured(env = process.env) {
  // CF_ACCESS_HOSTNAME 必须是裸域名——isPublicHost 只比较 host.split(':')[0]，一个带
  // scheme/端口/路径的值永远比不出相等，Access 层会静默永远不触发。判「配没配」时就拒绝
  // 这种形态，比等到 isPublicHost 比对失败更早暴露问题：不视为已配置，enabled=false，
  // 而不是让横幅打出「已启用」却在第一次真实请求时才发现从未生效过。
  return !!(
    isBareHostname(env.CF_ACCESS_HOSTNAME)
    && (env.CF_ACCESS_TEAM || '').trim()
    && (env.CF_ACCESS_AUD || '').trim()
  );
}

// 在 server.js dotenv 规整后调用。返回是否启用（三项 env 齐全）。
export function initCfAccess() {
  hostname = (process.env.CF_ACCESS_HOSTNAME || '').trim().toLowerCase();
  aud = (process.env.CF_ACCESS_AUD || '').trim();
  const team = (process.env.CF_ACCESS_TEAM || '').trim();
  enabled = accessConfigured();
  
  if (!enabled) {
    localJwks = null;
    localResolver = null;
    return false;
  }
  
  const teamDomain = team.includes('.') ? team : `${team}.cloudflareaccess.com`;
  issuer = `https://${teamDomain}`;
  
  // 1. 同步加载本地缓存
  loadLocalJwks();
  // 2. 异步后台同步，绝不阻塞启动/重新载入
  fetchRemoteJwks().catch(() => {});
  
  return true;
}

export const isAccessEnabled = () => enabled;

// 该请求是否经 CF 隧道（= 公网）——以 Host 判定。CF 按域名路由，外部无法用别 Host 经 CF 进来；
// 关闭时恒 false（所有请求走 token 路 = 改造前行为）。
export function isPublicHost(host) {
  if (!enabled || !host) return false;
  return String(host).split(':')[0].toLowerCase() === hostname;
}

// 校验 Access JWT：成功返回 payload，失败抛错（调用方据此 fail-closed 拒绝、绝不回退 token）。
// 校 issuer（团队）+ audience（本应用 AUD tag，防同团队别应用的 JWT 重放）+ 默认 exp。
export async function verifyAccessJwt(token) {
  if (!enabled) throw new Error('cf-access not enabled');
  if (!token) throw new Error('missing Cf-Access-Jwt-Assertion header');

  let kid;
  try {
    const header = decodeProtectedHeader(token);
    kid = header.kid;
  } catch (err) {
    throw new Error(`Invalid JWT header: ${err.message}`, { cause: err });
  }

  // 如果本地有缓存但没有此 kid，或者完全没有缓存，尝试远程更新
  const hasKid = localJwks && localJwks.keys.some(k => k.kid === kid);
  if (!hasKid) {
    console.log(`[cf-access] 本地未缓存 Key ID "${kid}"，尝试拉取最新证书...`);
    await fetchRemoteJwks();
  }

  if (!localResolver) {
    throw new Error('Cloudflare Access certificates are not available (network unreachable and no local cache)');
  }

  // 100% 本地运算进行 JWT 签名验证，零网络开销
  //
  // 【为什么不写 algorithms】看着像少了一道 alg confusion 防护（拿 RSA 公钥的 modulus 当 HMAC
  // secret 去签 HS256，kid 仍指向同一把 key），实测不是这么回事：createLocalJWKSet 解析出的是
  // 非对称 KeyObject，jose 在选 key 那一步就拒了。2026-09-17 安全审查实验——伪造 token 头
  // { alg: 'HS256', kid: 'k1' } 得到 `ERR_JOSE_NOT_SUPPORTED: Unsupported "alg" value for a
  // JSON Web Key Set`；同一装置下合法 RS256 正常返回 payload（对照组，证明实验有区分度）。
  //
  // 补上去是零安全增量，却有两处代价：① 写不出一条会变红的测试——两侧都绿正是 docs/testing.md
  // 点名的假绿形态；② CF 若在某些配置下改签 ES256，写死 ['RS256'] 会让用户突然登不进去，
  // 失败方向从"挡住伪造"变成可用性事故。**下次审查看到这里别再提，先重跑上面那个实验。**
  const { payload } = await jwtVerify(token, localResolver, { issuer, audience: aud });
  return payload;
}

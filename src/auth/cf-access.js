// cf-access.js —— Cloudflare Access JWT 校验（纵深防御）。
// 经隧道的公网请求（Host = CF_ACCESS_HOSTNAME）强制带合法 Access JWT；LAN/本机（其他 Host）回退 AUTH_TOKEN。
// CF_ACCESS_HOSTNAME/TEAM/AUD 三者缺一则整层关闭（isPublicHost 恒 false、全回退 token），向后兼容。
// 支持本地缓存（cf-access-certs.json）与优雅超时/冷却退避，彻底防御由于网络超时、DNS 无法访问、或恶意刷 key 导致的 Socket 卡死崩溃。

import { decodeProtectedHeader, jwtVerify, createLocalJWKSet } from 'jose';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeOwnerOnlyFile } from '../files/file-security.js';

const HERE = import.meta.dirname;
// CCM_DATA_DIR 是受支持的状态根——同 devices.js/sessions.js；生产迁出仓库，测试/探测隔离真实证书缓存。
// （否则任何跑 initCfAccess 的测试会真发网络拉取并覆盖生产 cf-access-certs.json）。
const CACHE_FILE = join(process.env.CCM_DATA_DIR || join(HERE, '..', '..', 'data'), 'cf-access-certs.json');

let hostname = '';   // 公网主机名（小写、无端口）
let issuer = '';     // https://<team>.cloudflareaccess.com
let aud = '';        // Access 应用 Application Audience (AUD) tag
let enabled = false;

let localJwks = null;         // 内存中的 JWKS JSON 对象
let localResolver = null;     // jose 本地 Key Set 查找解析器
let lastFetchTime = 0;        // 上次远程拉取的时间戳（防止短时间内恶意刷未知 kid 导致频繁网络调用）
const FETCH_COOLDOWN_MS = 30000; // 30 秒网络拉取冷却时间

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

// 远程拉取最新 JWKS，带有 2 秒超时，拉取成功后会持久化到本地
async function fetchRemoteJwks() {
  const now = Date.now();
  if (now - lastFetchTime < FETCH_COOLDOWN_MS) {
    console.log(`[cf-access] 距离上次同步小于 ${FETCH_COOLDOWN_MS / 1000} 秒，跳过此次网络拉取。`);
    return false;
  }
  lastFetchTime = now;

  const url = `${issuer}/cdn-cgi/access/certs`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8s 超时：Clash 直连裸拉实测~2.5s，2s 必超→启动拉证书失败致公网 fail-closed 锁死

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

// 在 server.js dotenv 规整后调用。返回是否启用（三项 env 齐全）。
export function initCfAccess() {
  hostname = (process.env.CF_ACCESS_HOSTNAME || '').trim().toLowerCase();
  const team = (process.env.CF_ACCESS_TEAM || '').trim();
  aud = (process.env.CF_ACCESS_AUD || '').trim();
  enabled = !!(hostname && team && aud);
  
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
    throw new Error(`Invalid JWT header: ${err.message}`);
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
  const { payload } = await jwtVerify(token, localResolver, { issuer, audience: aud });
  return payload;
}

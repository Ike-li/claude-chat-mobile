// update-check.js —— 设置「关于」页的「检查更新」（#303）：服务端查 GitHub 最新 release，与本地版本比较。
//
// 请求从服务端发（手机上的页面不直接打 GitHub），前端经 socket 取结果。GitHub 未鉴权请求每小时只有 60 次，
// 所以结果要缓存、并发要合并成一次；失败也缓存一小段，免得连点几下把额度打光。超时要真的中止请求，
// 只丢弃结果的话挂住的连接会一直攒着。任何失败都收成 { ok: false }，不抛：检查失败不能拖垮「关于」页。
//
// 只比较、不更新：手机端一键更新等于远程触发「拉代码 → 装依赖 → 重启自己」，失败了手机上救不回来（Issue #303「明确不做」）。

const DEFAULT_REPO = 'Ike-li/claude-chat-mobile';

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

// a 与 b 的先后：-1（a 旧）/ 0 / 1（a 新）；任一读不出 major.minor.patch 时 null。
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

const STATUS = { [-1]: 'newer', 0: 'same', 1: 'ahead' }; // 以本地为主语：-1 = 本地旧 = GitHub 上有新版

export function createUpdateChecker({
  currentVersion,
  repo = DEFAULT_REPO,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 5_000,
  ttlMs = 30 * 60_000,
  failureTtlMs = 2 * 60_000,
} = {}) {
  let cached = null; // { result, expiresAt }
  let inflight = null;
  const releasesPage = `https://github.com/${repo}/releases`;

  async function query() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-chat-mobile-update-check' },
      });
      if (!res.ok) return { ok: false, error: 'check_failed' };
      const body = await res.json();
      const order = compareVersions(currentVersion, body?.tag_name);
      if (order === null) return { ok: false, error: 'check_failed' };
      return {
        ok: true,
        status: STATUS[order],
        current: currentVersion,
        latest: String(body.tag_name).replace(/^v/, ''),
        // 会被前端放进 href：只认本仓 Releases 下的地址，别的一律退回列表页
        releaseUrl: typeof body.html_url === 'string' && body.html_url.startsWith(`${releasesPage}/`) ? body.html_url : releasesPage,
      };
    } catch {
      return { ok: false, error: 'check_failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  function check() {
    if (cached && now() < cached.expiresAt) return Promise.resolve(cached.result);
    if (inflight) return inflight;
    inflight = query().then(result => {
      cached = { result, expiresAt: now() + (result.ok ? ttlMs : failureTtlMs) };
      inflight = null;
      return result;
    });
    return inflight;
  }

  return { check };
}

// server 全局共用一份：几台设备一起点也只打一次 GitHub、共用缓存。版本取首次调用时传入的
// （preflight 读到的 versions.server，进程生命周期内不变）。
let defaultChecker = null;
export function checkForUpdate(currentVersion) {
  defaultChecker ??= createUpdateChecker({ currentVersion });
  return defaultChecker.check();
}

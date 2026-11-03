// tests/unit/update-check.test.mjs —— 设置「关于」页的「检查更新」（#303）：服务端查 GitHub 最新 release 与本地版本比较。
// GitHub 是外部边界，fetch 与时钟注入；比较结果三种（有新版 / 已是最新 / 本地领先）、超时、缓存、并发合并各一条。
// 未鉴权请求每小时只有 60 次，所以缓存与合并是硬要求，不是优化。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateChecker, compareVersions } from '../../app/src/ops/update-check.js';

const RELEASES = 'https://github.com/Ike-li/claude-chat-mobile/releases';

function fakeGitHub(tag, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ tag_name: tag, html_url: `${RELEASES}/tag/${tag}` }),
    };
  };
  return { fetchImpl, calls };
}

test.describe('compareVersions', () => {
  test('按 major.minor.patch 数值比，tag 前缀 v 忽略；读不出来的给 null', () => {
    assert.equal(compareVersions('1.13.0', 'v1.14.0'), -1);
    assert.equal(compareVersions('1.13.0', 'v1.13.0'), 0);
    assert.equal(compareVersions('1.13.0', '1.9.9'), 1, '按数值比，不按字符串比（13 > 9）');
    assert.equal(compareVersions('1.13.0', 'nightly'), null);
  });
});

test.describe('createUpdateChecker：三种比较结果', () => {
  for (const [tag, status] of [['v1.14.0', 'newer'], ['v1.13.0', 'same'], ['v1.12.1', 'ahead']]) {
    test(`本地 1.13.0、GitHub 最新 ${tag} → ${status}`, async () => {
      const gh = fakeGitHub(tag);
      const checker = createUpdateChecker({ currentVersion: '1.13.0', fetchImpl: gh.fetchImpl });
      const res = await checker.check();
      assert.deepEqual(res, {
        ok: true, status, current: '1.13.0', latest: tag.slice(1), releaseUrl: `${RELEASES}/tag/${tag}`,
      });
      assert.equal(gh.calls[0].url, 'https://api.github.com/repos/Ike-li/claude-chat-mobile/releases/latest');
      assert.ok(gh.calls[0].init.headers['User-Agent'], 'GitHub API 不带 User-Agent 直接 403');
    });
  }
});

test.describe('createUpdateChecker：失败、超时、缓存、并发合并', () => {
  test('GitHub 回非 2xx 或 tag 读不出来 → 检查失败，不抛', async () => {
    for (const gh of [fakeGitHub('v1.14.0', { status: 403 }), fakeGitHub('nightly')]) {
      const res = await createUpdateChecker({ currentVersion: '1.13.0', fetchImpl: gh.fetchImpl }).check();
      assert.deepEqual(res, { ok: false, error: 'check_failed' });
    }
  });

  test('Release 链接只认本仓在 github.com 上的地址，别的一律换成 Releases 列表页（它会被放进 href）', async () => {
    for (const html_url of ['javascript:alert(1)', 'https://evil.example/claude-chat-mobile/releases/tag/v1.14.0', 42]) {
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.14.0', html_url }) });
      const res = await createUpdateChecker({ currentVersion: '1.13.0', fetchImpl }).check();
      assert.equal(res.releaseUrl, RELEASES, String(html_url));
    }
  });

  test('超时：请求挂住不回 → 到点按检查失败收场，并真的中止那个请求', async () => {
    let aborted = false;
    const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    });
    const res = await createUpdateChecker({ currentVersion: '1.13.0', fetchImpl, timeoutMs: 20 }).check();
    assert.deepEqual(res, { ok: false, error: 'check_failed' });
    assert.equal(aborted, true, '只丢弃结果不中止请求的话，挂住的连接会一直攒着');
  });

  test('命中缓存：有效期内第二次不打 GitHub；过期后重新查', async () => {
    let now = 1_000_000;
    const gh = fakeGitHub('v1.14.0');
    const checker = createUpdateChecker({ currentVersion: '1.13.0', fetchImpl: gh.fetchImpl, now: () => now, ttlMs: 60_000 });
    await checker.check();
    now += 59_000;
    assert.equal((await checker.check()).status, 'newer');
    assert.equal(gh.calls.length, 1, '有效期内又打了一次 GitHub');
    now += 2_000;
    await checker.check();
    assert.equal(gh.calls.length, 2, '过期后没重新查，「有新版」会一直停在旧结论上');
  });

  test('失败也缓存一小段（别连点几下就把每小时 60 次打光），过了再查', async () => {
    let now = 1_000_000;
    const gh = fakeGitHub('v1.14.0', { status: 500 });
    const checker = createUpdateChecker({ currentVersion: '1.13.0', fetchImpl: gh.fetchImpl, now: () => now, failureTtlMs: 30_000 });
    await checker.check();
    await checker.check();
    assert.equal(gh.calls.length, 1);
    now += 31_000;
    await checker.check();
    assert.equal(gh.calls.length, 2);
  });

  test('并发合并：同一时刻几台设备一起点，只打一次 GitHub，大家拿到同一份结果', async () => {
    let release;
    const calls = [];
    const fetchImpl = url => {
      calls.push(url);
      return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.14.0', html_url: `${RELEASES}/tag/v1.14.0` }) }); });
    };
    const checker = createUpdateChecker({ currentVersion: '1.13.0', fetchImpl });
    const pending = [checker.check(), checker.check(), checker.check()];
    await new Promise(r => setImmediate(r));
    release();
    const results = await Promise.all(pending);
    assert.equal(calls.length, 1);
    assert.deepEqual(results.map(r => r.status), ['newer', 'newer', 'newer']);
  });
});

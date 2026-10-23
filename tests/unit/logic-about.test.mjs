// tests/unit/logic-about.test.mjs —— 设置「关于」页（#303）「检查更新」的结果怎么说。
// 服务端回三种比较结果或失败（app/src/ops/update-check.js），这里把它译成一行话与一个语气。
// 失败方向：读不懂的回执一律说「检查失败」——说成「已是最新」会让人放心地停在旧版上。
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeUpdateCheck } from '../../app/public/js/logic.js';
import { setLang } from '../../app/public/js/i18n.js';

test.beforeEach(() => setLang('zh'));

const RELEASE = 'https://github.com/Ike-li/claude-chat-mobile/releases/tag/v1.14.0';

test('有新版：点名新版本号与当前版本，带上 Release 链接', () => {
  const d = describeUpdateCheck({ ok: true, status: 'newer', current: '1.13.0', latest: '1.14.0', releaseUrl: RELEASE });
  assert.equal(d.tone, 'warn');
  assert.match(d.text, /有新版 v1\.14\.0/);
  assert.match(d.text, /v1\.13\.0/);
  assert.equal(d.releaseUrl, RELEASE);
});

test('已是最新：不带 Release 链接（没有要去看的东西）', () => {
  const d = describeUpdateCheck({ ok: true, status: 'same', current: '1.13.0', latest: '1.13.0', releaseUrl: RELEASE });
  assert.equal(d.tone, 'ok');
  assert.match(d.text, /已是最新/);
  assert.equal(d.releaseUrl, null);
});

test('本地领先：两个版本都写出来，不说成「已是最新」也不说「有新版」', () => {
  const d = describeUpdateCheck({ ok: true, status: 'ahead', current: '1.14.0-dev', latest: '1.13.0', releaseUrl: RELEASE });
  assert.equal(d.tone, 'muted');
  assert.match(d.text, /本地领先/);
  assert.match(d.text, /v1\.14\.0-dev/);
  assert.match(d.text, /v1\.13\.0/);
  assert.doesNotMatch(d.text, /已是最新|有新版/);
});

test('失败、超时（null）、不认识的 status：一律「检查失败」', () => {
  for (const res of [null, undefined, { ok: false, error: 'check_failed' }, { ok: true, status: 'weird' }]) {
    const d = describeUpdateCheck(res);
    assert.equal(d.tone, 'error', JSON.stringify(res));
    assert.equal(d.text, '检查失败');
    assert.equal(d.releaseUrl, null);
  }
});

test('英文界面：三种结果都有译文，不漏出中文', () => {
  setLang('en');
  for (const status of ['newer', 'same', 'ahead']) {
    const d = describeUpdateCheck({ ok: true, status, current: '1.13.0', latest: '1.14.0', releaseUrl: RELEASE });
    assert.doesNotMatch(d.text, /[一-鿿]/, `${status}: ${d.text}`);
  }
  assert.doesNotMatch(describeUpdateCheck(null).text, /[一-鿿]/);
});

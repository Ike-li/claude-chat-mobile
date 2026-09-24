// tests/unit/release.test.mjs —— scripts/release.sh 里两个「等 GitHub」判定的失败方向
//
// 这两条判定 2026-09-21 发 v1.12.0 时各咬了一次，且**两次的错误文案都指向错误的方向**：
// 一次把网络抖动播报成「CI 未通过」（去查根本没红的代码），一次把抢跑播报成
// 「the base branch policy prohibits the merge」（去查根本没配错的分支保护）。
//
// 每条判定都测两个方向：不得把「查不到」当成红，也不得因此把真红放行。
// 只测前者的话，一个 `return 0` 的空实现就能全绿。
//
// 打假 gh 而不是打真 GitHub：被测的是脚本对 gh 输出的**判定**，不是 gh 本身。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_SH = join(ROOT, 'scripts', 'release.sh');

// 在一次性目录里放一个假 gh 顶到 PATH 最前，source release.sh 只取函数
// （CCM_RELEASE_LIB_ONLY 让它在 trap 与预检之前 return），然后调用被测函数。
// 轮询间隔设 0：这些用例要量的是判定分支，不是 sleep。
function runWithFakeGh(fakeGhBody, call) {
  const dir = mkdtempSync(join(tmpdir(), 'ccm-release-'));
  try {
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/usr/bin/env bash\nset -u\n${fakeGhBody}\n`);
    chmodSync(gh, 0o755);
    return spawnSync('bash', ['-c', [
      `export PATH=${JSON.stringify(dir)}:$PATH`,
      'export CCM_RELEASE_LIB_ONLY=1 CCM_RELEASE_POLL_SECS=0',
      `source ${JSON.stringify(RELEASE_SH)}`,
      call,
    ].join('\n')], { encoding: 'utf8', cwd: ROOT, timeout: 30_000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHA = '61318597f1ea526fa9170b4adfa1a42db6cade74';

// ── 等 dev 的 CI ────────────────────────────────────────
// `gh run watch --exit-status` 对「run 红了」和「轮询时网络断了」给出同一个非零退出码，
// 所以它的退出码不足以判红，必须再查一次 conclusion。

test('wait_ci_for_sha：watch 撞网络抖动但 run 结论是 success —— 不得播报成 CI 未通过', () => {
  const r = runWithFakeGh(`
    case "$1 $2" in
      "run list")  echo 42 ;;
      "run watch") echo 'failed to get run: Get "https://api.github.com/repos/x/y/actions/runs/42": EOF' >&2; exit 1 ;;
      "run view")  echo success ;;
    esac
  `, `wait_ci_for_sha ${SHA} dev`);
  assert.equal(
    r.status, 0,
    `一次网络抖动就把绿的 CI 判成红，发版会在这里空停——而 stderr 会把人推去查没红的代码：${r.stderr}`,
  );
});

test('wait_ci_for_sha：run 结论是 failure —— 必须停下，不能被上一条的修法一并放行', () => {
  const r = runWithFakeGh(`
    case "$1 $2" in
      "run list")  echo 42 ;;
      "run watch") exit 1 ;;
      "run view")  echo failure ;;
    esac
  `, `wait_ci_for_sha ${SHA} dev`);
  assert.notEqual(r.status, 0, '真红的 CI 被放行了，红着的代码会被发出去');
  assert.match(r.stderr, /CI 未通过/, `停下来了但没说清为什么：${r.stderr}`);
});

// ── 等 PR 可合并 ────────────────────────────────────────
// 同一个 head commit 上挂着两批 check-runs（push 一批、开 PR 一批）。开完 PR 立刻查，
// 第二批往往还没被创建，于是「所有必需检查都绿」在那一刻是真的、但没有意义。

test('wait_pr_mergeable：BLOCKED 且没有必需检查变红 —— 是第二轮还没跑完，要接着等', () => {
  const r = runWithFakeGh(`
    case "$1 $2" in
      "pr view")
        c="$(dirname "$0")/calls"
        n=$(cat "$c" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$c"
        if [ "$n" -ge 2 ]; then echo CLEAN; else echo BLOCKED; fi ;;
      "pr checks") echo '' ;;
    esac
  `, 'wait_pr_mergeable 105');
  assert.equal(
    r.status, 0,
    `BLOCKED 被当成了终局。真实后果是抢在第二轮检查出现前去合并，被分支保护拒绝：${r.stderr}`,
  );
});

test('wait_pr_mergeable：BLOCKED 且必需检查真红 —— 必须停下并点名是哪一项', () => {
  const r = runWithFakeGh(`
    case "$1 $2" in
      "pr view")   echo BLOCKED ;;
      "pr checks") echo e2e ;;
    esac
  `, 'wait_pr_mergeable 105');
  assert.notEqual(r.status, 0, '必需检查红着也去合并，等于绕过分支保护的意图');
  assert.match(r.stderr, /e2e/, `停下来了但没点名哪一项红，人得自己去 PR 页面翻：${r.stderr}`);
});

// UNSTABLE 的字面语义是「可合并，但有 commit status 没通过」——「没通过」**包含还在跑**。
// 必需检查仍在 pending 时这里也是 UNSTABLE，照着放行就会被分支保护当场拒绝。
// 2026-09-22 发 v1.12.1 实测：脚本播报「✓ 可合并（UNSTABLE）」，下一步
// `gh pr merge` 就是 `the base branch policy prohibits the merge`。
// 两个方向都要测：不得在必需检查还在跑时放行，也不得因此把「非必需 job 红了」空等到超时。

test('wait_pr_mergeable：UNSTABLE 但必需检查还在跑 —— 不得放行，要等到 CLEAN', () => {
  const r = runWithFakeGh(`
    case "$1 $2" in
      "pr view")
        c="$(dirname "$0")/calls"
        n=$(cat "$c" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$c"
        if [ "$n" -ge 3 ]; then echo CLEAN; else echo UNSTABLE; fi ;;
      "pr checks")
        c="$(dirname "$0")/calls"
        n=$(cat "$c" 2>/dev/null || echo 0)
        if [ "$n" -ge 3 ]; then echo 0; else echo 2; fi ;;
    esac
  `, 'wait_pr_mergeable 105');
  assert.equal(r.status, 0, `等到 CLEAN 之前就退出了：${r.stderr}`);
  assert.doesNotMatch(
    r.stdout, /UNSTABLE/,
    `在必需检查还有 2 项 pending 时就判了可合并。真实后果是 gh pr merge 被分支保护拒绝，\n` +
    `每次发版都要人工重跑一遍：${r.stdout}`,
  );
  assert.match(r.stdout, /CLEAN/, `没有等到 CLEAN：${r.stdout}`);
});

test('wait_pr_mergeable：UNSTABLE 且必需检查已落定 —— 放行，非必需 job 红了不该挡发版', () => {
  const r = runWithFakeGh(`
    case "$1 $2" in
      "pr view")   echo UNSTABLE ;;
      "pr checks") echo 0 ;;
    esac
  `, 'wait_pr_mergeable 105');
  assert.equal(
    r.status, 0,
    `必需检查已经全部落定、只剩非必需 job 红着，却空等到超时。\n` +
    `这种 UNSTABLE 不会再变成 CLEAN，等下去就是把发版永久卡死：${r.stderr}`,
  );
  assert.match(r.stdout, /UNSTABLE/, `放行了但没说清是哪种状态：${r.stdout}`);
});

test('wait_pr_mergeable：DIRTY —— 有冲突时立刻停，不要空等到超时', () => {
  const r = runWithFakeGh(`
    case "$1 $2" in
      "pr view")   echo DIRTY ;;
      "pr checks") echo '' ;;
    esac
  `, 'wait_pr_mergeable 105');
  assert.notEqual(r.status, 0, '有冲突的 PR 被当成可合并');
  assert.match(r.stderr, /冲突/, `没说清是冲突，人会以为又是检查没跑完：${r.stderr}`);
});

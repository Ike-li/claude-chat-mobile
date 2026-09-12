#!/usr/bin/env node
// tests/gates/check-diagram-claims.js —— 架构图集的漂移闸
//
// 【它守什么】gh-pages 上那 13 张架构图（https://ike-li.github.io/claude-chat-mobile/diagrams/）
// 里承重的事实：常量取值、被引用的源码路径、以及图声称的基线提交。代码改了而图没改，这里变红。
//
// 【为什么需要】图本身没有任何机械保证：archify 的 source 证据只验「该文件在 pin 的 commit 存在」，
// 不验文件内容与节点标签相符；边、关系标签、卡片正文零校验。没有这道闸，一张写着「每 2.5s 轮询」
// 的图会在常量改成 5000 之后继续挂在官网上，而 check 全绿——这正是「零症状的积累」。
//
// 【为什么断言表在 dev 而不是读 gh-pages 的规格源】两条理由：
//   ① gh-pages 是孤儿分支，CI 的 actions/checkout 是浅克隆单分支，取不到那个 ref。
//      让闸依赖一个 CI 里不存在的 ref，等于给它开一条「取不到就跳过」的旁路——那就是恒绿。
//   ② 这道闸要守的是【代码→图】方向的漂移，而代码就在本仓库。规格源只是图的中间产物。
//
// 【为什么 expect 写「图上显示的值」而不是从代码算】写成 `expect: extract()` 就是同义反复，
// 恒绿。expect 必须是图上那行字里的数，实测值从代码单向提取——于是唯一能让它变绿的方式是
// 「改代码时同步改图」，而不是「把断言改成实测值」。
// （2026-09-09 建闸时的实测教训：手写 expect 时把 SDK 版本写成了 package.json 的 `^0.3.263`
//   而图上是 `0.3.263`，制造了一条假红。假红的代价是下次有人直接把断言改成实测值，闸就废了。
//   所以 expect 只许照抄图上文字。）
//
// 【它不守什么】拓扑（哪条边连到哪里）、卡片散文、节点标签的措辞。这些无法机械验证；
// 能做的是把承重事实都搬进下面这张表，让散文只承担解释。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** 从源码里取一个 `NAME = <数字>` 常量（允许 1_000 这种下划线分组与 `5 * 60_000` 这种乘式）。 */
function constNum(path, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*)`).exec(read(path));
  if (!m) return `未找到常量 ${name}`;
  return m[1].split('*').reduce((a, b) => a * Number(b.trim().replace(/_/g, '')), 1);
}

// ── 图声称的基线提交。改图时同步更新。 ───────────────────────────────
const PINNED_REVISION = '7d4aa874944374770b5207598cd2a1c4253011fd';

// ── 图里 source 证据引用到的源码路径（27 条 source 去重后）。重命名/删除即红。 ──
const REFERENCED_PATHS = [
  'package.json',
  'app/server.js',
  'app/src/agent/agent.js',
  'app/src/agent/cli-settings-defaults.js',
  'app/src/auth/cf-access.js',
  'app/src/ops/audit.js',
  'app/src/ops/cli-hooks-bridge.js',
  'app/src/ops/cli-statusline-bridge.js',
  'app/src/ops/config-file.js',
  'app/src/ops/doctor-checks.js',
  'app/src/ops/env-schema.js',
  'app/src/ops/metrics.js',
  'app/src/ops/notify-channels.js',
  'app/src/ops/service-units.js',
  'app/src/ops/statusline.js',
  'app/src/server/app.js',
  'app/src/server/mirror-engine.js',
  'app/src/sessions/history.js',
  'app/src/shared/data-dir.js',
  'app/public/js/app.js',
  'app/public/js/app/connection-sync.js',
  'app/public/js/app/context.js',
  'app/public/js/app/event-dispatch.js',
  'app/public/js/canonicalize.js',
  'app/public/js/i18n.js',
  'app/public/js/logic.js',
  'app/public/js/logic/service-diag.js',
  'tests/unit/logic-client-error.test.mjs',
];

// ── 数值与字面量断言。`shown` 是图上那行字，`expect` 照抄其中的值。 ──────
const CLAIMS = [
  { diagram: '02 / 03', shown: 'catchUpTick 每 2500ms 读尾部',
    actual: () => constNum('app/src/server/mirror-engine.js', 'CATCH_UP_INTERVAL_MS'), expect: 2500 },
  { diagram: '02', shown: '镜像中提速到 1000ms 轮询',
    actual: () => constNum('app/src/server/mirror-engine.js', 'CATCH_UP_MIRROR_INTERVAL_MS'), expect: 1000 },
  { diagram: '02 / 03', shown: '静默墙钟约 12.5s（常态 5 tick / 镜像 13 tick）',
    // 两个 tick 数不是常量：mirror-engine 按 ceil(墙钟 / 当前轮询间隔) 现算，history 的 5 只是常态档的默认值。
    // 图上把两个档都写出来了，所以这里也要两个都算——只断言 5 会让「镜像态 1s×5=5s 过早解锁」这个
    // 曾经真实存在的 bug 重新变得不可见。
    actual: () => {
      const wall = constNum('app/src/server/mirror-engine.js', 'MIRROR_RELEASE_MS');
      const normal = constNum('app/src/server/mirror-engine.js', 'CATCH_UP_INTERVAL_MS');
      const mirror = constNum('app/src/server/mirror-engine.js', 'CATCH_UP_MIRROR_INTERVAL_MS');
      if ([wall, normal, mirror].some(v => typeof v !== 'number')) return '常量提取失败';
      return `${wall / 1000}s / ${Math.ceil(wall / normal)} / ${Math.ceil(wall / mirror)}`;
    }, expect: '12.5s / 5 / 13' },
  { diagram: '02 / 03', shown: '常态档默认 5 tick',
    actual: () => constNum('app/src/sessions/history.js', 'MIRROR_RELEASE_QUIET_TICKS'), expect: 5 },
  { diagram: '04', shown: '新设备通知正文不含设备 ID 与 IP，并按 5 分钟节流',
    actual: () => constNum('app/src/ops/notifications.js', 'DEVICE_NOTIFY_INTERVAL_MS') / 60000, expect: 5 },
  { diagram: '04', shown: 'IP 桶，IPv6 按 /64',
    actual: () => /IPv6[\s\S]{0,400}?\/64/.test(read('app/src/auth/rate-limiter.js')) ? 'IPv6 按 /64' : '分桶口径已改',
    expect: 'IPv6 按 /64' },
  { diagram: '04 / 00', shown: 'AUTH_TOKEN 是启动前提，没有它 server 起不来',
    actual: () => /deny\('token_required'/.test(read('app/src/shared/bind-host.js')) ? 'token_required' : '启动前提已失效',
    expect: 'token_required' },
  { diagram: '09', shown: '告警都带 24h 时效窗自动退场',
    actual: () => constNum('app/src/ops/metrics.js', 'DEFAULT_STALE_AFTER_MS') / 3600000, expect: 24 },
  { diagram: '05', shown: '启动一次 + 之后每 24h 一次',
    // 与图 09 那个 24h 是两码事：这条是审批终态记录的清理周期，那条是服务告警的时效窗。
    // 合成一条断言会让其中一个改了另一个不红。
    actual: () => {
      const m = /setIntervalImpl\(sweep,\s*([0-9\s*_]+)\)/.exec(read('app/src/agent/approval-lifecycle.js'));
      if (!m) return '清理周期已改写';
      return m[1].split('*').reduce((a, b) => a * Number(b.trim().replace(/_/g, '')), 1) / 3600000;
    }, expect: 24 },
  { diagram: '07', shown: 'porcelain -z 解析，相对路径先过 assertSafeRelPath',
    actual: () => /'status',\s*'--porcelain=v1',\s*'-z'/.test(read('app/src/files/git-workspace.js')) ? 'porcelain=v1 -z' : '解析口径已改',
    expect: 'porcelain=v1 -z' },
  { diagram: '07', shown: 'browse:* / files:* / git:*',
    actual: () => {
      const src = read('app/src/server/socket-files.js');
      return ['browse:list', 'browse:read'].every(e => src.includes(`'${e}'`)) ? 'browse:list + browse:read' : '入向事件名已改';
    }, expect: 'browse:list + browse:read' },
  { diagram: '01', shown: '>50000 字',
    actual: () => (/text\.length > 50000/.test(read('app/src/server/app.js')) ? 50000 : '判据已改'), expect: 50000 },
  { diagram: '07', shown: '10 个',
    actual: () => constNum('app/src/files/uploads.js', 'MAX_FILES'), expect: 10 },
  { diagram: '07', shown: '10MB',
    actual: () => constNum('app/src/files/uploads.js', 'MAX_FILE_BYTES') / 1048576, expect: 10 },
  { diagram: '07', shown: '共 20MB',
    actual: () => constNum('app/src/files/uploads.js', 'MAX_TOTAL_BYTES') / 1048576, expect: 20 },
  { diagram: '05', shown: '默认 90 天，可配',
    actual: () => { const m = /APPROVAL_RETENTION_DAYS[\s\S]{0,120}?:\s*(\d+)/.exec(read('app/src/agent/approval-lifecycle.js')); return m ? Number(m[1]) : '默认值已改'; }, expect: 90 },
  { diagram: '07', shown: 'dataDir/uploads',
    actual: () => (/join\(resolveDataDir\(env\), UPLOADS_SUBDIR\)/.test(read('app/src/files/uploads.js')) ? 'dataDir/uploads' : '落点已改'), expect: 'dataDir/uploads' },
  { diagram: '02 / 03', shown: '白名单只认 sdk-ts',
    actual: () => /SDK_TAIL_ENTRYPOINTS = new Set\(\['sdk-ts'\]\)/.test(read('app/src/sessions/history.js')) ? "只认 sdk-ts" : '白名单已改', expect: '只认 sdk-ts' },
  { diagram: '06', shown: '前台判据是 client:presence（hidden !== true）',
    actual: () => /s\?\.data\?\.hidden !== true/.test(read('app/src/ops/notifications.js')) ? 'hidden !== true' : '判据已改', expect: 'hidden !== true' },
  { diagram: '00', shown: 'claude-agent-sdk 0.3.263',
    actual: () => JSON.parse(read('package.json')).dependencies['@anthropic-ai/claude-agent-sdk'], expect: '0.3.263' },
  { diagram: '12', shown: 'check 链上的 13 道门禁',
    // 2026-09-11 接进 check-disposable-env-guard 后图上还写着 12，在 PENDING_CLAIMS 里挂了一轮，
    // gh-pages 4565341 重出图后归位。挪回来而不是当初就改 expect：CLAIMS 的语义是「图说 X 且代码是 X」。
    actual: () => JSON.parse(read('package.json')).scripts.check.split('&&').length, expect: 13 },
  { diagram: '00 / 01 / 08 / 11', shown: '共 31 种 type',
    // 同上：27 → 31（trusted_devices、session_recap、prompt_suggestion、rewind_applied）。
    actual: () => (/AGENT_EVENT_TYPES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(read('app/src/shared/protocol.js'))?.[1].match(/'[a-z_]+'/g) || []).length,
    expect: 31 },
  { diagram: '06', shown: '但「后台完成」只算真后台：跑得久的前台 Bash 靠 is_backgrounded 滤掉',
    actual: () => {
      const src = read('app/src/agent/agent.js');
      const hasMap = /this\.taskBackgrounded = new Map\(\)/.test(src);
      const filters = /taskBackgrounded\.get\(doneTaskId\) === false/.test(src);
      return hasMap && filters ? '按 is_backgrounded 过滤' : '过滤已失效';
    }, expect: '按 is_backgrounded 过滤' },
];

// ── 图还没说、但代码已经成立的事实。──────────────────────────────────
// 为什么单列一组而不是塞进 CLAIMS：CLAIMS 的语义是「图说 X，代码也得是 X」，
// `shown` 必须能在规格源里逐字找到。这里的几条图上还没有（多半是刚改的代码等着下次重出图），
// 塞进 CLAIMS 会让 `shown` 描述一段不存在的文字，那条「只许照抄图上文字」的规矩就废了。
// 分开之后：代码侧立刻被守住（删了会红），而「图欠这一条」这个状态也不会随会话结束丢掉。
// 补进图并重出后，把条目挪进 CLAIMS 即可。
const PENDING_CLAIMS = [
  // 当前为空：2026-09-11 那三条已随 gh-pages 4565341 重出图并挪回 CLAIMS。
  // 新的漂移先落这里——代码侧立刻被守住，而「图欠这一条」不会随会话结束丢掉。
];

function git(args) {
  // stderr 收进返回值而不是转发到终端：`cat-file -e` 对缺失对象打的那行 `fatal: Not a valid
  // object name` 会和下面自己的诊断并排出现，读起来像是 git 在确认祖先关系有问题——2026-09-11
  // 的误诊正是这么来的。要看原文时它还在 out 里。
  try { return { ok: true, out: execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.message).trim() }; }
}

function main() {
  const problems = [];

  // A：被引用的路径在 HEAD 仍存在
  for (const p of REFERENCED_PATHS) {
    if (!existsSync(join(ROOT, p))) problems.push(`路径已不存在（图里还指着它）：${p}`);
  }

  // B：数值与字面量断言（图已在说的话 + 图欠着的话，两组都要真跑）
  for (const c of [...CLAIMS, ...PENDING_CLAIMS]) {
    let got;
    try { got = c.actual(); } catch (e) { got = `提取失败：${e.message}`; }
    if (got !== c.expect) {
      const what = c.shown ? `显示「${c.shown}」` : `欠一条：${c.todo}`;
      problems.push(`图 ${c.diagram} ${what}，代码实测 ${JSON.stringify(got)}（应为 ${JSON.stringify(c.expect)}）`);
    }
  }

  // C：pin 是 HEAD 的祖先（历史被重写 / 指向别的分支即红）
  //
  // 两种失败必须分开报：`--is-ancestor` 对「不是祖先」和「对象根本不在工作区」都只是非零退出，
  // 而后者在浅克隆里是常态——CI 的 actions/checkout 默认 fetch-depth: 1，整个历史只有一个提交，
  // git 报的是 `fatal: Not a valid commit name`。合成一句「不是祖先」会把一个环境问题说成图漂移，
  // 然后有人真去重出图（2026-09-11 就这么误诊过一轮）。
  // 【注意】两条都仍然变红。这里改的只是措辞，不是给浅克隆开「取不到就跳过」的旁路——那就是恒绿。
  const present = git(['cat-file', '-e', `${PINNED_REVISION}^{commit}`]);
  let lag = null;
  // 取不到对象且其余断言全过时，唯一的问题是克隆深度——尾部那句「重新出图」是错误指引，别打。
  const shallowOnly = !present.ok && problems.length === 0;
  if (!present.ok) {
    problems.push(
      `基线提交 ${PINNED_REVISION.slice(0, 7)} 不在当前工作区里——这通常不是图漂移，`
      + '而是克隆太浅取不到那个对象（CI 上给 actions/checkout 加 fetch-depth: 0）。图本身无需改动。',
    );
  } else if (!git(['merge-base', '--is-ancestor', PINNED_REVISION, 'HEAD']).ok) {
    problems.push(`基线提交 ${PINNED_REVISION.slice(0, 7)} 不是 HEAD 的祖先——图引用了一段不在当前历史里的提交`);
  } else {
    const r = git(['rev-list', '--count', `${PINNED_REVISION}..HEAD`]);
    if (r.ok) lag = Number(r.out);
  }

  if (problems.length > 0) {
    console.error('架构图集漂移检查失败：\n' + problems.map(p => `- ${p}`).join('\n'));
    if (!shallowOnly) {
      console.error('\n修法：改 gh-pages 的规格源重新出图，并同步更新本文件的 CLAIMS / REFERENCED_PATHS / PINNED_REVISION。');
    }
    process.exit(1);
  }

  // 落后提交数只报告不判红：图必然落后于 HEAD，用提交数做阈值只会制造噪音。
  // 真正会红的是上面三项——值漂移、路径消失、历史被重写。
  console.log(`架构图集断言 OK（路径 ${REFERENCED_PATHS.length} 条 · 断言 ${CLAIMS.length} 条 · 待补进图 ${PENDING_CLAIMS.length} 条 · 基线 ${PINNED_REVISION.slice(0, 7)}，落后 ${lag ?? '?'} 个提交）`);
  if (PENDING_CLAIMS.length > 0) {
    console.log('  待补进图（代码已成立，等下次重出图）：');
    for (const c of PENDING_CLAIMS) console.log(`    - 图 ${c.diagram}：${c.todo}`);
  }
}

main();

#!/usr/bin/env bash
# scripts/release.sh —— 一条命令发版：bump → 等 CI → PR(dev→master) → 合并 → tag → GitHub Release
#
# 分支模型：dev=开发线（日常改动走 feature 分支 → PR → dev）、master=对外发布的稳定版本。
# 装机 `curl` 拉的就是 master 的源码归档，所以 **master 的 HEAD 必须恒等于最新发布**。
#
# 用法：
#   scripts/release.sh [patch|minor|major|X.Y.Z] [--dry-run] [-y]
#     位置参数=版本递增方式（默认 patch）；也可给显式版本号如 1.2.0
#     --dry-run / -n   只做预检+显示计划，不改动任何东西
#     -y / --yes       跳过交互确认（自动化用）
#
# ── 2026-09-12 改造：为什么不再直推 master ────────────────────────────────
# master 开了 enforce_admins，直推会被分支保护拒绝——发版必须和别的改动一样走 PR。
# 这不只是为了满足规则，它修掉了旧流程两个真实的洞：
#   ① 旧的「发版前 CI 模拟」跑的是 `CI=true npm test`，而那条命令 CI **刻意不跑**
#      （--test-force-exit 会腰斩异步单测，见 CLAUDE.md），且漏掉 check / invariants 三档 / e2e。
#      护栏本身就可能假绿。现在改成等**真** CI：GitHub 上跑什么，发版就等什么。
#   ② 旧流程 push 完才提示「盯 CI」，也就是 CI 红了照样已经发出去了。
#
# 【为什么 tag 在合并之后打】GitHub 的 PR 合并没有 ff-only，合出来是一个 merge commit，
# master 的 HEAD 不再等于 dev 的 tip。tag 必须指向 master 的新 HEAD，否则
# /archive/refs/tags/ 拿到的会是一棵没被发布的树。
#
# ★【合并到打 tag 之间有一个对外可见的窗口】PR 一合并，装机 curl 拉的
#   /archive/refs/heads/master.tar.gz 立刻就是新代码，而 tag 与 Release 还要四步网络操作
#   （fetch / tag / push tag / 建 Release）才落定。任何一步失败，master 就停在
#   「代码已对外、releases 页面还是上一版、CHANGELOG 里写着一个查不到的版本号」。
#
#   这个状态【没有任何 CI 闸能发现】，而且不是疏漏：合并那一刻 master 的 HEAD 必然还没有 tag，
#   所以「master HEAD 必须有 tag」根本做不成 CI 检查 —— 它与本脚本的先后顺序天然冲突。
#   唯一可行的守卫是下面预检里的 FINALIZING 检测：每次发版开头先看一眼上一轮收没收尾。
#
# 【为什么不用把 master 合回 dev】merge commit 的父之一就是 dev 的 tip，下次开 PR 时
# GitHub 算出的 merge base 仍然正确。省掉这一步就不必为了同步去绕过 dev 的分支保护。
#
# 内建护栏（都是踩过的坑）：
#   · 预检：干净工作树 / 在 dev / 本地与远程一致 / tag 不重复 / **上一轮发版已收尾**
#   · 每一步都等真 CI 绿（dev 推送后一次、PR 合并前一次）
#   · 幂等 reconciliation：中途失败后重跑不会二次 bump、不会撞「PR/Release 已存在」
#   · trap 还原尚未提交的 bump 与 CHANGELOG（已提交时它是 no-op，所以无条件跑）
#
# 【三条互斥路径】脚本开头先判断自己处在哪一种：
#   FINALIZING —— 上一轮发到一半、master 已经对外：只补 tag / Release，不 bump、不开 PR
#   RESUMING   —— 发版提交已推 dev 但 PR 没合：不再 bump，接着等 CI / 开 PR / 合并
#   全新一轮   —— bump → CHANGELOG → 推 dev → CI → PR → CI → 合并 → tag → Release
#
# 【六个中断点，重跑都能接上】按发生顺序，以及各自靠什么认出来：
#   ① bump 未提交             → trap 还原，下次当全新一轮
#   ② 已推 dev、CI 未过       → RESUMING（package.json 已是 vX + 有发版提交 + tag 不存在）
#   ③ PR 已开、检查未过       → RESUMING + 复用已开的 PR
#   ④ PR 已合并、tag 未打     → FINALIZING（master HEAD 没有 tag）
#   ⑤ tag 建了但推送失败      → tag 判据查**远端**而不是本地
#   ⑥ tag 已推、Release 未建  → FINALIZING 的第二个触发（ahead_by 归零 + 那个 tag 没有 Release）
#
# ★ ④⑤⑥ 是 2026-09-13 补的，此前【全都救不回来】：④⑥ 会 die「dev 相对 master 没有新提交，
#   无可发」—— 因为 PR 一合并 ahead_by 就归零，脚本把「发到一半」报成「没什么可发」；
#   ⑤ 则因为判据只查本地 tag，重跑跳过 push，`gh release create --verify-tag` 每次都查不到
#   远端 tag，死在同一行。而这三个断点全都发生在 **master 已经对外之后**，
#   装机 curl 那一刻拿到的就是一份没有 tag、没有 Release 的新代码。
#
# 分发形态：用户装机走 GitHub 对 master 的源码归档（/archive/refs/heads/master.tar.gz）。它就是
# `git archive`、遵守树里 .gitattributes 的 export-ignore，所以发版不打包、不上传任何资产。
# 裁什么见 .gitattributes，不变量由 tests/unit/dist-manifest.test.mjs 钉住。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BUMP=""; DRY=""; YES=""
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY=1 ;;
    -y|--yes)     YES=1 ;;
    patch|minor|major|*.*.*) BUMP="$a" ;;
    *) echo "✗ 未知参数：$a"; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# 两个等待函数的轮询间隔（秒）。tests/unit/release.test.mjs 设成 0——那些用例量的是判定分支，
# 让它们陪着真 sleep 只会把「在算」变成「在等」。
POLL_SECS="${CCM_RELEASE_POLL_SECS:-10}"

NOTES=""
cleanup() {
  # 还原**尚未提交**的 bump 与 CHANGELOG。
  #
  # 【为什么不再判断「是否已提交」】`git checkout -- <file>` 只动工作树、从不碰历史，所以在
  # 已提交的情况下它本来就是 no-op。旧代码用一个 COMMITTED 标志把它整个跳过，反而制造了一个
  # 卡死点：RESUMING 路径下写了 CHANGELOG 却没能提交（push 失败等）时，脏工作树留在原地，
  # 而下一次重跑的第一道预检恰恰是「工作树必须干净」—— 人要先手动 checkout 才能继续。
  # CHANGELOG.md 是 tracked 文件，checkout 一定还原得掉。
  git checkout -q -- package.json package-lock.json CHANGELOG.md 2>/dev/null || true
  [ -n "$NOTES" ] && rm -f "$NOTES" || true
}

# 把这一版的说明写进 CHANGELOG.md 顶部（与 GitHub Release notes 同源，不另写一份）。
#
# 【为什么要落进仓库】Release notes 只活在 GitHub 上，而装机用户拿到的是**源码归档**——他们手上
# 没有任何东西能回答「我这份是什么时候的、比上一版多了什么」。CHANGELOG.md 不在 .gitattributes
# 的 export-ignore 里，会随归档一起到用户手上。
write_changelog() {
  TAG="$1" DATE="$(date +%Y-%m-%d)" NOTES_FILE="$2" node -e '
    const fs = require("fs");
    const head = "# 变更记录\n";
    const tag = process.env.TAG;
    const body = fs.readFileSync(process.env.NOTES_FILE, "utf8").trim();
    const entry = `\n## ${tag} — ${process.env.DATE}\n\n${body}\n`;
    let rest = "";
    if (fs.existsSync("CHANGELOG.md")) {
      const cur = fs.readFileSync("CHANGELOG.md", "utf8");
      rest = cur.startsWith(head) ? cur.slice(head.length) : `\n${cur}`;
      // 同版本的节已经在了 —— 只会发生在 RESUMING 重跑、且这中间 dev 又合进了新东西。
      // 整节换掉而不是再插一节：否则同一个版本号出现两节，且两节内容还不一样，
      // 而读 CHANGELOG 的人没有任何办法判断哪一节才算数。
      const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rest = rest.replace(new RegExp(`\\n## ${esc} — [^\\n]*\\n[\\s\\S]*?(?=\\n## |$)`), "");
    }
    fs.writeFileSync("CHANGELOG.md", head + entry + rest);
  '
}

# ── 等某个 sha 的 CI 跑完 ──────────────────────────────
# push 触发的 run 不是立刻就有的，先轮询等它出现，再 watch。
# 【为什么不用 `gh run watch` 的裸调用】它要一个 run id；不按 headSha 挑就可能盯上**上一次**
# 推送的 run，那个早就绿了，于是「等 CI」变成一句空话。
wait_ci_for_sha() {
  local sha="$1" label="$2" run_id="" tries=0 concl=""
  say "▶ 等 ${label} 的 CI（sha ${sha:0:8}）…"
  while [ "$tries" -lt 40 ]; do
    run_id="$(gh run list --branch dev --event push --limit 15 --json databaseId,headSha \
      -q "[.[] | select(.headSha == \"$sha\")] | .[0].databaseId" 2>/dev/null || true)"
    [ -n "$run_id" ] && [ "$run_id" != "null" ] && break
    run_id=""; tries=$((tries + 1)); sleep 5
  done
  [ -n "$run_id" ] || die "等不到 ${label} 的 CI run（sha ${sha:0:8}）——GitHub 侧没有为这次推送建 run？"
  say "  run ${run_id}"

  # 【为什么 watch 退出码不足以判红】`gh run watch --exit-status` 的非零退出码有两个来源：
  # run 真的红了，以及**轮询期间的一次网络抖动**（实测 `failed to get run: … EOF`）。
  # 两者退出码一模一样，只看它就会把抖动播报成「CI 未通过」，而那句文案会把人推去查
  # 根本没红的代码——2026-09-21 发 v1.12.0 时真撞上，当时 11 个 job 一个没红，最终全绿。
  #
  # 所以失败后再直查一次 conclusion：**拿到结论才判，拿不到就当这次没查过**，接着 watch。
  # 反过来写（查不到就判红）等于把判据留在网络上，那正是这次的失败形态。
  tries=0
  while :; do
    gh run watch "$run_id" --exit-status >/dev/null 2>&1 && break
    concl="$(gh run view "$run_id" --json conclusion -q .conclusion 2>/dev/null || true)"
    case "$concl" in
      success) break ;;
      failure|cancelled|timed_out|startup_failure|action_required)
        die "${label} 的 CI 未通过（run ${run_id}，结论 ${concl}）。修好再重跑本脚本，它会从中断处接上。" ;;
    esac
    # 空结论 = run 还没跑完，或这次查询也没通。两种都不是「红」。
    tries=$((tries + 1))
    if [ "$tries" -ge 20 ]; then
      die "${label} 的 CI 连查 20 次都没拿到结论（run ${run_id}）。GitHub 或本机网络异常，稍后重跑本脚本。"
    fi
    sleep "$POLL_SECS"
  done
  say "  ✓ ${label} CI 通过"
}

# ── 等 PR 到「GitHub 自己认为可以合并」──────────────────
#
# 【为什么判据是 mergeStateStatus，而不是 `gh pr checks --watch --required`】
# 同一个 head commit 上会挂**两批** check-runs：push 到 dev 触发一批，开 PR 又触发一批。
# 开完 PR 立刻查，第二批往往还没被创建，`gh pr checks` 看到的是第一批（早已全绿），
# 于是当场判「检查通过」，脚本随即去合并 —— 被分支保护拒绝：
#   `Pull request … is not mergeable: the base branch policy prohibits the merge.`
# 2026-09-21 发 v1.12.0 时就卡在这里。那句文案读起来像分支保护配错了
# （我照着去查了 required_approving_review_count，它是 0，没问题），实际只是抢跑。
#
# `mergeStateStatus` 是 GitHub 自己算的：哪一批 check-runs 算数由它说了算，脚本不必猜。
# 【为什么 UNSTABLE 也放行】它表示「非必需检查有红的，但保护规则已满足」，与旧代码
# `--required` 的意图一致：非必需 job 变红不该挡住发版。
wait_pr_mergeable() {
  local pr="$1" tries=0 state="" fails=""
  say "▶ 等 PR #${pr} 可合并…"
  while [ "$tries" -lt 120 ]; do
    state="$(gh pr view "$pr" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null || true)"
    case "$state" in
      CLEAN|UNSTABLE) say "  ✓ PR #${pr} 可合并（${state}）"; return 0 ;;
      DIRTY) die "PR #${pr} 与 master 有冲突，先解决冲突再重跑本脚本。" ;;
      BLOCKED)
        # BLOCKED 同时覆盖「必需检查还在跑」与「必需检查真红了」，只有后者该停。
        fails="$(gh pr checks "$pr" --required --json name,bucket \
          -q '[.[] | select(.bucket == "fail") | .name] | join("、")' 2>/dev/null || true)"
        if [ -n "$fails" ]; then
          die "PR #${pr} 的必需检查未通过：${fails}。修好再重跑本脚本。"
        fi
        ;;
    esac
    tries=$((tries + 1)); sleep "$POLL_SECS"
  done
  die "等 PR #${pr} 可合并超时（最后状态 ${state:-查询失败}）。去 PR 页面看卡在哪一项。"
}

# 【为什么早退点在 trap 之前】tests/unit/release.test.mjs 要 source 本文件来单测上面这些
# 等待函数。而 cleanup 会 `git checkout -- package.json package-lock.json CHANGELOG.md`——
# 装上 trap 再让测试进程退出，等于每跑一次单测就吞掉开发者在这三个文件里未提交的改动。
if [ -n "${CCM_RELEASE_LIB_ONLY:-}" ]; then return 0; fi

trap cleanup EXIT

# ── 预检 ─────────────────────────────────────────────
command -v gh >/dev/null || die "需要 gh CLI"
gh auth status >/dev/null 2>&1 || die "gh 未登录：先 gh auth login"
[ -z "$(git status --porcelain)" ] || { git status -s; die "工作树不干净，先提交或暂存"; }

git fetch -q origin || die "git fetch 失败（网络？）"
# --tags 显式拉：下面的 FINALIZING 判据要问「origin/master 的 HEAD 上有没有 tag」，
# 本地 tag 不新鲜就会把一个明明已经发布好的版本误判成「没收尾」，然后去重复建 Release。
git fetch -q --tags origin || die "git fetch --tags 失败（网络？）"
BR="$(git rev-parse --abbrev-ref HEAD)"
[ "$BR" = "dev" ] || die "请在 dev 分支发版（当前在 ${BR}）"
R="$(git ls-remote origin refs/heads/dev | cut -f1)"
[ -z "$R" ] || [ "$(git rev-parse dev)" = "$R" ] || die "本地 dev 与 origin/dev 不一致，先同步"

# ── 上一轮发版收尾了吗？（FINALIZING 检测）───────────
# 【为什么这一问必须排在「有没有东西可发」之前】PR 一合并，master 就包含了 dev 的全部提交，
# ahead_by 随即归零。2026-09-13 之前这里没有这道检测，于是「PR 已合并、tag 没打成」那个状态
# 是**救不回来的**：重跑直接 die「dev 相对 master 没有新提交，无可发」—— 把「发到一半、
# master 已经对外」报成「没什么可发」，指向完全相反的排查方向，只能手动补 tag 收场。
# 触发它不需要任何异常操作，合并之后那四步网络操作断一次就够了。
MASTER_SHA="$(git rev-parse origin/master)"
# 【别用 `| head -1`】本脚本开着 pipefail，head 取够就退出会让上游 git 收到 SIGPIPE、
# 整个管道判失败。awk 读完整个输入，不产生 SIGPIPE。同一个陷阱见 check-shell-pitfalls.js。
MASTER_TAG="$(git tag --points-at "$MASTER_SHA" | awk 'NR==1')"
# 【为什么还要问「仓库有没有过 tag」】一个 tag 都没有时，「master HEAD 上没有 tag」说的是
# **还没发过版**，不是**上一轮没收尾** —— 这两种状态在 git 里同形，只能靠这一条区分。
# 少了它，fork 出去的仓库首次发版会被当成收尾：直接给一个没经过 bump 的 package.json
# 版本号打 tag、建 Release，而且整条 bump 路径根本不会执行。
ANY_TAG="$(git tag --list | awk 'NR==1')"
FINALIZING=""
if [ -z "$MASTER_TAG" ] && [ -n "$ANY_TAG" ]; then
  FINALIZING=1
  say "▶ 上一轮发版没收尾：origin/master（${MASTER_SHA:0:8}）上没有 tag"
  say "  本次只补 tag 与 GitHub Release，不 bump、不推 dev、不开 PR。收完尾要发新版再跑一次。"
else
  # 【为什么不吞网络错误】旧写法 `|| echo 0` 把「取不到」和「真的没有新提交」混成同一条
  # 文案，网络抖一下就会收到一句与实情无关的「无可发」。
  # 【不再要求 master 是 dev 的祖先】走 PR 之后 master 上会有 merge commit，那是正常状态。
  # 真正要问的是「有没有东西可发」——用 GitHub 算的比较结果，它和 PR 看到的是同一份。
  AHEAD="$(gh api "repos/{owner}/{repo}/compare/master...dev" -q '.ahead_by')" \
    || die "取不到 master...dev 的比较结果（网络？gh 权限？）—— 这不等于「没有新提交」"
  if [ "$AHEAD" -gt 0 ]; then
    :   # 正常：有东西可发
  elif [ -n "$MASTER_TAG" ] && ! gh release view "$MASTER_TAG" >/dev/null 2>&1; then
    # ahead_by 归零有两种可能：真的没东西可发，或者**上一轮断在了最后一步** —— tag 推上去了、
    # Release 没建成。两者在 ahead_by 上完全同形，只能靠「那个 tag 的 Release 在不在」区分。
    #
    # 【为什么这一查放在这里、而不是和上面的无 tag 判据并列】正常发版时 ahead_by > 0，压根
    # 走不到这一行。要是把它提到前面去并列判断，一次 gh 网络抖动就会把一次**正常发版**
    # 误判成收尾 —— 那会跳过 bump / 推 dev / PR / 合并整条链，只去 edit 一个早就存在的
    # Release，然后打印「已发布」。用户以为发出去了，实际 dev 上的代码一行都没进 master。
    FINALIZING=1
    say "▶ 上一轮发版没收尾：tag $MASTER_TAG 在，但它的 GitHub Release 没建成"
    say "  本次只补 Release。"
  else
    die "dev 相对 master 没有新提交，无可发"
  fi
fi

# ── 采集验证环境（本项目的行为全取决于这两个外部件，出问题时要能对账）──────
# CLI 版本是【外部事实】：它属于跑发版的这台机器，不属于仓库。所以只声称"验证于"，绝不写成
# "需要/使用"。取不到不中止——下方"展示计划 + [y/N] 确认"那道闸就是这里的守卫：维护者会先
# 看到 unknown 再决定要不要按 y。
# 只取第一个 token：`claude --version` 输出形如 "2.1.220 (Claude Code)"，与 app/src/ops/statusline.js
# 对 versions.cli 的切法保持同一约定。
CLI_BIN="${CLAUDE_BIN:-$(command -v claude || true)}"
CLI_VER="unknown"
if [ -n "$CLI_BIN" ]; then
  CLI_VER="$("$CLI_BIN" --version 2>/dev/null | awk '{print $1}')"
  [ -n "$CLI_VER" ] || CLI_VER="unknown"
fi
[ "$CLI_VER" = "unknown" ] && say "⚠️  取不到 claude CLI 版本（CLAUDE_BIN/PATH 里没有可用的 claude），发布说明里会记 unknown"
SDK_VER="$(node -p "require('./package.json').dependencies['@anthropic-ai/claude-agent-sdk']")"

# 收尾模式下这两个值必须取自【被发布的那棵树】，而不是当前机器 + 当前工作区：中断到重跑之间
# CLI 完全可能已经升级过，照抄当前值等于给一个旧版本贴上一张不属于它的「验证于」标签。
if [ -n "$FINALIZING" ]; then
  CLI_VER="$(git show "${MASTER_SHA}:package.json" | node -p "(JSON.parse(require('fs').readFileSync(0,'utf8')).verifiedWith||{}).claudeCli||'unknown'")"
  SDK_VER="$(git show "${MASTER_SHA}:package.json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).dependencies['@anthropic-ai/claude-agent-sdk']")"
fi

# ── 算版本号 ─────────────────────────────────────────
# 【为什么锚到 origin/master 而不是 HEAD】tag 只打在 master 上（发版 PR 合并后的那个 HEAD）。
# 而不带参数的 `git describe` 找的是**从当前 HEAD 可达**的最近 tag —— 发版走 PR 之后 master
# 的 HEAD 是个 merge commit，它不在 dev 的祖先链里，describe 于是越过它一路退到再上一个版本。
# 2026-09-12 实测：dev 上算出 v1.7.0 而不是 v1.8.0。后果不是少算一点，是**多算一整个已发布
# 版本**：版本推导把 v1.8.0 那批的 23 个 feat 又数了一遍，本该 patch 的一次发版被推成 minor
# （踩出过 41767b7「发版 v1.9.0」那次回滚）；CHANGELOG 与 release notes 同吃这个范围，会把
# 上一个版本的条目原样再列一遍，而那是发出去就收不回的对外产物。
# 第 90 行已 `git fetch -q origin`，所以这里的 origin/master 是新鲜的。
if [ -n "$FINALIZING" ]; then
  # 【收尾时必须从父提交出发】断点可能落在「tag 已推、Release 没建成」，那时 master 的 HEAD
  # **自己就有 tag**，从它出发 describe 返回的是这一版自己 —— release notes 的区间会塌成
  # `vX..vX`（空），发出去一个什么都没列的 Release。从第一个父出发拿到的才是上一版。
  LAST_TAG="$(git describe --tags --abbrev=0 "${MASTER_SHA}^" 2>/dev/null || true)"
else
  LAST_TAG="$(git describe --tags --abbrev=0 origin/master 2>/dev/null || true)"
fi
# 仓库名从本地 remote 解析，不打 GitHub API（GraphQL 在代理下会 EOF）
REPO="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
OLD_VER="$(node -p "require('./package.json').version")"

# ── 三条互斥路径：① 收尾 / ② 续跑 / ③ 全新一轮 ──────
RESUMING=""
CUR_TAG="v$OLD_VER"
# 【绝不能写成 `… | grep -q`】本脚本开着 pipefail，grep -q 命中即退出会让上游 git log 收到
# SIGPIPE，整个管道判失败、条件恒假——于是「这一版发完没有」永远答「没发过」，脚本把一个
# 已经推出去的版本再 bump 一次（2026-09-12 实测：1.8.0 被续跑成 1.8.1 再成 1.9.0）。
# 同一个模式在本文件里踩过两次，现已由 tests/gates/check-shell-pitfalls.js 机械挡住。
RESUME_COMMITS="$(git log --pretty=%s -50 | grep -cxF "chore: 发版 $CUR_TAG" || true)"

if [ -n "$FINALIZING" ]; then
  # ① 收尾：master 上已经有这一版的代码与 CHANGELOG，只差 tag 与 Release。
  # 版本号从 master 自己的 package.json 读 —— 它是随发版提交一起合进去的，就是这一版的号。
  # **本地 dev 的版本号在这里不可信**：中断之后 dev 完全可能已经又往前走了。
  NEW_VER="$(git show "${MASTER_SHA}:package.json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"
  OLD_VER="$NEW_VER"
  TAG="v$NEW_VER"
  BUMP="—"
  BUMP_SOURCE="收尾，不 bump"
  # 【判据是「指向别处」而不是「存在」】收尾有两个断点：tag 没打（此时 $TAG 不该存在），
  # 和 tag 打了但 Release 没建成（此时 $TAG 就该存在、且正指向 master 的 HEAD）。
  # 光判「存在」会把后一种正常状态当成矛盾直接 die，那个断点就又救不回来了。
  if git rev-parse "$TAG" >/dev/null 2>&1 \
     && [ "$(git rev-parse "${TAG}^{commit}")" != "$MASTER_SHA" ]; then
    die "自相矛盾：$TAG 已存在，却不指向 origin/master 的 HEAD（${MASTER_SHA:0:8}）。请人工核对后再跑。"
  fi
elif ! git rev-parse "$CUR_TAG" >/dev/null 2>&1 && [ "${RESUME_COMMITS:-0}" -gt 0 ]; then
  # ② 续跑：上一次停在「已提交 vX 并推了 dev，但 PR 没合 / tag 没打」。
  #
  # 【为什么判据不看 HEAD 的 subject】那个判据太脆：中断之后但凡往 dev 上再合一个修复（比如修
  # 本脚本自己的 bug——2026-09-12 就真发生了），HEAD 就不再是发版提交，脚本会当成全新一轮再
  # bump 一次，把已经推出去的 1.8.0 变成 1.8.1。判据要认的是「这一版发完没有」，
  # 而不是「上一条提交是什么」。
  NEW_VER="$OLD_VER"
  TAG="$CUR_TAG"
  RESUMING=1
  BUMP="—"
  BUMP_SOURCE="续跑，不 bump"
  say "▶ 检测到上次发版中断在「已提交 ${TAG}、尚未打 tag」——接着往下走，不再 bump"
else
  # ③ 全新一轮。没显式给递增方式时，按 conventional commits 从提交历史推导。
  #
  # 【为什么要它】旧默认是写死的 patch。而 v1.7.0→HEAD 这一批里有 23 个 feat，照默认发出去就是
  # 1.7.1——版本号对使用者谎称「只是修了几个 bug」。递增方式本该是提交历史的函数，不是一个每次
  # 都要人记得覆盖的参数（记不记得，取决于发版的人当时有没有想起来看一眼 git log）。
  # 显式传参仍然优先：推导错了要能当场压过它，不必改脚本。
  BUMP_SOURCE="显式指定"
  if [ -z "$BUMP" ]; then
    BUMP_SOURCE="按提交历史推导"
    BUMP_RANGE="${LAST_TAG:+$LAST_TAG..}HEAD"
    # 【必须用 grep -c 而不是 grep -q】理由同上面 RESUME_COMMITS 那条：pipefail 下命中即 SIGPIPE，
    # 症状是**命中反而当没命中**，23 个 feat 的这一批会被推导成 patch。
    # 2026-09-12 踩到时是在交互 shell 里手动验证的（那里没有 pipefail），看到的是正确结果，
    # 而脚本跑出来是错的。验证环境和真实环境不一致，比没验证更能骗人。
    # grep -c 会读完整个输入，不产生 SIGPIPE；无匹配时它返回 1，用 `|| true` 接住。
    BREAKING_N="$(git log --no-merges --pretty='%s%n%b' "$BUMP_RANGE" | grep -cE '^BREAKING CHANGE:|^[a-z]+(\([^)]*\))?!:' || true)"
    FEAT_N="$(git log --no-merges --pretty='%s' "$BUMP_RANGE" | grep -cE '^feat(\([^)]*\))?:' || true)"
    if [ "${BREAKING_N:-0}" -gt 0 ]; then
      BUMP=major
    elif [ "${FEAT_N:-0}" -gt 0 ]; then
      BUMP=minor
    else
      BUMP=patch
    fi
  fi

  # 【dry-run 必须真的不写盘】旧代码在这里无条件跑 npm version，改了 package.json/lock、又写了
  # verifiedWith，再靠 trap 还原，却打印「未改动任何东西」。而 `npm version --dry-run`
  # **也会写盘**（npm 11.6.2 实测，与 --no-git-tag-version 同时给出时照改不误），指望它没用。
  # 所以 dry-run 自己算：本脚本只接受 patch|minor|major|X.Y.Z 四种形态，递增逻辑就这么多。
  if [ -n "$DRY" ]; then
    NEW_VER="$(BUMP="$BUMP" OLD="$OLD_VER" node -e '
      const m = process.env.BUMP;
      if (/^\d+\.\d+\.\d+$/.test(m)) { console.log(m); process.exit(0); }
      const [a, b, c] = process.env.OLD.split(".").map(Number);
      console.log((m === "major" ? [a + 1, 0, 0] : m === "minor" ? [a, b + 1, 0] : [a, b, c + 1]).join("."));
    ')"
  else
    npm version "$BUMP" --no-git-tag-version >/dev/null   # 改 package.json/lock（trap 会在非成功路径还原）
    NEW_VER="$(node -p "require('./package.json').version")"
  fi
  TAG="v$NEW_VER"
  git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG 已存在"

  # 把 CLI 版本写回 package.json：这是全仓库【唯一】记录它的地方，README 的动态徽章直接读它，
  # 因此不存在"两处版本号各写各的"的漂移面。用 node 读写不用 sed（同 render-plist.js 的纪律：
  # 裸 sed 遇到特殊字符会生成非法内容）。
  if [ -z "$DRY" ]; then
    CLI_VER="$CLI_VER" node -e '
      const fs = require("fs");
      const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
      pkg.verifiedWith = { ...pkg.verifiedWith, claudeCli: process.env.CLI_VER };
      fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
    '
  fi
fi

# ── 生成发布说明 ─────────────────────────────────────
# 【收尾模式下区间终点是 master 而不是 HEAD】要补的 Release 描述的是**已经合进 master 的那
# 一版**，不是 dev 现在长什么样。中断到重跑之间 dev 完全可能已经又往前走了，拿 HEAD 会把
# 一批还没发布的提交写进一个已发布版本的说明里 —— 而 Release notes 发出去就收不回。
RANGE_END="HEAD"
if [ -n "$FINALIZING" ]; then RANGE_END="$MASTER_SHA"; fi

NOTES="$(mktemp)"
{
  [ -n "$LAST_TAG" ] && echo "Changes since $LAST_TAG." || echo "Initial release."
  echo
  echo "### Verified environment"
  echo "- claude CLI: $CLI_VER"
  echo "- Agent SDK: @anthropic-ai/claude-agent-sdk $SDK_VER"
  echo
  RANGE="${LAST_TAG:+$LAST_TAG..}$RANGE_END"
  feats="$(git log --no-merges --pretty='- %s' "$RANGE" | grep -E '^- feat' || true)"
  fixes="$(git log --no-merges --pretty='- %s' "$RANGE" | grep -E '^- fix' || true)"
  other="$(git log --no-merges --pretty='- %s' "$RANGE" | grep -vE '^- (feat|fix|chore: 发版)' || true)"
  [ -n "$feats" ] && { echo "### Features"; echo "$feats"; echo; }
  [ -n "$fixes" ] && { echo "### Fixes";    echo "$fixes"; echo; }
  [ -n "$other" ] && { echo "### Other";    echo "$other"; echo; }
  [ -n "$LAST_TAG" ] && echo "**Full Changelog**: https://github.com/$REPO/compare/$LAST_TAG...$TAG"
} > "$NOTES"

# ── 展示计划 ─────────────────────────────────────────
say "─────────────────────────────────────────"
if [ -n "$FINALIZING" ]; then
  say " 收尾 $TAG   （在 origin/master ${MASTER_SHA:0:8} 上补 tag 与 Release）"
  say " 路径：tag → Release（不 bump、不推 dev、不开 PR）"
else
  say " 发版 $OLD_VER → $NEW_VER   (tag $TAG)   [$BUMP · $BUMP_SOURCE]"
  say " dev 相对 master 领先 $AHEAD 个 commit"
  say " 路径：推 dev → 等 CI → PR(dev→master) → 等 CI → 合并 → tag → Release"
fi
say " 上个 tag：${LAST_TAG:-（无）}"
say "─────────────────────────────────────────"
sed 's/^/ │ /' "$NOTES"
say "─────────────────────────────────────────"

[ -n "$DRY" ] && { say "✓ DRY RUN —— 未改动任何东西"; exit 0; }
if [ -z "$YES" ]; then
  if [ -n "$FINALIZING" ]; then
    read -r -p "补打 tag $TAG + 建 Release？[y/N] " ans
  else
    read -r -p "推 dev + 开 PR + 等 CI + 合并 master + 打 tag + 建 Release？[y/N] " ans
  fi
  [ "$ans" = y ] || [ "$ans" = Y ] || die "已取消"
fi

# ── 执行：提交 + 推 dev + PR ──────────────────────────
# 收尾模式整段跳过：master 上已经有这一版的代码与 CHANGELOG，PR 也早就合了，要补的只是
# 下面的 tag 与 Release。
if [ -z "$FINALIZING" ]; then
  if [ -z "$RESUMING" ]; then
    write_changelog "$TAG" "$NOTES"
    git add package.json package-lock.json CHANGELOG.md
    git commit -q -m "chore: 发版 $TAG"
    git push -q origin dev || die "推送 dev 失败"
  else
    # 【为什么续跑也要写一次 CHANGELOG】中断之后 dev 上可能又合进了修复，它们会进 Release
    # notes（NOTES 的区间一直算到 HEAD），而 CHANGELOG.md 停在上一次写的内容 —— 两者就此
    # 分叉。而「与 Release notes 同源」正是把 CHANGELOG 落进仓库的全部理由（见 write_changelog）。
    # 没有新内容时 write_changelog 产出与现状逐字节相同，下面的 git status 为空，什么也不做。
    write_changelog "$TAG" "$NOTES"
    if [ -n "$(git status --porcelain CHANGELOG.md)" ]; then
      say "▶ 发版提交之后 dev 又有新内容，同步 CHANGELOG.md（会多等一轮 CI）"
      git add CHANGELOG.md
      git commit -q -m "chore: 同步 $TAG 变更记录"
      git push -q origin dev || die "推送 dev 失败"
    fi
  fi
  DEV_SHA="$(git rev-parse dev)"
  wait_ci_for_sha "$DEV_SHA" "dev"

  # ── PR(dev→master)：已存在就复用 ──────────────────────
  PR="$(gh pr list --base master --head dev --state open --limit 1 --json number -q '.[0].number' 2>/dev/null || true)"
  if [ -z "$PR" ] || [ "$PR" = "null" ]; then
    say "▶ 开 PR dev → master"
    gh pr create --base master --head dev --title "release $TAG" --body-file "$NOTES" >/dev/null \
      || die "开 PR 失败"
    PR="$(gh pr list --base master --head dev --state open --limit 1 --json number -q '.[0].number')"
  else
    say "▶ 复用已开的 PR #${PR}（更新标题与说明）"
    gh pr edit "$PR" --title "release $TAG" --body-file "$NOTES" >/dev/null || true
  fi
  say "  PR #$PR"

  # ── 等 PR 可合并，然后合并 ────────────────────────────
  # 【为什么 dev 那轮绿了还要再等一次】开 PR 会**另外**触发一轮（pull_request 事件），
  # 分支保护认的是最新那批。两批 check-runs 挂在**同一个 head commit** 上——实测
  # `commits/<sha>/check-runs` 里同名 job 各出现两次，一批 completed 一批 in_progress，
  # 所以「按名字看必需检查是否全绿」会看到早已完成的第一批。判据交给 GitHub 自己算。
  wait_pr_mergeable "$PR"
  gh pr merge "$PR" --merge --body "release $TAG" >/dev/null || die "合并 PR #$PR 失败"
  say "  ✓ 已合并 PR #$PR"
fi

# ── tag 打在合并后的 master HEAD 上 ───────────────────
git fetch -q origin master || die "fetch master 失败"
MASTER_SHA="$(git rev-parse origin/master)"
# 【判据必须查远端，不能查本地】`git rev-parse "$TAG"` 成功只说明 tag **建**过，不说明**推**上去了。
# 旧写法在「tag -a 成功、push 失败」之后重跑会跳过整个 else 分支（连 push 一起跳过），于是下面
# 的 `gh release create --verify-tag` 永远在远端查不到 tag —— 每一次重跑都死在同一个地方，
# 而本地看起来一切正常（tag 明明在）。
if [ -n "$(git ls-remote --tags origin "refs/tags/$TAG")" ]; then
  say "▶ tag $TAG 远端已存在，跳过创建"
else
  git rev-parse "$TAG" >/dev/null 2>&1 || git tag -a "$TAG" -m "$TAG" "$MASTER_SHA"
  git push -q origin "$TAG" || die "推送 tag 失败"
fi
say "  ✓ tag $TAG → ${MASTER_SHA:0:8}"

# GitHub Release 作幂等 reconciliation：已存在（如上一次跑到这里网络抖断）则改为 edit。
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release edit "$TAG" --title "$TAG" --notes-file "$NOTES" --latest >/dev/null
else
  gh release create "$TAG" --title "$TAG" --notes-file "$NOTES" --latest --verify-tag >/dev/null
fi

say ""
say "✓ 已发布 $TAG → https://github.com/$REPO/releases/tag/$TAG"
say "  装机归档：https://github.com/$REPO/archive/refs/heads/master.tar.gz"

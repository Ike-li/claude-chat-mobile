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
# 「master HEAD 必须有 tag」那道闸（tests/gates/check-master-released.js）会红，
# 而 /archive/refs/tags/ 拿到的也会是一棵没被发布的树。
#
# 【为什么不用把 master 合回 dev】merge commit 的父之一就是 dev 的 tip，下次开 PR 时
# GitHub 算出的 merge base 仍然正确。省掉这一步就不必为了同步去绕过 dev 的分支保护。
#
# 内建护栏（都是踩过的坑）：
#   · 预检：干净工作树 / 在 dev / dev 相对 master 有新提交 / 本地与远程一致 / tag 不重复
#   · 每一步都等真 CI 绿（dev 推送后一次、PR 合并前一次）
#   · 幂等 reconciliation：中途失败后重跑不会二次 bump、不会撞「PR/Release 已存在」
#   · trap 还原**尚未提交**的 bump（提交并推送之后就交给下面的幂等逻辑，不再回滚公开历史）
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

NOTES=""
COMMITTED=""     # bump 已提交：此后不再 checkout 还原 package.json
cleanup() {
  # 只还原**没提交**的 bump 与 CHANGELOG。一旦提交并推到 dev，历史已经公开，回滚它比留着更糟——
  # 重跑时下面的「已是目标版本就跳过 bump」会把它接上。
  # CHANGELOG.md 是 tracked 文件（初始版本随本次改造一起提交），所以 checkout 一定还原得掉。
  [ -z "$COMMITTED" ] && { git checkout -q -- package.json package-lock.json CHANGELOG.md 2>/dev/null || true; }
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
    const body = fs.readFileSync(process.env.NOTES_FILE, "utf8").trim();
    const entry = `\n## ${process.env.TAG} — ${process.env.DATE}\n\n${body}\n`;
    let rest = "";
    if (fs.existsSync("CHANGELOG.md")) {
      const cur = fs.readFileSync("CHANGELOG.md", "utf8");
      rest = cur.startsWith(head) ? cur.slice(head.length) : `\n${cur}`;
    }
    fs.writeFileSync("CHANGELOG.md", head + entry + rest);
  '
}
trap cleanup EXIT

# ── 预检 ─────────────────────────────────────────────
command -v gh >/dev/null || die "需要 gh CLI"
gh auth status >/dev/null 2>&1 || die "gh 未登录：先 gh auth login"
[ -z "$(git status --porcelain)" ] || { git status -s; die "工作树不干净，先提交或暂存"; }

git fetch -q origin || die "git fetch 失败（网络？）"
BR="$(git rev-parse --abbrev-ref HEAD)"
[ "$BR" = "dev" ] || die "请在 dev 分支发版（当前在 $BR）"
# 【不再要求 master 是 dev 的祖先】走 PR 之后 master 上会有 merge commit，那是正常状态。
# 真正要问的是「有没有东西可发」——用 GitHub 算的比较结果，它和 PR 看到的是同一份。
AHEAD="$(gh api "repos/{owner}/{repo}/compare/master...dev" -q '.ahead_by' 2>/dev/null || echo 0)"
[ "$AHEAD" -gt 0 ] || die "dev 相对 master 没有新提交，无可发"
R="$(git ls-remote origin refs/heads/dev | cut -f1)"
[ -z "$R" ] || [ "$(git rev-parse dev)" = "$R" ] || die "本地 dev 与 origin/dev 不一致，先同步"

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

# ── 算版本号 ─────────────────────────────────────────
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
# 仓库名从本地 remote 解析，不打 GitHub API（GraphQL 在代理下会 EOF）
REPO="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
OLD_VER="$(node -p "require('./package.json').version")"

# 没显式给递增方式时，按 conventional commits 从提交历史推导。
#
# 【为什么要它】旧默认是写死的 patch。而 v1.7.0→HEAD 这一批里有 23 个 feat，照默认发出去就是
# 1.7.1——版本号对使用者谎称「只是修了几个 bug」。递增方式本该是提交历史的函数，不是一个每次
# 都要人记得覆盖的参数（记不记得，取决于发版的人当时有没有想起来看一眼 git log）。
# 显式传参仍然优先：推导错了要能当场压过它，不必改脚本。
BUMP_SOURCE="显式指定"
if [ -z "$BUMP" ]; then
  BUMP_SOURCE="按提交历史推导"
  BUMP_RANGE="${LAST_TAG:+$LAST_TAG..}HEAD"
  # 【必须用 grep -c 而不是 grep -q】本脚本开了 `set -o pipefail`，而 `grep -q` 命中第一条就退出，
  # 上游的 `git log` 随即收到 SIGPIPE 而非 0 退出 —— 整个管道被判失败，if 取假。症状是**命中
  # 反而当没命中**：23 个 feat 的这一批会被推导成 patch。
  # 2026-09-12 实测踩到：当时在交互 shell 里手动验证（那里没有 pipefail）看到的是正确结果，
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

# 幂等：上一次跑到一半（bump 已提交并推了 dev，但 PR 没合/tag 没打）时重跑，不能再 bump 一次。
# 判据是「HEAD 的提交就是发版提交，且它的 tag 还不存在」——那说明我们正停在那一步，接着往下走即可。
RESUMING=""
HEAD_SUBJECT="$(git log -1 --pretty=%s)"
if [[ "$HEAD_SUBJECT" == chore:\ 发版\ v* ]] && ! git rev-parse "${HEAD_SUBJECT##* }" >/dev/null 2>&1; then
  NEW_VER="${OLD_VER}"
  TAG="${HEAD_SUBJECT##* }"
  RESUMING=1
  COMMITTED=1
  say "▶ 检测到上次发版中断在「已提交 $TAG、尚未打 tag」——接着往下走，不再 bump"
else
  npm version "$BUMP" --no-git-tag-version >/dev/null   # 改 package.json/lock（trap 会在非成功路径还原）
  NEW_VER="$(node -p "require('./package.json').version")"
  TAG="v$NEW_VER"
  git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG 已存在"

  # 把 CLI 版本写回 package.json：这是全仓库【唯一】记录它的地方，README 的动态徽章直接读它，
  # 因此不存在"两处版本号各写各的"的漂移面。用 node 读写不用 sed（同 render-plist.js 的纪律：
  # 裸 sed 遇到特殊字符会生成非法内容）。
  CLI_VER="$CLI_VER" node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    pkg.verifiedWith = { ...pkg.verifiedWith, claudeCli: process.env.CLI_VER };
    fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  '
fi

# ── 生成发布说明 ─────────────────────────────────────
NOTES="$(mktemp)"
{
  [ -n "$LAST_TAG" ] && echo "Changes since $LAST_TAG." || echo "Initial release."
  echo
  echo "### Verified environment"
  echo "- claude CLI: $CLI_VER"
  echo "- Agent SDK: @anthropic-ai/claude-agent-sdk $SDK_VER"
  echo
  RANGE="${LAST_TAG:+$LAST_TAG..}HEAD"
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
say " 发版 $OLD_VER → $NEW_VER   (tag $TAG)   [$BUMP · $BUMP_SOURCE]"
say " dev 相对 master 领先 $AHEAD 个 commit"
say " 路径：推 dev → 等 CI → PR(dev→master) → 等 CI → 合并 → tag → Release"
say " 上个 tag：${LAST_TAG:-（无）}"
say "─────────────────────────────────────────"
sed 's/^/ │ /' "$NOTES"
say "─────────────────────────────────────────"

[ -n "$DRY" ] && { say "✓ DRY RUN —— 未改动任何东西"; exit 0; }
if [ -z "$YES" ]; then
  read -r -p "推 dev + 开 PR + 等 CI + 合并 master + 打 tag + 建 Release？[y/N] " ans
  [ "$ans" = y ] || [ "$ans" = Y ] || die "已取消"
fi

# ── 等某个 sha 的 CI 跑完 ──────────────────────────────
# push 触发的 run 不是立刻就有的，先轮询等它出现，再 watch。
# 【为什么不用 `gh run watch` 的裸调用】它要一个 run id；不按 headSha 挑就可能盯上**上一次**
# 推送的 run，那个早就绿了，于是「等 CI」变成一句空话。
wait_ci_for_sha() {
  local sha="$1" label="$2" run_id="" tries=0
  say "▶ 等 $label 的 CI（sha ${sha:0:8}）…"
  while [ "$tries" -lt 40 ]; do
    run_id="$(gh run list --branch dev --event push --limit 15 --json databaseId,headSha \
      -q "[.[] | select(.headSha == \"$sha\")] | .[0].databaseId" 2>/dev/null || true)"
    [ -n "$run_id" ] && [ "$run_id" != "null" ] && break
    run_id=""; tries=$((tries + 1)); sleep 5
  done
  [ -n "$run_id" ] || die "等不到 $label 的 CI run（sha ${sha:0:8}）——GitHub 侧没有为这次推送建 run？"
  say "  run $run_id"
  gh run watch "$run_id" --exit-status >/dev/null \
    || die "$label 的 CI 未通过（run $run_id）。修好再重跑本脚本，它会从中断处接上。"
  say "  ✓ $label CI 通过"
}

# ── 执行：提交 + 推 dev ───────────────────────────────
if [ -z "$RESUMING" ]; then
  write_changelog "$TAG" "$NOTES"
  git add package.json package-lock.json CHANGELOG.md
  git commit -q -m "chore: 发版 $TAG"
  COMMITTED=1
  git push -q origin dev || die "推送 dev 失败"
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
  say "▶ 复用已开的 PR #$PR（更新标题与说明）"
  gh pr edit "$PR" --title "release $TAG" --body-file "$NOTES" >/dev/null || true
fi
say "  PR #$PR"

# ── 等 PR 的 required checks，然后合并 ────────────────
# PR 跑的是 merge ref（master 与 dev 的虚拟合并），与上面 dev 分支上那次不是同一个提交，
# 必须各等各的——分支保护认的也正是 PR 这一侧。
say "▶ 等 PR #$PR 的检查…"
gh pr checks "$PR" --watch --fail-fast >/dev/null \
  || die "PR #$PR 的检查未通过。修好再重跑本脚本。"
say "  ✓ PR 检查通过"
gh pr merge "$PR" --merge --body "release $TAG" >/dev/null || die "合并 PR #$PR 失败"
say "  ✓ 已合并 PR #$PR"

# ── tag 打在合并后的 master HEAD 上 ───────────────────
git fetch -q origin master || die "fetch master 失败"
MASTER_SHA="$(git rev-parse origin/master)"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  say "▶ tag $TAG 已存在，跳过创建"
else
  git tag -a "$TAG" -m "$TAG" "$MASTER_SHA"
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

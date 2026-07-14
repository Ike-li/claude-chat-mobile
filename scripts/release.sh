#!/usr/bin/env bash
# scripts/release.sh —— 一条命令发版：bump → dev→master(ff) → tag → GitHub Release
#
# 分支模型（见 docs/design.md §7）：dev=开发线、master=稳定发布线。
# 发版 = 把 dev 快进合并进 master、打 tag、建 GitHub Release、两分支都推。
#
# 用法：
#   scripts/release.sh [patch|minor|major|X.Y.Z] [--dry-run] [-y]
#     位置参数=版本递增方式（默认 patch）；也可给显式版本号如 1.2.0
#     --dry-run / -n   只做预检+CI模拟+显示计划，不改动任何东西
#     -y / --yes       跳过交互确认（自动化用）
#
# 内建护栏（都是踩过的坑）：
#   · 发版前 `CI=true npm test` 模拟 CI，红了就中止（防推完才发现 CI 挂）
#   · 推 master 后用 `git ls-remote` 复核真到位了（git push 曾静默没推上去）
#   · trap 保证任何中途退出都还原被 bump 的 package.json（不留脏工作树）
#   · 预检：干净工作树 / 在 dev / dev 领先 master 且可 ff / 本地与远程一致 / tag 不重复
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BUMP="patch"; DRY=""; YES=""
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
TAG=""            # 中途失败时的清理需要判断 tag 是否已建、是否已确认推送（下方两个标记）
TAG_PUSHED=""
SUCCESS=""
# 任何退出（成功/失败/取消/中断）都跑：还原未提交的 bump + 删临时文件。
# 提交之后 package.json 已 == HEAD，checkout 是无操作，故对成功路径无害。
# 非成功退出额外收拾两处此前会留脏状态的坑：
#   · tag 已建但未确认推送 → 删本地 tag，防重跑撞"tag 已存在"（无法恢复只能人工诊断）
#   · 中途失败可能停在 master（已 checkout/merge 但未推完）→ 切回 dev，不留用户手动摸索
cleanup() {
  git checkout -q -- package.json package-lock.json 2>/dev/null || true
  [ -n "$NOTES" ] && rm -f "$NOTES" || true
  if [ -z "$SUCCESS" ]; then
    if [ -n "$TAG" ] && [ -z "$TAG_PUSHED" ] && git rev-parse "$TAG" >/dev/null 2>&1; then
      git tag -d "$TAG" >/dev/null 2>&1 || true
    fi
    CUR="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    [ "$CUR" = "master" ] && { git checkout -q dev 2>/dev/null || true; } || true
  fi
}
trap cleanup EXIT

# ── 预检 ─────────────────────────────────────────────
command -v gh >/dev/null || die "需要 gh CLI"
gh auth status >/dev/null 2>&1 || die "gh 未登录：先 gh auth login"
[ -z "$(git status --porcelain)" ] || { git status -s; die "工作树不干净，先提交或暂存"; }

git fetch -q origin || die "git fetch 失败（网络？）"
BR="$(git rev-parse --abbrev-ref HEAD)"
[ "$BR" = "dev" ] || die "请在 dev 分支发版（当前在 $BR）"
git merge-base --is-ancestor master dev || die "master 不是 dev 的祖先、无法 ff（先把 master 并回 dev）"
AHEAD="$(git rev-list --count master..dev)"
[ "$AHEAD" -gt 0 ] || die "dev 相对 master 没有新提交，无可发"
for b in dev master; do
  R="$(git ls-remote origin "refs/heads/$b" | cut -f1)"
  [ -z "$R" ] || [ "$(git rev-parse "$b")" = "$R" ] || die "本地 $b 与 origin/$b 不一致，先同步"
done

# ── 发版前 CI 模拟（关键护栏）──────────────────────────
say "▶ 发版前模拟 CI：CI=true npm test …"
CI=true npm test >/tmp/release-citest.log 2>&1 || { tail -20 /tmp/release-citest.log; die "CI 模拟未通过，中止（详见 /tmp/release-citest.log）"; }
say "  ✓ CI 模拟通过"

# ── 算版本号 + 生成发布说明 ───────────────────────────
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
# 仓库名从本地 remote 解析，不打 GitHub API（GraphQL 在代理下会 EOF）
REPO="$(git remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
OLD_VER="$(node -p "require('./package.json').version")"
npm version "$BUMP" --no-git-tag-version >/dev/null   # 改 package.json/lock（trap 会在非成功路径还原）
NEW_VER="$(node -p "require('./package.json').version")"
TAG="v$NEW_VER"
git rev-parse "$TAG" >/dev/null 2>&1 && die "tag $TAG 已存在"

NOTES="$(mktemp)"
{
  [ -n "$LAST_TAG" ] && echo "Changes since $LAST_TAG." || echo "Initial release."
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
say " 发版 $OLD_VER → $NEW_VER   (tag $TAG)"
say " dev 领先 master $AHEAD 个 commit，将 ff 合并并公开"
say " 上个 tag：${LAST_TAG:-（无）}"
say "─────────────────────────────────────────"
sed 's/^/ │ /' "$NOTES"
say "─────────────────────────────────────────"

[ -n "$DRY" ] && { SUCCESS=1; say "✓ DRY RUN —— 未改动任何东西"; exit 0; }
if [ -z "$YES" ]; then
  read -r -p "推 master/dev + 打 tag + 建 Release？[y/N] " ans
  [ "$ans" = y ] || [ "$ans" = Y ] || die "已取消"
fi

# ── 执行 ─────────────────────────────────────────────
git add package.json package-lock.json
git commit -q -m "chore: 发版 $TAG"
git checkout -q master
git merge --ff-only dev >/dev/null
# WS-012：先在本地建好 tag，再用 `git push --atomic` 一次性推 master + dev + tag——任一 ref 被拒则整批回滚，
# 杜绝旧实现「四次独立 push 中途失败留下远端部分发布（master 推了但 tag/dev 没推）、重跑又被空 diff / 既有 tag
# 阻断」的部分发布态。master 已 ff 自 dev，两 ref 同指发版 commit、tag 指 master，三者一致。
git tag -a "$TAG" -m "$TAG" master
git push --atomic origin master dev "$TAG"
TAG_PUSHED=1   # 原子推送整体成功：cleanup 不应再删本地 tag
sleep 2
[ "$(git ls-remote origin refs/heads/master | cut -f1)" = "$(git rev-parse master)" ] || die "origin/master 未更新到位（push 可能静默失败），请手动检查后重试"
git checkout -q dev
# GitHub Release 作幂等 reconciliation：已存在（如上一次跑到这里网络抖断）则改为 edit，不因「release 已存在」中止。
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release edit "$TAG" --title "$TAG" --notes-file "$NOTES" --latest
else
  gh release create "$TAG" --title "$TAG" --notes-file "$NOTES" --latest --verify-tag
fi
SUCCESS=1      # 全流程完成：cleanup 跳过"删 tag / 切回 dev"的失败态收拾

say ""
say "✓ 已发布 $TAG → https://github.com/$REPO/releases/tag/$TAG"
say "  盯 CI：gh run watch \$(gh run list --branch master -L1 --json databaseId -q '.[0].databaseId') --exit-status"

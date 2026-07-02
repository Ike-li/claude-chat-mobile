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
#     -y / --yes       跳过交互确认（CI/自动化用）
#
# 内建护栏（都是踩过的坑）：
#   · 发版前 `CI=true npm test` 模拟 CI，红了就中止（防 v1.1.0 那种推完才发现 CI 挂）
#   · 推 master 后用 `git ls-remote` 复核真到位了（git push 曾静默没推上去）
#   · 预检：干净工作树 / 在 dev / dev 领先 master 且可 ff / tag 不重复
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

# ── 预检 ─────────────────────────────────────────────
command -v gh >/dev/null || die "需要 gh CLI"
gh auth status >/dev/null 2>&1 || die "gh 未登录：先 gh auth login"
[ -z "$(git status --porcelain)" ] || { git status -s; die "工作树不干净，先提交或暂存"; }

git fetch -q origin
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
CI=true npm test >/tmp/release-citest.log 2>&1 || { tail -20 /tmp/release-citest.log; die "CI 模拟测试未通过，中止发版（详见 /tmp/release-citest.log）"; }
say "  ✓ CI 模拟通过"

# ── 算版本号 + 生成发布说明 ───────────────────────────
LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
OLD_VER="$(node -p "require('./package.json').version")"
npm version "$BUMP" --no-git-tag-version >/dev/null   # 改 package.json/lock（dry-run/取消会还原）
NEW_VER="$(node -p "require('./package.json').version")"
TAG="v$NEW_VER"
restore() { git checkout -q -- package.json package-lock.json 2>/dev/null || true; }
git rev-parse "$TAG" >/dev/null 2>&1 && { restore; die "tag $TAG 已存在"; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
NOTES="$(mktemp)"
{
  if [ -n "$LAST_TAG" ]; then echo "Changes since $LAST_TAG."; else echo "Initial release."; fi
  echo
  RANGE="${LAST_TAG:+$LAST_TAG..}HEAD"
  feats="$(git log --no-merges --pretty='- %s' "$RANGE" | grep -E '^- feat' || true)"
  fixes="$(git log --no-merges --pretty='- %s' "$RANGE" | grep -E '^- fix' || true)"
  other="$(git log --no-merges --pretty='- %s' "$RANGE" | grep -vE '^- (feat|fix|chore: 发版)' || true)"
  [ -n "$feats" ] && { echo "### Features"; echo "$feats"; echo; }
  [ -n "$fixes" ] && { echo "### Fixes"; echo "$fixes"; echo; }
  [ -n "$other" ] && { echo "### Other"; echo "$other"; echo; }
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

if [ -n "$DRY" ]; then restore; rm -f "$NOTES"; say "✓ DRY RUN —— 未改动任何东西"; exit 0; fi
if [ -z "$YES" ]; then
  read -r -p "推 master/dev + 打 tag + 建 Release？[y/N] " ans
  [ "$ans" = y ] || [ "$ans" = Y ] || { restore; rm -f "$NOTES"; die "已取消"; }
fi

# ── 执行 ─────────────────────────────────────────────
git add package.json package-lock.json
git commit -q -m "chore: 发版 $TAG"
git checkout -q master
git merge --ff-only dev >/dev/null
git push origin master
sleep 2
[ "$(git ls-remote origin refs/heads/master | cut -f1)" = "$(git rev-parse master)" ] || die "origin/master 未更新到位（push 可能静默失败），请手动检查后重试"
git tag -a "$TAG" -m "$TAG" master
git push origin "$TAG"
git checkout -q dev
git push origin dev
gh release create "$TAG" --title "$TAG" --notes-file "$NOTES" --latest --verify-tag
rm -f "$NOTES"

say ""
say "✓ 已发布 $TAG → $(gh release view "$TAG" --json url -q .url)"
say "  盯 CI：gh run watch \$(gh run list --branch master -L1 --json databaseId -q '.[0].databaseId') --exit-status"

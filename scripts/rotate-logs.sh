#!/bin/bash
# rotate-logs.sh —— copy-truncate 日志轮转（macOS LaunchAgent 部署场景）
#
# 为什么不用 newsyslog/logrotate 的 rename 式轮转：常驻服务的 stdout/stderr 是
# launchd 按 StandardOutPath 打开后传给进程的 fd，进程不会重开日志文件——rename 后
# 进程继续写旧 inode，新文件永远是空的。launchd 以 O_APPEND 打开该 fd（lsof +fg 实测
# FILE-FLAG 含 AP），因此对原文件 copy + truncate 后，后续写入自动落到新 EOF，无空洞。
#
# 用法: rotate-logs.sh [--max-mb N] [--keep N] [logfile ...]
#   不带文件参数时默认轮转 ~/Library/Logs/ 下 ccm-server.log / ccm-tunnel.log（对应部署文档里的两个常驻进程）。
#   超过 --max-mb（默认 20）才轮转；归档 gzip 保留 --keep（默认 5）份：<f>.0.gz（最新）… <f>.4.gz。
#
# 已知窗口：cp 与 truncate 之间写入的行会丢（亚秒级），日志场景可接受。
set -euo pipefail

MAX_MB=20
KEEP=5
FILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --max-mb) MAX_MB="$2"; shift 2 ;;
    --keep)   KEEP="$2";   shift 2 ;;
    *)        FILES+=("$1"); shift ;;
  esac
done
if [ ${#FILES[@]} -eq 0 ]; then
  FILES=("$HOME/Library/Logs/ccm-server.log" \
         "$HOME/Library/Logs/ccm-tunnel.log")
fi

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue
  size_mb=$(( $(stat -f%z "$f") / 1024 / 1024 ))
  [ "$size_mb" -ge "$MAX_MB" ] || continue

  # 归档后移一位：.<KEEP-1>.gz 淘汰，.<i>.gz → .<i+1>.gz
  i=$((KEEP - 1))
  rm -f "$f.$i.gz"
  while [ "$i" -gt 0 ]; do
    prev=$((i - 1))
    if [ -f "$f.$prev.gz" ]; then mv "$f.$prev.gz" "$f.$i.gz"; fi
    i=$prev
  done

  cp "$f" "$f.0"
  : > "$f"
  gzip -f "$f.0"
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') rotated $f (${size_mb}MB) -> $f.0.gz"
done

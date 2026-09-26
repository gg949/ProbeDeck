#!/bin/sh
# ──────────────────────────────────────────────────────────────
# ProbeDeck 容器入口（v2.11.3 起）：主进程以非 root（node 用户）运行。
#   • 以 root 启动时：先修正数据目录属主（兼容旧的 root 属主挂载），
#     再用 setpriv 降权；node:24-bookworm-slim 自带 setpriv，无需额外安装。
#   • 以非 root 启动时（如 docker run --user）：直接执行。
#   • chown 失败（如只读挂载）不视为致命错误，仍尝试降权运行。
#   • 未设置 NODE_OPTIONS 时：按容器内存上限自动设置 V8 堆上限（见下），
#     避免 V8 按宿主机内存计算堆上限、导致小容器内存缓慢膨胀。
# ──────────────────────────────────────────────────────────────
set -e

# ── V8 堆上限自动兜底（仅在未显式设置 NODE_OPTIONS 时生效）────────
# 背景：V8 默认堆上限按「宿主机物理内存」计算、不看容器限制；小容器跑在
# 大内存宿主机上时堆会缓慢膨胀（水位效应），可能触发容器 OOM。
# 规则：取容器内存上限的 1/5，限制在 64–384MB；识别不到上限时用 256MB。
# 任何异常均跳过（退回 Node 默认行为），不会阻断容器启动。
if [ -z "${NODE_OPTIONS:-}" ]; then
  _pd_limit=""
  if [ -r /sys/fs/cgroup/memory.max ]; then
    _pd_limit=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || true)
    if [ "$_pd_limit" = "max" ]; then _pd_limit=""; fi
  elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    _pd_limit=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || true)
  fi
  case "$_pd_limit" in
    ''|*[!0-9]*|????????????????*) _pd_mb=256 ;;
    *)
      _pd_mb=$(( _pd_limit / 1048576 / 5 ))
      if [ "$_pd_mb" -lt 64 ]; then _pd_mb=64; fi
      if [ "$_pd_mb" -gt 384 ]; then _pd_mb=384; fi
      ;;
  esac
  export NODE_OPTIONS="--max-old-space-size=$_pd_mb"
  echo "[entrypoint] 未设置 NODE_OPTIONS，已按容器内存上限自动设置 --max-old-space-size=$_pd_mb"
fi

if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"

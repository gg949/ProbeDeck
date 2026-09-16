#!/bin/sh
# ProbeDeck 通用卸载脚本
# 支持 Go 版探针（cf-probe 二进制）与旧版 shell 探针
# 平台: systemd、OpenRC、OpenWrt procd、Synology DSM rc.d、macOS launchd

set -eu

SERVICE_NAME="cf-probe"
GO_BINARY="/usr/local/bin/${SERVICE_NAME}"
ASSUME_YES=0

info() { printf '%s\n' "[+] $*"; }
warn() { printf '%s\n' "[!] $*" >&2; }
die() { printf '%s\n' "[x] $*" >&2; exit 1; }

usage() {
    cat <<'EOF'
用法: sudo sh uninstall.sh [选项]

选项:
  -y, --yes          不询问，直接卸载
  -h, --help         显示本帮助

说明:
  自动识别并卸载 Go 版探针（cf-probe）与旧版 shell 探针，
  删除服务、程序、配置、流量统计和日志。

  通过管道运行时（curl ... | sh），确认提示会读取终端输入；
  非交互环境请加 -y，例如: curl ... | sudo sh -s -- -y
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -y|--yes) ASSUME_YES=1 ;;
        -h|--help) usage; exit 0 ;;
        uninstall|remove|delete|purge) : ;;
        *) die "未知选项: $1（使用 --help 查看帮助）" ;;
    esac
    shift
done

[ "$(id -u)" -eq 0 ] || die "请以 root 权限运行，例如：sudo sh uninstall.sh"

if [ "$ASSUME_YES" -ne 1 ]; then
    prompt='这会停止并删除 ProbeDeck 探针及其数据。继续吗？[y/N] '
    if [ -t 0 ]; then
        printf '%s' "$prompt"
        read -r answer || answer=""
    elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
        { printf '%s' "$prompt" > /dev/tty; } 2>/dev/null || true
        if { read -r answer < /dev/tty; } 2>/dev/null; then :; else
            die "无法读取终端输入；确认卸载请传入 -y（例如: curl ... | sudo sh -s -- -y）"
        fi
    else
        die "检测到非交互环境；确认卸载请传入 -y（例如: curl ... | sudo sh -s -- -y）"
    fi
    case "$answer" in
        y|Y|yes|YES) ;;
        *) info "已取消。"; exit 0 ;;
    esac
fi

# ── 优先调用 Go 版探针自带卸载（全自动、清理最彻底）──
if [ -x "$GO_BINARY" ]; then
    info "检测到 Go 版探针，调用自带卸载程序..."
    if "$GO_BINARY" uninstall; then
        info "Go 版探针自带卸载完成。"
    else
        warn "自带卸载返回非零，继续手动清理残留..."
    fi
fi

# ── 以下为兜底清理（覆盖旧版 shell 探针与各类残留文件）──

stop_systemd() {
    if command -v systemctl >/dev/null 2>&1; then
        # 取消尚未执行的自动更新任务，避免卸载后被延迟任务重新安装。
        systemctl stop "${SERVICE_NAME}-auto-update-*" 2>/dev/null || true
        systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
        systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
    fi
}

stop_openrc() {
    if command -v rc-service >/dev/null 2>&1; then
        rc-service "$SERVICE_NAME" stop 2>/dev/null || true
    fi
    if command -v rc-update >/dev/null 2>&1; then
        rc-update del "$SERVICE_NAME" default 2>/dev/null || true
    fi
}

stop_procd() {
    if [ -x "/etc/init.d/${SERVICE_NAME}" ]; then
        "/etc/init.d/${SERVICE_NAME}" stop 2>/dev/null || true
        "/etc/init.d/${SERVICE_NAME}" disable 2>/dev/null || true
    fi
}

stop_launchd() {
    if command -v launchctl >/dev/null 2>&1; then
        launchctl bootout system /Library/LaunchDaemons/com.cf.probe.plist 2>/dev/null || \
            launchctl bootout system/com.cf.probe 2>/dev/null || true
        launchctl bootout system /Library/LaunchDaemons/com.cfsm.${SERVICE_NAME}.plist 2>/dev/null || \
            launchctl bootout system/com.cfsm.${SERVICE_NAME} 2>/dev/null || true
    fi
}

stop_synology() {
    if [ -x "/usr/local/etc/rc.d/${SERVICE_NAME}.sh" ]; then
        "/usr/local/etc/rc.d/${SERVICE_NAME}.sh" stop 2>/dev/null || true
    fi
}

info "停止并取消注册服务..."
stop_systemd
stop_openrc
stop_procd
stop_launchd
stop_synology

info "删除服务定义和探针程序..."
rm -f \
    "/etc/systemd/system/${SERVICE_NAME}.service" \
    "/etc/init.d/${SERVICE_NAME}" \
    "/usr/local/etc/rc.d/${SERVICE_NAME}.sh" \
    "/Library/LaunchDaemons/com.cf.probe.plist" \
    "/Library/LaunchDaemons/com.cfsm.${SERVICE_NAME}.plist" \
    "/usr/local/bin/${SERVICE_NAME}.sh" \
    "/usr/local/bin/${SERVICE_NAME}.sh.ctl" \
    "$GO_BINARY"

if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
fi

# 安装脚本也支持无服务管理器的容器/精简系统运行方式。
for pid_file in /run/cf-probe.pid /var/run/cf-probe.pid; do
    if [ -r "$pid_file" ]; then
        pid=$(cat "$pid_file" 2>/dev/null || true)
        case "$pid" in
            ''|*[!0-9]*) warn "忽略无效 PID 文件: $pid_file" ;;
            *) kill "$pid" 2>/dev/null || true ;;
        esac
    fi
    rm -f "$pid_file"
done

# 进程兜底清理（覆盖旧版 shell 探针与 Go 版探针两种运行形态）。
if command -v pkill >/dev/null 2>&1; then
    pkill -9 -f "/usr/local/bin/${SERVICE_NAME}" 2>/dev/null || true
fi

rm -f /run/cf-probe-debug.env /var/log/cf-probe.log
rm -f /dev/shm/.cf_ipv4 /dev/shm/.cf_ipv6 /dev/shm/.cf_probe_*
rm -f /tmp/.cf_ipv4 /tmp/.cf_ipv6 /tmp/.cf_probe_*

info "删除配置、流量统计和临时文件..."
rm -rf \
    /etc/config/cf-probe \
    /usr/local/etc/cf-probe \
    "/Library/Application Support/cf-probe" \
    /var/lib/cf-probe \
    /tmp/cf-probe

# 普通用户级安装残留（Go 版 ~/.cf-probe 与用户级 systemd/launchd 单元）。
for home_dir in /root /home/* /Users/*; do
    if [ -d "$home_dir/.cf-probe" ]; then
        rm -rf "$home_dir/.cf-probe"
    fi
    if [ -f "$home_dir/.config/systemd/user/${SERVICE_NAME}.service" ]; then
        rm -f "$home_dir/.config/systemd/user/${SERVICE_NAME}.service"
    fi
    if [ -f "$home_dir/Library/LaunchAgents/com.cfsm.${SERVICE_NAME}.plist" ]; then
        rm -f "$home_dir/Library/LaunchAgents/com.cfsm.${SERVICE_NAME}.plist"
    fi
done

info "ProbeDeck 探针已卸载完成。"

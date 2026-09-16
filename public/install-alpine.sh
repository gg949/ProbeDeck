#!/bin/sh
# ==============================================================================
# CF-Server-Monitor 安装/卸载脚本 (Alpine Linux 兼容版)
# 支持: Alpine Linux (OpenRC / 裸机 / Docker 容器)
# Fixes: 1. 独立协程无 wait 阻塞 2. 原子化原子覆盖 3. 兼容 OpenRC/无 init 场景
#        4. 严格 set -u 闭环 5. 自动安装 bash 保证探针脚本语法兼容
#        6. 配置文件化管理 7. Worker 健康检查自动重启
# ==============================================================================

set -eu

AGENT_VERSION="1.3.8"

# 路径定义（配置文件系统）
CONFIG_DIR="/etc/config/cf-probe"
CONFIG_FILE="${CONFIG_DIR}/config.conf"
TRAFFIC_DATA_FILE="${CONFIG_DIR}/traffic.dat"
OLD_TRAFFIC_DATA_FILE="/var/lib/cf-probe/traffic.dat"
MAX_TRAFFIC_CORRECTION_GB=1000000
AUTO_UPDATE_DELAY_SECONDS=60

# 颜色定义（busybox sh 下仅 printf '%b' 可用，所以统一用 printf）
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 路径定义
SERVICE_NAME="cf-probe"
OPENRC_FILE="/etc/init.d/${SERVICE_NAME}"
SCRIPT_FILE="/usr/local/bin/${SERVICE_NAME}.sh"
PID_FILE="/var/run/${SERVICE_NAME}.pid"
LOG_FILE="/var/log/${SERVICE_NAME}.log"

# ---------------------------------------------------------------
# 统一输出工具
# ---------------------------------------------------------------
print_banner() {
    printf '%b╔═════════════════════════════════════╗%b\n' "${CYAN}" "${NC}"
    printf '%b║     CF-Server-Monitor (Alpine)      ║%b\n' "${CYAN}" "${NC}"
    printf '%b╚═════════════════════════════════════╝%b\n' "${CYAN}" "${NC}"
}

info()  { printf '%b[✓]%b %s\n' "${GREEN}" "${NC}" "$1"; }
warn()  { printf '%b[!]%b %s\n' "${YELLOW}" "${NC}" "$1"; }
error() { printf '%b[✗]%b %s\n' "${RED}"   "${NC}" "$1"; exit 1; }
step()  { printf '%b[→]%b %s\n' "${BLUE}"  "${NC}" "$1"; }

print_usage() {
    printf '%b错误: 运行所需的入参不完整。%b\n\n' "${RED}" "${NC}"
    echo "用法:"
    echo "  sh $0 install -id=SERVER_ID -secret=SECRET -url=WORKER_URL [选项]"
    echo ""
    echo "必需参数:"
    echo "  -id=xxx        服务器ID"
    echo "  -secret=xxx    密钥"
    echo "  -url=xxx       上报地址"
    echo ""
    echo "可选参数:"
    echo "  -interval=N    上报间隔(秒)，默认60"
    echo "  -collect_interval=N    采样间隔(秒)，默认0"
    echo "  -ct=HOST       自定义CT测试节点"
    echo "  -cu=HOST       自定义CU测试节点"
    echo "  -cm=HOST       自定义CM测试节点"
    echo "  -bd=HOST       自定义BD测试节点"
    echo "  -interface=IFACES 指定网卡统计，多个用英文逗号分隔，默认自动汇总"
    echo "  -reset_day=N   流量重置日(1-31, 0=不重置)，默认1"
    echo "  -auto_update=0|1 自动更新探针，默认0"
    echo "  -rx_correction=N  下行流量校正(GB)，覆盖当月下行数据"
    echo "  -tx_correction=N  上行流量校正(GB)，覆盖当月上行数据"
    echo ""
    echo "示例:"
    echo "  sh $0 install -id=server123 -secret=abc123 -url=https://worker.example.com"
    echo "  sh $0 install -id=server123 -secret=abc123 -url=https://worker.example.com -interval=30"
    echo "  sh $0 install -id=server123 -secret=abc123 -url=https://worker.example.com -interface=eth0,ens3"
    echo "  sh $0 install -id=server123 -secret=abc123 -url=https://worker.example.com -reset_day=15"
    echo "  sh $0 install -id=server123 -secret=abc123 -url=https://worker.example.com -rx_correction=10 -tx_correction=5"
    exit 1
}

sed_escape() {
    printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/&/\\&/g; s/@/\\@/g; s/\//\\\//g; s/|/\\|/g; s/"/\\"/g'
}

normalize_binary_value() {
    local value="${1-}" default_value="${2-}"
    [ -z "$value" ] && value="$default_value"
    case "$value" in
        0|1) printf '%s' "$value" ;;
        *) return 1 ;;
    esac
}

normalize_interface_list() {
    printf '%s' "${1:-}" | awk -F',' '
        {
            for (i = 1; i <= NF; i++) {
                name = $i
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
                if (name == "") continue
                if (length(name) > 64 || name !~ /^[A-Za-z0-9_.:-]+$/) exit 1
                if (!seen[name]++) out = out (out ? "," : "") name
            }
        }
        END {
            if (length(out) > 255) exit 1
            printf "%s", out
        }
    '
}

get_configured_net_bytes() {
    local interfaces
    interfaces=$(normalize_interface_list "${1:-}") || interfaces=""
    awk -v interfaces="$interfaces" '
        BEGIN {
            split(interfaces, parts, ",")
            for (i in parts) if (parts[i] != "") wanted[parts[i]] = 1
        }
        NR > 2 {
            iface = $1
            sub(/:$/, "", iface)
            if (interfaces != "") {
                if (wanted[iface]) { rx += $2; tx += $10 }
            } else if (iface ~ /^(eth|en|wl)[a-z0-9]*$/) {
                rx += $2; tx += $10
            }
        }
        END { printf "%.0f %.0f\n", rx + 0, tx + 0 }
    ' /proc/net/dev 2>/dev/null || echo "0 0"
}

check_root() {
    if [ "$(id -u)" != "0" ]; then
        error "请使用 root 权限运行此脚本: sudo sh $0"
    fi
}

# ---------------------------------------------------------------
# OS / Init 系统探测
# ---------------------------------------------------------------
detect_os() {
    if [ -f /etc/alpine-release ]; then
        OS_ID="alpine"
    elif [ -f /etc/os-release ]; then
        OS_ID=$(grep -E '^ID=' /etc/os-release | cut -d= -f2 | tr -d '"' | tr -d "'")
    else
        OS_ID=$(uname -s | tr '[:upper:]' '[:lower:]')
    fi
    OS_ID=${OS_ID:-"unknown"}

    case "$OS_ID" in
        alpine) PKG_MGR="apk" ;;
        *) warn "检测到非 Alpine 系统: $OS_ID，仍将尝试使用 apk" ; PKG_MGR="apk" ;;
    esac

    # 探测 init 系统
    if command -v rc-service >/dev/null 2>&1 && [ -d /etc/runlevels ]; then
        INIT_SYSTEM="openrc"
    elif [ -d /run/systemd/system ]; then
        INIT_SYSTEM="systemd"
    else
        INIT_SYSTEM="manual"
    fi
}

# ---------------------------------------------------------------
# 依赖安装（Alpine 版）
# ---------------------------------------------------------------
install_deps() {
    step "检查系统依赖组件..."

    # 必须先装 bash — 探针脚本内部使用了大量 bash-only 语法
    # coreutils: 提供完整的 df -P、date、nproc、stat 等
    # procps:    提供完整的 ps -e、pgrep、pkill
    # iproute2:  提供 ss
    # iputils:   提供 ping，用于丢包率探测
    local required_pkgs="bash curl grep sed coreutils procps iproute2 iputils"

    if ! command -v apk >/dev/null 2>&1; then
        error "未找到 apk 包管理器，当前系统不是 Alpine Linux。"
    fi

    step "刷新 APK 索引并安装基础依赖..."
    apk update --quiet >/dev/null 2>&1 || true
    # shellcheck disable=SC2086
    apk add --no-cache --quiet $required_pkgs >/dev/null 2>&1 || \
        apk add --no-cache $required_pkgs || \
        error "依赖包安装失败，请检查网络或手动执行: apk add $required_pkgs"

    local required_cmds="bash curl awk grep sed ps df ss nproc pgrep pkill"
    for cmd in ${required_cmds}; do
        if ! command -v "${cmd}" >/dev/null 2>&1; then
            error "缺少必要依赖: ${cmd}，请手动安装后重试。"
        fi
    done

    if ! command -v ping >/dev/null 2>&1; then
        warn "未找到 ping，丢包率监控将上报为空；可手动安装: apk add iputils"
    fi

    info "基础依赖组件检查通过（bash/coreutils/procps/iproute2/curl）"

    # 提示 init 情况
    case "$INIT_SYSTEM" in
        openrc)  info "检测到 OpenRC，将注册为系统服务。" ;;
        systemd) warn "检测到 systemd — 建议使用原版 install.sh。此处将以手动方式启动。" ;;
        manual)  warn "未检测到 init 系统（通常是 Docker 容器），将采用后台进程方式运行。" ;;
    esac
}


# ---------------------------------------------------------------
# 清理旧进程 / 旧服务
# ---------------------------------------------------------------
stop_old_service() {
    step "清理可能存在的旧服务进程..."

    # OpenRC 服务
    if [ "$INIT_SYSTEM" = "openrc" ] && [ -f "$OPENRC_FILE" ]; then
        rc-service "$SERVICE_NAME" stop >/dev/null 2>&1 || true
        rc-update del "$SERVICE_NAME" default >/dev/null 2>&1 || true
        rm -f "$OPENRC_FILE"
    fi

    # PID 文件方式的后台进程
    if [ -f "$PID_FILE" ]; then
        local old_pid
        old_pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
        if [ -n "$old_pid" ] && kill -0 "$old_pid" >/dev/null 2>&1; then
            kill -TERM "$old_pid" >/dev/null 2>&1 || true
            sleep 1
            kill -9 "$old_pid" >/dev/null 2>&1 || true
        fi
        rm -f "$PID_FILE"
    fi

    # 兜底：按进程名杀
    if pgrep -f "${SERVICE_NAME}.sh" >/dev/null 2>&1; then
        pkill -9 -f "${SERVICE_NAME}.sh" >/dev/null 2>&1 || true
    fi
}

# ---------------------------------------------------------------
# 注入探针脚本（内部使用 bash，保证语法兼容）
# ---------------------------------------------------------------
create_script() {
    step "注入工业级监控采集探针..."

    cat << 'PROBE_EOF' | sed "s|__AGENT_VERSION__|${AGENT_VERSION}|g" > "${SCRIPT_FILE}"
#!/bin/bash
set +eu

AGENT_VERSION="__AGENT_VERSION__"
CONFIG_DIR="/etc/config/cf-probe"
CONFIG_FILE="${CONFIG_DIR}/config.conf"
TRAFFIC_DATA_FILE="${CONFIG_DIR}/traffic.dat"
MAX_TRAFFIC_CORRECTION_GB=1000000

normalize_interface_list() {
    printf '%s' "${1:-}" | awk -F',' '
        {
            for (i = 1; i <= NF; i++) {
                name = $i
                gsub(/^[[:space:]]+|[[:space:]]+$/, "", name)
                if (name == "") continue
                if (length(name) > 64 || name !~ /^[A-Za-z0-9_.:-]+$/) exit 1
                if (!seen[name]++) out = out (out ? "," : "") name
            }
        }
        END {
            if (length(out) > 255) exit 1
            printf "%s", out
        }
    '
}

if [ ! -f "${CONFIG_FILE}" ]; then
    echo "[ERROR] 配置文件不存在: ${CONFIG_FILE}"
    exit 1
fi

while IFS='=' read -r key value; do
    case "$key" in
        SERVER_ID) SERVER_ID="${value%\"}"; SERVER_ID="${SERVER_ID#\"}" ;;
        SECRET) SECRET="${value%\"}"; SECRET="${SECRET#\"}" ;;
        WORKER_URL) WORKER_URL="${value%\"}"; WORKER_URL="${WORKER_URL#\"}" ;;
        COLLECT_INTERVAL) COLLECT_INTERVAL="${value%\"}"; COLLECT_INTERVAL="${COLLECT_INTERVAL#\"}" ;;
        REPORT_INTERVAL) REPORT_INTERVAL="${value%\"}"; REPORT_INTERVAL="${REPORT_INTERVAL#\"}" ;;
        CT_NODE) CT_NODE="${value%\"}"; CT_NODE="${CT_NODE#\"}" ;;
        CU_NODE) CU_NODE="${value%\"}"; CU_NODE="${CU_NODE#\"}" ;;
        CM_NODE) CM_NODE="${value%\"}"; CM_NODE="${CM_NODE#\"}" ;;
        BD_NODE) BD_NODE="${value%\"}"; BD_NODE="${BD_NODE#\"}" ;;
        INTERFACE) INTERFACE="${value%\"}"; INTERFACE="${INTERFACE#\"}" ;;
        RESET_DAY) RESET_DAY="${value%\"}"; RESET_DAY="${RESET_DAY#\"}" ;;
        AUTO_UPDATE) AUTO_UPDATE="${value%\"}"; AUTO_UPDATE="${AUTO_UPDATE#\"}" ;;
        CONFIG_MD5) CONFIG_MD5="${value%\"}"; CONFIG_MD5="${CONFIG_MD5#\"}" ;;
    esac
done < "${CONFIG_FILE}"

COLLECT_INTERVAL=${COLLECT_INTERVAL:-0}
REPORT_INTERVAL=${REPORT_INTERVAL:-60}
AUTO_UPDATE=${AUTO_UPDATE:-0}
case "$AUTO_UPDATE" in
    0|1) ;;
    *) AUTO_UPDATE=0 ;;
esac
[ -z "$RESET_DAY" ] && RESET_DAY=1
case "$COLLECT_INTERVAL" in ''|*[!0-9]*) COLLECT_INTERVAL=0 ;; esac
case "$REPORT_INTERVAL" in ''|*[!0-9]*) REPORT_INTERVAL=60 ;; esac
[ "$REPORT_INTERVAL" -lt 1 ] && REPORT_INTERVAL=60
if [ "$COLLECT_INTERVAL" -gt 0 ] && [ "$REPORT_INTERVAL" -lt "$COLLECT_INTERVAL" ]; then
    REPORT_INTERVAL="$COLLECT_INTERVAL"
fi
ACTIVE_INTERVAL="$REPORT_INTERVAL"
[ "$COLLECT_INTERVAL" -gt 0 ] && ACTIVE_INTERVAL="$COLLECT_INTERVAL"
CONFIG_MD5=${CONFIG_MD5:-none}
DEBUG_MODE=${DEBUG_MODE:-0}
INTERFACE=$(normalize_interface_list "${INTERFACE:-}") || INTERFACE=""

log_ts() {
    date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%d %H:%M:%S'
}

log_info() {
    echo "[INFO] $(log_ts) $*"
}

log_debug() {
    [ "$DEBUG_MODE" = "1" ] && echo "[DEBUG] $(log_ts) $*" >&2
}

log_warn_debug() {
    [ "$DEBUG_MODE" = "1" ] && echo "[WARN] $(log_ts) $*"
}

get_install_url() {
    local url rest origin
    url="${WORKER_URL%%\?*}"
    case "$url" in
        http://*)
            rest="${url#http://}"
            origin="http://${rest%%/*}"
            ;;
        https://*)
            rest="${url#https://}"
            origin="https://${rest%%/*}"
            ;;
        *)
            return 1
            ;;
    esac
    case "$origin" in
        http://|https://) return 1 ;;
    esac
    printf '%s/install-alpine.sh' "$origin"
}

schedule_agent_update() {
    if [ "${AUTO_UPDATE}" != "1" ]; then
        log_warn_debug "Auto update ignored: local AUTO_UPDATE=${AUTO_UPDATE}"
        return 0
    fi

    local now last lock_file install_url update_tmp_dir candidate_dir
    lock_file="${CONFIG_DIR}/auto_update.lock"

    now=$(date +%s)
    if [ -f "$lock_file" ]; then
        last=$(cat "$lock_file" 2>/dev/null || echo 0)
        case "$last" in ''|*[!0-9]*) last=0 ;; esac
        if [ $((now - last)) -lt 1800 ]; then
            log_warn_debug "Auto update already scheduled recently: age=$((now - last))s lock=${lock_file}"
            return 0
        fi
    fi

    mkdir -p "${CONFIG_DIR}" 2>/dev/null || true
    update_tmp_dir=""
    for candidate_dir in /tmp /var/tmp /run /var/run "${CONFIG_DIR}"; do
        if mkdir -p "$candidate_dir" 2>/dev/null && [ -d "$candidate_dir" ] && [ -w "$candidate_dir" ]; then
            update_tmp_dir="$candidate_dir"
            break
        fi
    done
    if [ -z "$update_tmp_dir" ]; then
        log_warn_debug "Auto update skipped: no writable temp dir"
        return 1
    fi
    if ! install_url=$(get_install_url); then
        log_warn_debug "Auto update skipped: invalid WORKER_URL=${WORKER_URL}"
        return 1
    fi
    log_debug "Auto update requested: install_url=${install_url}"
    log_debug "Auto update temp dir: ${update_tmp_dir}"
    printf '%s\n' "$now" > "$lock_file" 2>/dev/null || true

    nohup /bin/sh -c 'sleep "$3"; tmp="$2/cf-probe-auto-update.$$"; rm -f "$tmp"; if curl -fsSL --connect-timeout 5 -m 30 "$1" -o "$tmp"; then /bin/sh "$tmp" install; fi; rm -f "$tmp"' _ "$install_url" "$update_tmp_dir" "$AUTO_UPDATE_DELAY_SECONDS" >/dev/null 2>&1 &
    log_info "Auto update scheduled after ${AUTO_UPDATE_DELAY_SECONDS}s"
    return 0
}

# 动态检测 stdout 指向的日志文件
PROBE_LOG_FILE=""
if [ -L /proc/self/fd/1 ]; then
    _log_target=$(readlink /proc/self/fd/1 2>/dev/null || echo "")
    [ -f "$_log_target" ] && [ -w "$_log_target" ] && PROBE_LOG_FILE="$_log_target"
fi

rotate_log_if_needed() {
    [ -f "$1" ] || return 0
    local _sz
    _sz=$(wc -c < "$1" 2>/dev/null || echo 0)
    [ "${_sz:-0}" -gt 1048576 ] || return 0
    local _lines
    _lines=$(wc -l < "$1" 2>/dev/null || echo 0)
    if [ "${_lines}" -eq 1 ]; then
        : > "$1" 2>/dev/null
        return 0
    fi
    local _tmp="${1}.rot.$$"
    tail -c 102400 "$1" > "$_tmp" 2>/dev/null || { rm -f "$_tmp"; return 0; }
    : > "$1" 2>/dev/null
    cat "$_tmp" >> "$1" 2>/dev/null || true
    rm -f "$_tmp" 2>/dev/null || true
}

persist_dynamic_config() {
    local tmp_file="${CONFIG_FILE}.tmp.$$"
    awk -v collect="$1" -v report="$2" -v reset="$3" -v md5="$4" -v ct="$5" -v cu="$6" -v cm="$7" -v bd="$8" -v iface="$9" '
        BEGIN { c=0; r=0; d=0; m=0; tct=0; tcu=0; tcm=0; tbd=0; ni=0 }
        /^COLLECT_INTERVAL=/ { print "COLLECT_INTERVAL=\"" collect "\""; c=1; next }
        /^REPORT_INTERVAL=/ { print "REPORT_INTERVAL=\"" report "\""; r=1; next }
        /^RESET_DAY=/ { print "RESET_DAY=\"" reset "\""; d=1; next }
        /^CONFIG_MD5=/ { print "CONFIG_MD5=\"" md5 "\""; m=1; next }
        /^CT_NODE=/ { print "CT_NODE=\"" ct "\""; tct=1; next }
        /^CU_NODE=/ { print "CU_NODE=\"" cu "\""; tcu=1; next }
        /^CM_NODE=/ { print "CM_NODE=\"" cm "\""; tcm=1; next }
        /^BD_NODE=/ { print "BD_NODE=\"" bd "\""; tbd=1; next }
        /^INTERFACE=/ { print "INTERFACE=\"" iface "\""; ni=1; next }
        { print }
        END {
            if (!c) print "COLLECT_INTERVAL=\"" collect "\""
            if (!r) print "REPORT_INTERVAL=\"" report "\""
            if (!d) print "RESET_DAY=\"" reset "\""
            if (!m) print "CONFIG_MD5=\"" md5 "\""
            if (!tct) print "CT_NODE=\"" ct "\""
            if (!tcu) print "CU_NODE=\"" cu "\""
            if (!tcm) print "CM_NODE=\"" cm "\""
            if (!tbd) print "BD_NODE=\"" bd "\""
            if (!ni) print "INTERFACE=\"" iface "\""
        }
    ' "$CONFIG_FILE" > "$tmp_file" || { rm -f "$tmp_file"; return 1; }
    chmod 600 "$tmp_file" 2>/dev/null || true
    mv "$tmp_file" "$CONFIG_FILE"
}

apply_remote_config() {
    local response_file="$1" header_file="$2" body bytes new_md5
    local new_collect new_report new_reset new_schema new_ct new_cu new_cm new_bd new_interface
    local new_rx_corr new_tx_corr new_update has_config
    bytes=$(wc -c < "$response_file" 2>/dev/null || echo 9999)
    if [ "$bytes" -gt 1024 ]; then
        log_warn_debug "Remote config rejected: response too large bytes=${bytes}"
        return 1
    fi
    body=$(cat "$response_file" 2>/dev/null) || return 1
    log_debug "Remote config raw: bytes=${bytes} body=${body}"
    case "$body" in
        '') log_warn_debug "Remote config rejected: empty body"; return 1 ;;
        *[!A-Za-z0-9_=\&.,:-]*) log_warn_debug "Remote config rejected: invalid characters body=${body}"; return 1 ;;
    esac

    new_collect=""
    new_report=""
    new_reset=""
    new_schema=""
    new_ct=""
    new_cu=""
    new_cm=""
    new_bd=""
    new_interface=""
    new_rx_corr=""
    new_tx_corr=""
    new_update=""
    saved_ifs="$IFS"
    IFS='&'
    for _f in $body; do
        _k="${_f%%=*}"; _v="${_f#*=}"
        case "$_k" in
            collect_interval) new_collect="$_v" ;;
            report_interval)  new_report="$_v" ;;
            reset_day)        new_reset="$_v" ;;
            schema_version)   new_schema="$_v" ;;
            custom_ct)        new_ct="$_v" ;;
            custom_cu)        new_cu="$_v" ;;
            custom_cm)        new_cm="$_v" ;;
            custom_bd)        new_bd="$_v" ;;
            interface)        new_interface="$_v" ;;
            rx_correction)    new_rx_corr="$_v" ;;
            tx_correction)    new_tx_corr="$_v" ;;
            update)           new_update="$_v" ;;
            '')               ;;
            *)                IFS="$saved_ifs"; log_warn_debug "Remote config rejected: unknown field=${_k}"; return 1 ;;
        esac
    done
    IFS="$saved_ifs"

    has_config=0
    if [ -n "${new_collect:-}" ] || [ -n "${new_report:-}" ] || [ -n "${new_reset:-}" ] || [ -n "${new_schema:-}" ] || [ -n "${new_interface:-}" ]; then
        has_config=1
    fi
    log_debug "Remote config parsed: has_config=${has_config} update=${new_update:-} collect=${new_collect:-} report=${new_report:-} reset=${new_reset:-} schema=${new_schema:-} interface=${new_interface:-} rx_corr=${new_rx_corr:-} tx_corr=${new_tx_corr:-}"

    if [ "$has_config" = "0" ]; then
        if [ "$new_update" = "1" ]; then
            log_debug "Remote update-only instruction received"
            schedule_agent_update
            return 0
        fi
        log_warn_debug "Remote config rejected: no config fields and update=${new_update:-}"
        return 1
    fi

    new_md5=$(awk 'tolower($1)=="x-agent-config-md5:" { gsub("\r", "", $2); print tolower($2); exit }' "$header_file")
    if [ "${#new_md5}" -ne 32 ]; then
        log_warn_debug "Remote config rejected: invalid md5 length md5=${new_md5:-}"
        return 1
    fi
    case "$new_md5" in *[!0-9a-f]*) log_warn_debug "Remote config rejected: invalid md5 chars md5=${new_md5}"; return 1 ;; esac
    log_debug "Remote config md5: current=${CONFIG_MD5:-none} remote=${new_md5}"

    case "$new_collect" in 0|1|2|5|10) ;; *) log_warn_debug "Remote config rejected: invalid collect_interval=${new_collect:-}"; return 1 ;; esac
    case "$new_report" in 30|60|120|180) ;; *) log_warn_debug "Remote config rejected: invalid report_interval=${new_report:-}"; return 1 ;; esac
    case "$new_reset" in 0|[1-9]|1[0-9]|2[0-9]|30|31) ;; *) log_warn_debug "Remote config rejected: invalid reset_day=${new_reset:-}"; return 1 ;; esac
    case "$new_update" in ''|0|1) ;; *) log_warn_debug "Remote config rejected: invalid update=${new_update}"; return 1 ;; esac
    if [ "$new_schema" != "3" ]; then
        log_warn_debug "Remote config rejected: invalid schema_version=${new_schema:-}"
        return 1
    fi
    new_interface=$(normalize_interface_list "${new_interface:-}") || { log_warn_debug "Remote config rejected: invalid interface=${new_interface:-}"; return 1; }
    if [ "$new_report" -lt "$new_collect" ]; then
        log_warn_debug "Remote config rejected: report_interval=${new_report} less than collect_interval=${new_collect}"
        return 1
    fi

    if [ "$new_md5" != "${CONFIG_MD5:-none}" ]; then
        persist_dynamic_config "$new_collect" "$new_report" "$new_reset" "$new_md5" "$new_ct" "$new_cu" "$new_cm" "$new_bd" "$new_interface" || return 1
        COLLECT_INTERVAL="$new_collect"
        REPORT_INTERVAL="$new_report"
        RESET_DAY="$new_reset"
        CT_NODE="$new_ct"
        CU_NODE="$new_cu"
        CM_NODE="$new_cm"
        BD_NODE="$new_bd"
        INTERFACE="$new_interface"
        CONFIG_MD5="$new_md5"
        ACTIVE_INTERVAL="$REPORT_INTERVAL"
        [ "$COLLECT_INTERVAL" -gt 0 ] && ACTIVE_INTERVAL="$COLLECT_INTERVAL"
        NET_STAT=$(get_net_bytes)
        RX_PREV=$(echo "$NET_STAT" | awk '{print $1}'); RX_PREV=${RX_PREV:-0}
        TX_PREV=$(echo "$NET_STAT" | awk '{print $2}'); TX_PREV=${TX_PREV:-0}
        PREV_LOOP_TIME=$(date +%s)
        log_info "Dynamic configuration applied: md5=${CONFIG_MD5} interface=${INTERFACE:-auto} ct=${CT_NODE:-} cu=${CU_NODE:-} cm=${CM_NODE:-} bd=${BD_NODE:-}"

        if kill -0 "$WORKER_PID" 2>/dev/null; then
            pkill -P "$WORKER_PID" 2>/dev/null || true
            kill "$WORKER_PID" 2>/dev/null || true
            wait "$WORKER_PID" 2>/dev/null || true
        fi
        rm -f /tmp/.cf_probe_* 2>/dev/null || true
        run_network_worker &
        WORKER_PID=$!

        if [ "$COLLECT_INTERVAL" -gt 0 ]; then
            SAMPLES_JSON=""
            SAMPLE_COUNT=0
        fi
        LAST_REPORT_TIME=0
    fi

    if [ -n "$new_rx_corr" ] || [ -n "$new_tx_corr" ]; then
        if apply_traffic_correction "$new_rx_corr" "$new_tx_corr"; then
            send_correction_confirm "$new_rx_corr" "$new_tx_corr" || true
        fi
    fi

    if [ "$new_update" = "1" ]; then
        log_debug "Remote config includes update=1"
        schedule_agent_update || true
    fi
    return 0
}

normalize_correction_value() {
    local val="${1:-0}"
    [ -z "$val" ] && val=0
    printf '%s' "$val"
}

is_valid_correction_value() {
    local val
    val=$(normalize_correction_value "$1")
    awk -v v="$val" -v max="$MAX_TRAFFIC_CORRECTION_GB" 'BEGIN { exit !(v ~ /^[0-9]+([.][0-9]+)?$/ && v + 0 >= 0 && v + 0 <= max) }'
}

send_correction_confirm() {
    local rx_val tx_val payload http_code
    rx_val=$(normalize_correction_value "$1")
    tx_val=$(normalize_correction_value "$2")
    is_valid_correction_value "$rx_val" && is_valid_correction_value "$tx_val" || return 1
    payload="{\"id\":\"$SERVER_ID\",\"secret\":\"$SECRET\",\"rx_correction\":$rx_val,\"tx_correction\":$tx_val}"
    http_code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" -m 4 --connect-timeout 2 "$WORKER_URL" 2>/dev/null || echo 000)
    case "$http_code" in ''|*[!0-9]*) http_code=000 ;; esac
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        log_info "Traffic correction confirm sent: RX=${rx_val}GB TX=${tx_val}GB"
        return 0
    fi
    log_warn_debug "Traffic correction confirm failed: http=${http_code} RX=${rx_val}GB TX=${tx_val}GB"
    return 1
}

apply_traffic_correction() {
    local rx_val="${1:-0}"
    local tx_val="${2:-0}"
    [ -z "$rx_val" ] && rx_val=0
    [ -z "$tx_val" ] && tx_val=0
    is_valid_correction_value "$rx_val" && is_valid_correction_value "$tx_val" || return 1
    local rx_bytes=0 tx_bytes=0
    rx_bytes=$(printf '%s' "$rx_val" | awk '{printf "%.0f", $1 * 1024 * 1024 * 1024}')
    tx_bytes=$(printf '%s' "$tx_val" | awk '{printf "%.0f", $1 * 1024 * 1024 * 1024}')
    local current_net current_rx current_tx
    current_net=$(get_net_bytes)
    current_rx=$(echo "$current_net" | awk '{print $1}'); current_rx=${current_rx:-0}
    current_tx=$(echo "$current_net" | awk '{print $2}'); current_tx=${current_tx:-0}
    local saved_rx_period=0 saved_tx_period=0 saved_last_check=0 saved_period_start=0
    if [ -f "${TRAFFIC_DATA_FILE}" ]; then
        while IFS='=' read -r key value; do
            case "$key" in
                RX_PERIOD) saved_rx_period="${value%%\"*}"; saved_rx_period="${saved_rx_period#\"}" ;;
                TX_PERIOD) saved_tx_period="${value%%\"*}"; saved_tx_period="${saved_tx_period#\"}" ;;
                LAST_CHECK) saved_last_check="${value%%\"*}"; saved_last_check="${saved_last_check#\"}" ;;
                PERIOD_START) saved_period_start="${value%%\"*}"; saved_period_start="${saved_period_start#\"}" ;;
            esac
        done < "${TRAFFIC_DATA_FILE}"
    fi
    local now_ts
    now_ts=$(date +%s)
    saved_rx_period=${rx_bytes}
    saved_tx_period=${tx_bytes}
    log_info "Traffic correction applied: RX=${rx_val}GB (${rx_bytes} bytes) TX=${tx_val}GB (${tx_bytes} bytes)"
    mkdir -p "${CONFIG_DIR}" 2>/dev/null || true
    cat > "${TRAFFIC_DATA_FILE}.tmp" << EOF
RX_PREV=${current_rx}
TX_PREV=${current_tx}
RX_PERIOD=${saved_rx_period}
TX_PERIOD=${saved_tx_period}
LAST_CHECK=${now_ts}
PERIOD_START=${saved_period_start}
INTERFACE=${INTERFACE:-}
EOF
    mv "${TRAFFIC_DATA_FILE}.tmp" "${TRAFFIC_DATA_FILE}" 2>/dev/null || true
}

# 严苛环境下的规范 JSON 字段转义函数
escape_json() {
    local val="${1:-}"
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    val="${val//$'\n'/ }"
    val="${val//$'\r'/}"
    echo -n "$val"
}

json_probe_value() {
    local node="${1:-}"
    local value="${2:-}"
    if [ -z "$node" ]; then
        printf 'false'
    else
        printf '"%s"' "$(escape_json "$value")"
    fi
}

safe_div() {
    local num="${1:-0}"
    local den="${2:-0}"
    local def="${3:-0}"
    if [ "${den}" -eq 0 ]; then echo "${def}"; else echo $(( num / den )); fi
}

get_net_bytes() {
    local interfaces="${INTERFACE:-}"
    awk -v interfaces="$interfaces" '
        BEGIN {
            split(interfaces, parts, ",")
            for (i in parts) if (parts[i] != "") wanted[parts[i]] = 1
        }
        NR > 2 {
            iface = $1
            sub(/:$/, "", iface)
            if (interfaces != "") {
                if (wanted[iface]) { rx += $2; tx += $10 }
            } else if (iface ~ /^(eth|en|wl)[a-z0-9]*$/) {
                rx += $2; tx += $10
            }
        }
        END { printf "%.0f %.0f\n", rx + 0, tx + 0 }
    ' /proc/net/dev 2>/dev/null || echo "0 0";
}

is_leap_year() {
    local year=$1
    [ $((year % 4)) -eq 0 ] && [ $((year % 100)) -ne 0 ] || [ $((year % 400)) -eq 0 ]
}

to_decimal() {
    local value="${1:-0}"
    value=$(printf '%s' "$value" | sed 's/^0*//')
    case "$value" in ''|*[!0-9]*) value=0 ;; esac
    printf '%s' "$value"
}

# 获取当月账单周期起始时间戳（UTC+0）
get_period_start_ts() {
    local reset_day="$1"
    [ "$reset_day" -eq 0 ] 2>/dev/null && { echo "0"; return; }
    local now_ts="$2"
    local year month day
    # 用 awk 将 epoch 秒转换为 year month day（UTC），避免 BusyBox date -d 不可用
    local _date_parts
    _date_parts=$(awk -v ts="$now_ts" '
    BEGIN {
        secs = int(ts); y = 1970
        while (1) {
            leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
            days_year = leap ? 366 : 365
            if (secs < days_year * 86400) break
            secs -= days_year * 86400; y++
        }
        mdays[1]=31; mdays[2]=leap?29:28; mdays[3]=31; mdays[4]=30
        mdays[5]=31; mdays[6]=30; mdays[7]=31; mdays[8]=31
        mdays[9]=30; mdays[10]=31; mdays[11]=30; mdays[12]=31
        m = 1
        while (m <= 12) {
            if (secs < mdays[m] * 86400) break
            secs -= mdays[m] * 86400; m++
        }
        day = int(secs / 86400) + 1
        printf "%04d %02d %02d\n", y, m, day
    }')
    year=$(echo "$_date_parts" | awk '{print $1}')
    month=$(echo "$_date_parts" | awk '{print $2}')
    day=$(echo "$_date_parts" | awk '{print $3}')
    month=$(to_decimal "$month")
    day=$(to_decimal "$day")
    
    local target_day
    target_day=$(to_decimal "$reset_day")
    case "$month" in
        2) 
            if is_leap_year "$year"; then
                [ "$target_day" -gt 29 ] && target_day=29
            else
                [ "$target_day" -gt 28 ] && target_day=28
            fi
            ;;
        4|6|9|11) [ "$target_day" -gt 30 ] && target_day=30 ;;
    esac
    
    local period_start_ts
    if [ "$day" -ge "$target_day" ]; then
        # 用 awk 将年月日转为 epoch 秒（UTC），兼容 BusyBox date -d 不可用
        period_start_ts=$(awk 'BEGIN{
            y='"${year}"'; m='"${month}"'; d='"${target_day}"';
            if(m<=2){y=y-1;m=m+12}
            A=int(y/100);B=2-A+int(A/4);
            JD=int(365.25*(y+4716))+int(30.6001*(m+1))+d+B-1524.5;
            printf "%d", (JD-2440587.5)*86400
        }')
    else
        local prev_month=$((month - 1))
        [ "$prev_month" -eq 0 ] && { prev_month=12; year=$((year - 1)); }
        local prev_month_str=$(printf "%02d" "$prev_month")
        case "$prev_month" in
            2) 
                if is_leap_year "$year"; then
                    [ "$target_day" -gt 29 ] && target_day=29
                else
                    [ "$target_day" -gt 28 ] && target_day=28
                fi
                ;;
            4|6|9|11) [ "$target_day" -gt 30 ] && target_day=30 ;;
        esac
        period_start_ts=$(awk 'BEGIN{
            y='"${year}"'; m='"${prev_month}"'; d='"${target_day}"';
            if(m<=2){y=y-1;m=m+12}
            A=int(y/100);B=2-A+int(A/4);
            JD=int(365.25*(y+4716))+int(30.6001*(m+1))+d+B-1524.5;
            printf "%d", (JD-2440587.5)*86400
        }')
    fi
    echo "$period_start_ts"
}

# 计算月度流量（自动持久化）
calc_monthly_traffic() {
    local current_rx="$1"
    local current_tx="$2"
    local reset_day="${RESET_DAY:-1}"
    local now_ts
    now_ts=$(date '+%s')
    
    mkdir -p "${CONFIG_DIR}" 2>/dev/null || true
    
    local saved_rx_prev=0 saved_tx_prev=0 saved_rx_period=0 saved_tx_period=0 saved_last_check=0 saved_period_start=0 saved_interface=""
    if [ -f "${TRAFFIC_DATA_FILE}" ]; then
        local tmp_rx_prev tmp_tx_prev tmp_rx_period tmp_tx_period tmp_last_check tmp_period_start tmp_interface
        while IFS='=' read -r key value; do
            case "$key" in
                RX_PREV) tmp_rx_prev="$value" ;;
                TX_PREV) tmp_tx_prev="$value" ;;
                RX_PERIOD) tmp_rx_period="$value" ;;
                TX_PERIOD) tmp_tx_period="$value" ;;
                LAST_CHECK) tmp_last_check="$value" ;;
                PERIOD_START) tmp_period_start="$value" ;;
                INTERFACE) tmp_interface="$value" ;;
            esac
        done < "${TRAFFIC_DATA_FILE}"
        saved_rx_prev=${tmp_rx_prev:-0}; saved_tx_prev=${tmp_tx_prev:-0}
        saved_rx_period=${tmp_rx_period:-0}; saved_tx_period=${tmp_tx_period:-0}
        saved_last_check=${tmp_last_check:-0}; saved_period_start=${tmp_period_start:-0}
        saved_interface=${tmp_interface:-}
    fi

    if [ "${saved_interface}" != "${INTERFACE:-}" ]; then
        saved_rx_prev=0; saved_tx_prev=0
        saved_rx_period=0; saved_tx_period=0
        saved_last_check=0; saved_period_start=0
    fi
    
    local period_start_ts
    period_start_ts=$(get_period_start_ts "$reset_day" "$now_ts")
    case "$period_start_ts" in ''|*[!0-9]*) period_start_ts=0 ;; esac
    
    local rx_delta=0 tx_delta=0
    if [ "$saved_last_check" -ne 0 ]; then
        if [ "$current_rx" -lt "$saved_rx_prev" ] || [ "$current_tx" -lt "$saved_tx_prev" ]; then
            rx_delta=0; tx_delta=0
        else
            rx_delta=$((current_rx - saved_rx_prev))
            tx_delta=$((current_tx - saved_tx_prev))
        fi
        
        if [ "$period_start_ts" -ne 0 ] && [ "$period_start_ts" -ne "$saved_period_start" ] && [ "$saved_period_start" -ne 0 ]; then
            saved_rx_period="$rx_delta"; saved_tx_period="$tx_delta"
        else
            saved_rx_period=$((saved_rx_period + rx_delta))
            saved_tx_period=$((saved_tx_period + tx_delta))
        fi
    else
        saved_rx_period=0
        saved_tx_period=0
    fi
    
    cat > "${TRAFFIC_DATA_FILE}.tmp" << EOF
RX_PREV=${current_rx}
TX_PREV=${current_tx}
RX_PERIOD=${saved_rx_period}
TX_PERIOD=${saved_tx_period}
LAST_CHECK=${now_ts}
PERIOD_START=${period_start_ts}
INTERFACE=${INTERFACE:-}
EOF
    mv "${TRAFFIC_DATA_FILE}.tmp" "${TRAFFIC_DATA_FILE}" 2>/dev/null || true
    
    echo "$saved_rx_period $saved_tx_period"
}

get_cpu_stat() {
    awk '/^cpu /{total=$2+$3+$4+$5+$6+$7+$8+$9;idle=$5+$6;printf "%.0f %.0f\n",total,idle}' /proc/stat 2>/dev/null || echo "0 0";
}

json_string_or_null() {
    local val="${1:-}"
    if [ -z "${val}" ]; then
        echo "null"
    else
        echo "\"$(escape_json "${val}")\""
    fi
}

normalize_gpu_name() {
    local gpu_name="${1:-}"
    case "${gpu_name}" in
        *Intel*|*intel*|*INTEL*)
            case "${gpu_name}" in
                *Arc*|*ARC*|*arc*) printf '%s' "${gpu_name}" ;;
                *) printf '%s' "Intel Integrated Graphics" ;;
            esac
            ;;
        *) printf '%s' "${gpu_name}" ;;
    esac
}

get_gpu_metrics() {
    local gpu_info_array=null
    local gpu_count=0

    if command -v nvidia-smi >/dev/null 2>&1; then
        local nvidia_output
        nvidia_output=$(nvidia-smi --query-gpu=index,name,utilization.gpu --format=csv,noheader,nounits 2>/dev/null || true)
        if [ -n "${nvidia_output}" ]; then
            while IFS= read -r nvidia_line; do
                [ -z "${nvidia_line}" ] && continue
                local gpu_idx gpu_name gpu_util gpu_name_escaped
                gpu_idx=$(echo "${nvidia_line}" | awk -F',' '{gsub(/^[ \t]+|[ \t]+$/, "", $1); print $1}')
                gpu_util=$(echo "${nvidia_line}" | awk -F',' '{gsub(/[^0-9.]/, "", $NF); print $NF}')
                gpu_name=$(echo "${nvidia_line}" | sed 's/^[^,]*,//; s/,[^,]*$//' | sed 's/^[ \t]*//;s/[ \t]*$//')
                case "${gpu_util}" in ''|*[!0-9.]*|*.*.*) gpu_util="null" ;; esac
                gpu_name_escaped=$(escape_json "${gpu_name}")
                if [ "${gpu_info_array}" != "null" ]; then
                    gpu_info_array="${gpu_info_array},{\"name\":\"${gpu_name_escaped}\",\"info\":${gpu_util},\"id\":\"${gpu_idx}\"}"
                else
                    gpu_info_array="{\"name\":\"${gpu_name_escaped}\",\"info\":${gpu_util},\"id\":\"${gpu_idx}\"}"
                fi
                gpu_count=$((gpu_count + 1))
            done <<EOF
${nvidia_output}
EOF
        fi
    elif command -v rocm-smi >/dev/null 2>&1; then
        local rocm_names rocm_utils
        rocm_names=$(rocm-smi --showproductname 2>/dev/null | awk -F: '/Card series|Card model|Product Name/{gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}' || true)
        rocm_utils=$(rocm-smi --showuse 2>/dev/null | awk -F: '/GPU use/{gsub(/[^0-9.]/, "", $2); print $2}' || true)
        local idx=0
        while IFS= read -r rname; do
            [ -z "${rname}" ] && continue
            local rutil rname_escaped
            rutil=$(echo "${rocm_utils}" | sed -n "$((idx + 1))p")
            case "${rutil}" in ''|*[!0-9.]*|*.*.*) rutil="null" ;; esac
            rname_escaped=$(escape_json "${rname}")
            if [ "${gpu_info_array}" != "null" ]; then
                gpu_info_array="${gpu_info_array},{\"name\":\"${rname_escaped}\",\"info\":${rutil},\"id\":\"${idx}\"}"
            else
                gpu_info_array="{\"name\":\"${rname_escaped}\",\"info\":${rutil},\"id\":\"${idx}\"}"
            fi
            idx=$((idx + 1))
            gpu_count=$((gpu_count + 1))
        done <<EOF
${rocm_names}
EOF
    fi

    if [ "${gpu_count}" -eq 0 ] && command -v lspci >/dev/null 2>&1; then
        local lspci_gpus
        lspci_gpus=$(lspci 2>/dev/null | awk '/VGA compatible controller|3D controller|Display controller/ && /NVIDIA|AMD|ATI|Radeon|Intel.*(Graphics|Arc|UHD|Iris)/{sub(/^.*: /, ""); print}' || true)
        local lidx=0
        while IFS= read -r lgpu; do
            [ -z "${lgpu}" ] && continue
            lgpu=$(normalize_gpu_name "${lgpu}")
            local lgpu_escaped
            lgpu_escaped=$(escape_json "${lgpu}")
            if [ "${gpu_info_array}" != "null" ]; then
                gpu_info_array="${gpu_info_array},{\"name\":\"${lgpu_escaped}\",\"info\":0,\"id\":\"${lidx}\"}"
            else
                gpu_info_array="{\"name\":\"${lgpu_escaped}\",\"info\":0,\"id\":\"${lidx}\"}"
            fi
            lidx=$((lidx + 1))
            gpu_count=$((gpu_count + 1))
        done <<EOF
${lspci_gpus}
EOF
    fi

    if [ "${gpu_count}" -gt 0 ]; then
        printf '[%s]' "${gpu_info_array}"
    else
        printf 'null'
    fi
}

get_time_ms() {
    local ts
    ts=$(date +%s%3N 2>/dev/null || true)
    case "${ts}" in
        ''|*[!0-9]*) ;;
        ?????????????) echo "${ts}"; return 0 ;;
        ??????????????*) echo "${ts:0:13}"; return 0 ;;
    esac

    ts=$(date +%s%N 2>/dev/null || true)
    case "${ts}" in
        ''|*[!0-9]*) ;;
        ???????????????????) echo "${ts:0:13}"; return 0 ;;
    esac

    if command -v perl >/dev/null 2>&1; then
        perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000' 2>/dev/null && return 0
    fi
    return 1
}

has_nc_zero_io() {
    command -v nc >/dev/null 2>&1 || return 1
    nc -h 2>&1 | grep -q -e '-z' || return 1
    nc -h 2>&1 | grep -q -e '-w' || return 1
}

get_tcp_ping_nc() {
    local host="${1:-}"
    local port="${2:-443}"
    local start end ms

    start=$(get_time_ms) || return 1
    if nc -z -w 2 "${host}" "${port}" >/dev/null 2>&1; then
        end=$(get_time_ms) || return 1
        ms=$((end - start))
        [ "${ms}" -lt 1 ] && ms=1
        echo "${ms}"
        return 0
    fi
    return 1
}

split_probe_target() (
    target="${1:-}"
    default_port="${2:-443}"
    probe_host="$target"
    probe_port="$default_port"

    case "$target" in
        ''|*[!A-Za-z0-9._:-]*) exit 1 ;;
        *:*)
            case "${target#*:}" in *:*) exit 1 ;; esac
            probe_host="${target%:*}"
            probe_port="${target##*:}"
            ;;
    esac

    case "$probe_host" in ''|-*) exit 1 ;; esac
    case "$probe_port" in ''|*[!0-9]*|??????*) exit 1 ;; esac
    [ "$probe_port" -ge 1 ] && [ "$probe_port" -le 65535 ] || exit 1

    printf '%s %s\n' "$probe_host" "$probe_port"
)

get_probe() {
    local target="${1:-}"
    local count="${2:-4}"
    local port="${3:-443}"

    if [ -z "$target" ]; then
        echo "null 100"
        return
    fi

    local host probe_target
    if ! probe_target=$(split_probe_target "$target" "$port"); then
        echo "null 100"
        return
    fi
    host="${probe_target% *}"
    port="${probe_target##* }"

    if has_nc_zero_io && get_time_ms >/dev/null 2>&1; then
        local ok=0 values="" i=1 rtt
        while [ "$i" -le "$count" ]; do
            rtt=$(get_tcp_ping_nc "$host" "$port" 2>/dev/null)
            if [ -n "$rtt" ]; then
                ok=$((ok + 1))
                values="$values $rtt"
            fi
            i=$((i + 1))
        done
        if [ "$ok" -gt 0 ]; then
            local sorted median_val n=$ok
            sorted=$(echo "$values" | tr ' ' '\n' | grep -v '^$' | sort -n)
            if [ $((n % 2)) -eq 1 ]; then
                median_val=$(echo "$sorted" | sed -n "$(( (n + 1) / 2 ))p")
            else
                local a b
                a=$(echo "$sorted" | sed -n "$(( n / 2 ))p")
                b=$(echo "$sorted" | sed -n "$(( n / 2 + 1 ))p")
                median_val=$(( (a + b) / 2 ))
            fi
            echo "$median_val $(( (count - ok) * 100 / count ))"
        else
            echo "null 100"
        fi
        return
    fi

    local icmp_out
    icmp_out=$(ping -c "$count" -W 2 "$host" 2>/dev/null)
    local avg_rtt loss
    avg_rtt=$(echo "$icmp_out" | awk -F'[/ ]' '/^rtt/{print $8}' | cut -d. -f1)
    loss=$(echo "$icmp_out" | awk '/packet loss/{for(i=1;i<=NF;i++) if($i~/[0-9]+%/){gsub(/%/,"",$i);printf "%d",$i;exit}}')
    [ -z "$avg_rtt" ] && avg_rtt="null"
    [ -z "$loss" ] && loss=100
    echo "$avg_rtt $loss"
}

CT_NODE="${CT_NODE:-}"
CU_NODE="${CU_NODE:-}"
CM_NODE="${CM_NODE:-}"
BD_NODE="${BD_NODE:-}"

write_probe_result() {
    local dest="$1"
    shift
    local tmp="${dest}.tmp"
    rm -f "$tmp"
    "$@" > "$tmp" 2>/dev/null || true
    if [ -s "$tmp" ]; then
        mv "$tmp" "$dest"
    else
        rm -f "$tmp" "$dest"
    fi
}

get_cf_trace_ip() {
    local curl_family="$1"
    local ip_value
    ip_value=$(curl "$curl_family" --noproxy cloudflare.com -s -m 5 --connect-timeout 5 https://cloudflare.com/cdn-cgi/trace 2>/dev/null | awk -F= '$1 == "ip" { print $2; exit }') || ip_value=""
    if [ -n "$ip_value" ]; then
        printf '%s\n' "$ip_value"
    else
        printf '0\n'
    fi
}

refresh_probe_async() {
    [ -n "$CT_NODE" ] && write_probe_result /tmp/.cf_probe_ct get_probe "$CT_NODE" 4 443 &
    [ -n "$CU_NODE" ] && write_probe_result /tmp/.cf_probe_cu get_probe "$CU_NODE" 4 443 &
    [ -n "$CM_NODE" ] && write_probe_result /tmp/.cf_probe_cm get_probe "$CM_NODE" 4 443 &
    [ -n "$BD_NODE" ] && write_probe_result /tmp/.cf_probe_bd get_probe "$BD_NODE" 4 443 &
    wait
}

# ==============================================================================
# 高并发/无竞态后台网络 Worker 协程
# ==============================================================================
run_network_worker() {
    set -eu
    local last_ip=0
    local last_probe=0
    probe_interval="${REPORT_INTERVAL:-60}"
    case "$probe_interval" in ''|*[!0-9]*) probe_interval=60 ;; esac
    [ "$probe_interval" -lt 30 ] && probe_interval=30
    [ "$probe_interval" -gt 60 ] && probe_interval=60

    while true; do
        local now; now=$(date +%s)

        if [ $((now - last_ip)) -ge 600 ] || [ "$last_ip" -eq 0 ]; then
            get_cf_trace_ip "-4" > /tmp/.cf_ipv4.tmp && mv /tmp/.cf_ipv4.tmp /tmp/.cf_ipv4 || true
            (if ip -6 route show default >/dev/null 2>&1; then get_cf_trace_ip "-6"; else echo "0"; fi) > /tmp/.cf_ipv6.tmp && mv /tmp/.cf_ipv6.tmp /tmp/.cf_ipv6 || true
            last_ip="$now"
        fi

        if [ $((now - last_probe)) -ge "$probe_interval" ] || [ "$last_probe" -eq 0 ]; then
            refresh_probe_async
            last_probe="$now"
        fi
        sleep 5
    done
}

# 首次基础数据初始化
NET_STAT=$(get_net_bytes)
RX_PREV=$(echo "$NET_STAT" | awk '{print $1}'); RX_PREV=${RX_PREV:-0}
TX_PREV=$(echo "$NET_STAT" | awk '{print $2}'); TX_PREV=${TX_PREV:-0}

CPU_STAT=$(get_cpu_stat)
PREV_CPU_TOTAL=$(echo "$CPU_STAT" | awk '{print $1}'); PREV_CPU_TOTAL=${PREV_CPU_TOTAL:-0}
PREV_CPU_IDLE=$(echo "$CPU_STAT" | awk '{print $2}'); PREV_CPU_IDLE=${PREV_CPU_IDLE:-0}

PREV_LOOP_TIME=$(date +%s)

# 缓存间隔定义
DISK_CHECK_INTERVAL=120          # 硬盘检测：2分钟
LAST_DISK_CHECK=0
# 状态检测：固定60秒
STATUS_CHECK_INTERVAL=60
LAST_STATUS_CHECK=0

# set -u 安全初始化：所有缓存变量在循环前初始化为默认值
DISK_TOTAL=0; DISK_USED=0
OS=""; ARCH=""; KERNEL_VERSION=""; BOOT_TIME=0; CPU_INFO=""; CPU_CORES=1
GPU_INFO_VALUE="null"; LOAD_AVG="0 0 0"; PROCESSES=0; TCP_CONN=0; UDP_CONN=0
RX_MONTHLY=0; TX_MONTHLY=0

echo "[INFO] CF-Server-Monitor Probe Engine Started Successfully."

# 核心架构升级：在这里脱离主循环，静默启动常驻网络 Worker 协程，无 wait 干扰
run_network_worker &
WORKER_PID=$!
SAMPLES_JSON=""
SAMPLE_COUNT=0
LAST_REPORT_TIME=0

while true; do
    LOOP_START_TIME=$(date +%s)
    rotate_log_if_needed "$PROBE_LOG_FILE"

    # Worker 进程健康检查与自动重启
    if ! kill -0 "$WORKER_PID" 2>/dev/null; then
        run_network_worker &
        WORKER_PID=$!
    fi
    
    MEM_TOTAL_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); MEM_TOTAL_KB=${MEM_TOTAL_KB:-0}
    MEM_AVAIL_KB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); MEM_AVAIL_KB=${MEM_AVAIL_KB:-0}
    if [ "${MEM_AVAIL_KB}" -eq 0 ]; then
        MEM_FREE_KB=$(awk '/^MemFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); MEM_FREE_KB=${MEM_FREE_KB:-0}
        MEM_BUFF_KB=$(awk '/^Buffers:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); MEM_BUFF_KB=${MEM_BUFF_KB:-0}
        MEM_CACH_KB=$(awk '/^Cached:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); MEM_CACH_KB=${MEM_CACH_KB:-0}
        MEM_AVAIL_KB=$((MEM_FREE_KB + MEM_BUFF_KB + MEM_CACH_KB))
    fi
    RAM_TOTAL=$((MEM_TOTAL_KB / 1024))
    RAM_USED=$(((MEM_TOTAL_KB - MEM_AVAIL_KB) / 1024))
    [ "${RAM_USED}" -lt 0 ] && RAM_USED=0

    SWAP_TOTAL_KB=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); SWAP_TOTAL_KB=${SWAP_TOTAL_KB:-0}
    SWAP_FREE_KB=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0); SWAP_FREE_KB=${SWAP_FREE_KB:-0}
    SWAP_TOTAL=$((SWAP_TOTAL_KB / 1024))
    SWAP_USED=$(((SWAP_TOTAL_KB - SWAP_FREE_KB) / 1024))
    [ "${SWAP_USED}" -lt 0 ] && SWAP_USED=0

    # 磁盘检测（缓存机制：每2分钟检测一次）
    if [ $((LOOP_START_TIME - LAST_DISK_CHECK)) -ge "${DISK_CHECK_INTERVAL}" ] || [ "${LAST_DISK_CHECK}" -eq 0 ]; then
        DISK_INFO=$(df -P / 2>/dev/null | tail -n1 || echo "")
        DISK_TOTAL=0; DISK_USED=0
        if [ -n "${DISK_INFO}" ]; then
            DISK_TOTAL=$(echo "${DISK_INFO}" | awk '{print int($2/1024)}')
            DISK_USED=$(echo "${DISK_INFO}" | awk '{print int($3/1024)}')
        fi
        LAST_DISK_CHECK="${LOOP_START_TIME}"
    fi

    CPU_STAT=$(get_cpu_stat)
    CPU_TOTAL_NOW=$(echo "$CPU_STAT" | awk '{print $1}'); CPU_TOTAL_NOW=${CPU_TOTAL_NOW:-0}
    CPU_IDLE_NOW=$(echo "$CPU_STAT" | awk '{print $2}'); CPU_IDLE_NOW=${CPU_IDLE_NOW:-0}
    DIFF_TOTAL=$((CPU_TOTAL_NOW - PREV_CPU_TOTAL))
    DIFF_IDLE=$((CPU_IDLE_NOW - PREV_CPU_IDLE))
    
    if [ "${DIFF_TOTAL}" -le 0 ]; then
        CPU="0.00"
    else
        CPU=$(awk -v t="${DIFF_TOTAL}" -v i="${DIFF_IDLE}" 'BEGIN {p=(1-i/t)*100; if(p<0)p=0; if(p>100)p=100; printf "%.2f", p}')
    fi
    PREV_CPU_TOTAL=${CPU_TOTAL_NOW}
    PREV_CPU_IDLE=${CPU_IDLE_NOW}

    # 获取网络字节数（网速计算需要每次执行，流量统计也需要）
    NET_STAT=$(get_net_bytes)
    RX_NOW=$(echo "$NET_STAT" | awk '{print $1}'); RX_NOW=${RX_NOW:-0}
    TX_NOW=$(echo "$NET_STAT" | awk '{print $2}'); TX_NOW=${TX_NOW:-0}

    # 静态信息（仅首次运行时获取，运行期间不会变化）
    if [ "${LAST_STATUS_CHECK}" -eq 0 ]; then
        if [ -f /etc/os-release ]; then
            OS_RAW=$(grep -E '^PRETTY_NAME=' /etc/os-release | cut -d= -f2 | tr -d '"' | tr -d "'")
        else
            OS_RAW=$(uname -srm)
        fi
        OS=${OS_RAW:-"Alpine Linux"}
        ARCH=$(uname -m)
        KERNEL_VERSION=$(uname -r 2>/dev/null || echo "")
        BOOT_TIME=$(awk '$1=="btime"{print $2}' /proc/stat 2>/dev/null)
        if [ -n "${BOOT_TIME:-}" ]; then
            BOOT_TIME=$((BOOT_TIME * 1000))
        else
            uptime_sec=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)
            now_sec=$(date +%s)

            if [ "$uptime_sec" -gt 0 ] 2>/dev/null; then
                BOOT_TIME=$(( (now_sec - uptime_sec) * 1000 ))
            else
                BOOT_TIME=0
            fi
        fi
        CPU_INFO=$(grep -m 1 'model name' /proc/cpuinfo 2>/dev/null | awk -F: '{print $2}' | xargs || echo "")
        [ -z "${CPU_INFO}" ] && CPU_INFO=${ARCH}
        CPU_CORES=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo "1")
    fi

    # 状态检测缓存：进程数、连接数、GPU使用率、负载、当月累计流量（每STATUS_CHECK_INTERVAL检测一次）
    if [ $((LOOP_START_TIME - LAST_STATUS_CHECK)) -ge "${STATUS_CHECK_INTERVAL}" ] || [ "${LAST_STATUS_CHECK}" -eq 0 ]; then
        GPU_INFO_VALUE=$(get_gpu_metrics)
        [ -z "${GPU_INFO_VALUE}" ] && GPU_INFO_VALUE="null"
        LOAD_AVG=$(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}' || echo "0 0 0")
        PROCESSES=$(ps -e 2>/dev/null | wc -l || echo 0)

        # ---------------- TCP ----------------
        TCP_CONN=""
        if command -v ss >/dev/null 2>&1; then
            TCP_CONN=$(ss -H -ant state established 2>/dev/null | wc -l)
        else
            TCP_CONN=$(awk 'NR>1 && $4=="01"{c++} END{print c+0}' /proc/net/tcp 2>/dev/null)
        fi
        TCP_CONN=$(printf "%s" "${TCP_CONN:-0}" | tr -d '\r\n ')

        # ---------------- UDP ----------------
        UDP_CONN=""
        if command -v ss >/dev/null 2>&1; then
            UDP_CONN=$(ss -H -anu 2>/dev/null | wc -l)
        else
            UDP_CONN=$(awk 'NR>1{c++} END{print c+0}' /proc/net/udp 2>/dev/null)
        fi
        UDP_CONN=$(printf "%s" "${UDP_CONN:-0}" | tr -d '\r\n ')

        # 计算当月累计流量
        MONTHLY_TRAFFIC=$(calc_monthly_traffic "$RX_NOW" "$TX_NOW")
        RX_MONTHLY=$(echo "$MONTHLY_TRAFFIC" | awk '{print $1}')
        TX_MONTHLY=$(echo "$MONTHLY_TRAFFIC" | awk '{print $2}')

        LAST_STATUS_CHECK="${LOOP_START_TIME}"
    fi
    
    TIME_DELTA=$((LOOP_START_TIME - PREV_LOOP_TIME))
    [ "${TIME_DELTA}" -le 0 ] && TIME_DELTA=${ACTIVE_INTERVAL}
    
    RX_DELTA=$((RX_NOW - RX_PREV))
    TX_DELTA=$((TX_NOW - TX_PREV))
    [ "${RX_DELTA}" -lt 0 ] && RX_DELTA=0
    [ "${TX_DELTA}" -lt 0 ] && TX_DELTA=0
    
    RX_SPEED=$(safe_div "${RX_DELTA}" "${TIME_DELTA}" "0")
    TX_SPEED=$(safe_div "${TX_DELTA}" "${TIME_DELTA}" "0")
    
    RX_PREV=${RX_NOW}
    TX_PREV=${TX_NOW}
    PREV_LOOP_TIME=${LOOP_START_TIME}

    [ -f /tmp/.cf_ipv4 ] && IPV4=$(cat /tmp/.cf_ipv4) || IPV4="0"
    [ -f /tmp/.cf_ipv6 ] && IPV6=$(cat /tmp/.cf_ipv6) || IPV6="0"
    if [ -f /tmp/.cf_probe_ct ]; then _p=$(cat /tmp/.cf_probe_ct); PING_CT=${_p%% *}; LOSS_CT=${_p##* }; else PING_CT=""; LOSS_CT=""; fi
    if [ -f /tmp/.cf_probe_cu ]; then _p=$(cat /tmp/.cf_probe_cu); PING_CU=${_p%% *}; LOSS_CU=${_p##* }; else PING_CU=""; LOSS_CU=""; fi
    if [ -f /tmp/.cf_probe_cm ]; then _p=$(cat /tmp/.cf_probe_cm); PING_CM=${_p%% *}; LOSS_CM=${_p##* }; else PING_CM=""; LOSS_CM=""; fi
    if [ -f /tmp/.cf_probe_bd ]; then _p=$(cat /tmp/.cf_probe_bd); PING_BD=${_p%% *}; LOSS_BD=${_p##* }; else PING_BD=""; LOSS_BD=""; fi

    EOS=$(escape_json "${OS}")
    EARCH=$(escape_json "${ARCH}")
    ECPU=$(escape_json "${CPU_INFO}")
    EKERNEL=$(escape_json "${KERNEL_VERSION}")
    PING_CT_JSON=$(json_probe_value "$CT_NODE" "$PING_CT")
    PING_CU_JSON=$(json_probe_value "$CU_NODE" "$PING_CU")
    PING_CM_JSON=$(json_probe_value "$CM_NODE" "$PING_CM")
    PING_BD_JSON=$(json_probe_value "$BD_NODE" "$PING_BD")
    LOSS_CT_JSON=$(json_probe_value "$CT_NODE" "$LOSS_CT")
    LOSS_CU_JSON=$(json_probe_value "$CU_NODE" "$LOSS_CU")
    LOSS_CM_JSON=$(json_probe_value "$CM_NODE" "$LOSS_CM")
    LOSS_BD_JSON=$(json_probe_value "$BD_NODE" "$LOSS_BD")

    METRICS_JSON=$(cat <<EOF
{"cpu":"$CPU","ram_total":"$RAM_TOTAL","ram_used":"$RAM_USED","swap_total":"$SWAP_TOTAL","swap_used":"$SWAP_USED","disk_total":"$DISK_TOTAL","disk_used":"$DISK_USED","load_avg":"$LOAD_AVG","boot_time":"$BOOT_TIME","net_rx":"$RX_NOW","net_tx":"$TX_NOW","net_rx_monthly":"$RX_MONTHLY","net_tx_monthly":"$TX_MONTHLY","net_in_speed":"$RX_SPEED","net_out_speed":"$TX_SPEED","os":"$EOS","arch":"$EARCH","kernel_version":"$EKERNEL","cpu_info":"$ECPU","cpu_cores":"$CPU_CORES","gpu_info":$GPU_INFO_VALUE,"processes":"$PROCESSES","tcp_conn":"$TCP_CONN","udp_conn":"$UDP_CONN","ip_v4":"$IPV4","ip_v6":"$IPV6","ping_ct":$PING_CT_JSON,"ping_cu":$PING_CU_JSON,"ping_cm":$PING_CM_JSON,"ping_bd":$PING_BD_JSON,"loss_ct":$LOSS_CT_JSON,"loss_cu":$LOSS_CU_JSON,"loss_cm":$LOSS_CM_JSON,"loss_bd":$LOSS_BD_JSON}
EOF
)
    SAMPLE_METRICS_JSON=$(cat <<EOF
{"cpu":"$CPU","ram_total":"$RAM_TOTAL","ram_used":"$RAM_USED","swap_total":"$SWAP_TOTAL","swap_used":"$SWAP_USED","net_in_speed":"$RX_SPEED","net_out_speed":"$TX_SPEED"}
EOF
)
    if [ "$COLLECT_INTERVAL" -gt 0 ]; then
        SAMPLE_TS=$((LOOP_START_TIME * 1000))
        SAMPLE_JSON="{\"ts\":$SAMPLE_TS,\"metrics\":$SAMPLE_METRICS_JSON}"
        if [ -z "$SAMPLES_JSON" ]; then
            SAMPLES_JSON="$SAMPLE_JSON"
        else
            SAMPLES_JSON="$SAMPLES_JSON,$SAMPLE_JSON"
        fi
        SAMPLE_COUNT=$((SAMPLE_COUNT + 1))
    fi

    if [ "$LAST_REPORT_TIME" -eq 0 ] || [ $((LOOP_START_TIME - LAST_REPORT_TIME)) -ge "$REPORT_INTERVAL" ]; then
        if [ "$COLLECT_INTERVAL" -gt 0 ]; then
            PAYLOAD=$(cat <<EOF
{"id":"$SERVER_ID","secret":"$SECRET","metrics":$METRICS_JSON,"samples":[$SAMPLES_JSON],"collect_interval":$COLLECT_INTERVAL,"report_interval":$REPORT_INTERVAL}
EOF
)
        else
            PAYLOAD=$(cat <<EOF
{"id":"$SERVER_ID","secret":"$SECRET","metrics":$METRICS_JSON,"collect_interval":$COLLECT_INTERVAL,"report_interval":$REPORT_INTERVAL}
EOF
)
        fi
        REPORT_RESPONSE_FILE="/tmp/.cf_probe_response.$$"
        REPORT_HEADER_FILE="/tmp/.cf_probe_headers.$$"
        REPORT_HTTP_CODE=$(curl -sS -D "$REPORT_HEADER_FILE" -o "$REPORT_RESPONSE_FILE" -w "%{http_code}" -X POST \
            -H "Content-Type: application/json" \
            -H "X-Agent-Config-Schema: 3" \
            -H "X-Agent-Version: ${AGENT_VERSION}" \
            -H "X-Agent-Config-Md5: ${CONFIG_MD5:-none}" \
            -d "$PAYLOAD" -m 8 --connect-timeout 3 "$WORKER_URL" 2>/dev/null || echo 000)
        case "$REPORT_HTTP_CODE" in ''|*[!0-9]*) REPORT_HTTP_CODE=000 ;; esac
        if [ "$REPORT_HTTP_CODE" = "200" ]; then
            apply_remote_config "$REPORT_RESPONSE_FILE" "$REPORT_HEADER_FILE" || true
        fi
        rm -f "$REPORT_RESPONSE_FILE" "$REPORT_HEADER_FILE" 2>/dev/null || true
        SAMPLES_JSON=""
        SAMPLE_COUNT=0
        LAST_REPORT_TIME=$LOOP_START_TIME
    fi

    sleep "${ACTIVE_INTERVAL}"
done
PROBE_EOF

    chmod +x "${SCRIPT_FILE}"
    info "探针脚本注入完成: ${SCRIPT_FILE}"
}

# ---------------------------------------------------------------
# 创建 OpenRC 服务脚本 / 手动启停入口
# ---------------------------------------------------------------
create_service() {
    step "构建服务配置..."
    
    cat > "${OPENRC_FILE}" << EOF
#!/sbin/openrc-run
# CF-Server-Monitor Probe Agent (Alpine Linux)

description="CF Server Monitor Probe Agent"
command="/bin/bash"
command_args="${SCRIPT_FILE}"
command_background="yes"
pidfile="${PID_FILE}"
output_log="${LOG_FILE}"
error_log="${LOG_FILE}"

depend() {
    need net
    use dns
    after firewall
}
EOF
    chmod +x "${OPENRC_FILE}"
    info "OpenRC 服务脚本生成: ${OPENRC_FILE}"

    echo "#!/bin/sh
# CF-Server-Monitor 手动启停脚本（Alpine Linux）
START_CMD='/bin/bash ${SCRIPT_FILE} > ${LOG_FILE} 2>&1 &'
PID_FILE='${PID_FILE}'
LOG_FILE='${LOG_FILE}'

case \"\${1:-start}\" in
    start)
        if [ -f \"\$PID_FILE\" ] && kill -0 \"\$(cat \$PID_FILE)\" >/dev/null 2>&1; then
            echo '探针已在运行。'
            exit 0
        fi
        nohup /bin/bash ${SCRIPT_FILE} >> \$LOG_FILE 2>&1 &
        echo \$! > \$PID_FILE
        disown >/dev/null 2>&1 || true
        echo '探针已启动（PID: '\"\$(cat \$PID_FILE)\"'）'
        ;;
    stop)
        if [ -f \"\$PID_FILE\" ]; then
            PID=\$(cat \$PID_FILE)
            kill -TERM \$PID >/dev/null 2>&1 || true
            sleep 1
            kill -9 \$PID >/dev/null 2>&1 || true
            rm -f \$PID_FILE
            echo '探针已停止。'
        else
            pkill -9 -f '${SERVICE_NAME}.sh' >/dev/null 2>&1 || true
            echo '未找到 PID 文件，已尝试按进程名清理。'
        fi
        ;;
    status)
        if [ -f \"\$PID_FILE\" ] && kill -0 \"\$(cat \$PID_FILE)\" >/dev/null 2>&1; then
            echo '运行中（PID: '\"\$(cat \$PID_FILE)\"'）'
        else
            echo '未运行'
        fi
        ;;
    restart)
        \$0 stop
        sleep 1
        \$0 start
        ;;
    log)
        tail -f \$LOG_FILE
        ;;
    *)
        echo '用法: \$0 {start|stop|status|restart|log}'
        exit 1
        ;;
esac
" > "${SCRIPT_FILE}.ctl"
    chmod +x "${SCRIPT_FILE}.ctl"
}

# ---------------------------------------------------------------
# 启动服务
# ---------------------------------------------------------------
start_service() {
    step "加载进程树并激活监控探针..."

    if [ "$INIT_SYSTEM" = "openrc" ]; then
        rc-update add "${SERVICE_NAME}" default >/dev/null 2>&1 || true
        rc-service "${SERVICE_NAME}" restart || error "OpenRC 服务启动失败，请检查日志: tail -n 30 ${LOG_FILE}"
    else
        sh "${SCRIPT_FILE}.ctl" start || error "后台进程启动失败，请检查日志: tail -n 30 ${LOG_FILE}"
    fi

    sleep 2

    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
        info "探针监控引擎已进入平稳运行状态。"
    else
        error "探针服务未能启动成功。请排查: tail -n 30 ${LOG_FILE}"
    fi
}

# ---------------------------------------------------------------
# 安装主流程
# ---------------------------------------------------------------
install_probe() {
    SERVER_ID=""
    SECRET=""
    WORKER_URL=""
    COLLECT_INTERVAL=""
    REPORT_INTERVAL=""
    CT_NODE=""
    CU_NODE=""
    CM_NODE=""
    BD_NODE=""
    INTERFACE=""
    RESET_DAY=""
    AUTO_UPDATE=""
    RX_CORRECTION=""
    TX_CORRECTION=""

    for arg in "$@"; do
        case "$arg" in
            -id=*) SERVER_ID="${arg#-id=}" ;;
            -secret=*) SECRET="${arg#-secret=}" ;;
            -url=*) WORKER_URL="${arg#-url=}" ;;
            -collect_interval=*|-collect=*) COLLECT_INTERVAL="${arg#*=}" ;;
            -interval=*) REPORT_INTERVAL="${arg#-interval=}" ;;
            -ct=*) CT_NODE="${arg#-ct=}" ;;
            -cu=*) CU_NODE="${arg#-cu=}" ;;
            -cm=*) CM_NODE="${arg#-cm=}" ;;
            -bd=*) BD_NODE="${arg#-bd=}" ;;
            -interface=*|-interfaces=*|-iface=*) INTERFACE="${arg#*=}" ;;
            -reset_day=*) RESET_DAY="${arg#-reset_day=}" ;;
            -auto_update=*|-auto-update=*) AUTO_UPDATE=$(normalize_binary_value "${arg#*=}") || error "auto_update 参数非法，仅支持 0 或 1" ;;
            -rx_correction=*) RX_CORRECTION="${arg#-rx_correction=}" ;;
            -tx_correction=*) TX_CORRECTION="${arg#-tx_correction=}" ;;
        esac
    done

    print_banner
    check_root
    detect_os
    install_deps

    stop_old_service

    if [ -f "${CONFIG_FILE}" ]; then
        step "检测到已有配置文件，执行二次安装..."
        
        if [ -n "${SERVER_ID}" ] && [ -n "${SECRET}" ] && [ -n "${WORKER_URL}" ]; then
            COLLECT_INTERVAL=${COLLECT_INTERVAL:-0}
            REPORT_INTERVAL=${REPORT_INTERVAL:-60}
            [ -z "$RESET_DAY" ] && RESET_DAY=1
            AUTO_UPDATE=$(normalize_binary_value "$AUTO_UPDATE" 0) || error "auto_update 参数非法，仅支持 0 或 1"

            step "更新配置文件..."
            INTERFACE=$(normalize_interface_list "${INTERFACE:-}") || error "interface parameter is invalid; use comma-separated interface names"
            cat > "${CONFIG_FILE}" << EOF
SERVER_ID="${SERVER_ID}"
SECRET="${SECRET}"
WORKER_URL="${WORKER_URL}"
COLLECT_INTERVAL="${COLLECT_INTERVAL}"
REPORT_INTERVAL="${REPORT_INTERVAL}"
CT_NODE="${CT_NODE:-}"
CU_NODE="${CU_NODE:-}"
CM_NODE="${CM_NODE:-}"
BD_NODE="${BD_NODE:-}"
INTERFACE="${INTERFACE:-}"
RESET_DAY="${RESET_DAY}"
AUTO_UPDATE="${AUTO_UPDATE}"
CONFIG_MD5="none"
EOF
            chmod 600 "${CONFIG_FILE}" 2>/dev/null || true
            info "配置文件已更新: ${CONFIG_FILE}"
        else
            step "从配置文件读取参数..."
            while IFS='=' read -r key value; do
                case "$key" in
                    SERVER_ID) SERVER_ID="${value%\"}"; SERVER_ID="${SERVER_ID#\"}" ;;
                    SECRET) SECRET="${value%\"}"; SECRET="${SECRET#\"}" ;;
                    WORKER_URL) WORKER_URL="${value%\"}"; WORKER_URL="${WORKER_URL#\"}" ;;
                    COLLECT_INTERVAL) COLLECT_INTERVAL="${value%\"}"; COLLECT_INTERVAL="${COLLECT_INTERVAL#\"}" ;;
                    REPORT_INTERVAL) REPORT_INTERVAL="${value%\"}"; REPORT_INTERVAL="${REPORT_INTERVAL#\"}" ;;
                    CT_NODE) CT_NODE="${value%\"}"; CT_NODE="${CT_NODE#\"}" ;;
                    CU_NODE) CU_NODE="${value%\"}"; CU_NODE="${CU_NODE#\"}" ;;
                    CM_NODE) CM_NODE="${value%\"}"; CM_NODE="${CM_NODE#\"}" ;;
                    BD_NODE) BD_NODE="${value%\"}"; BD_NODE="${BD_NODE#\"}" ;;
                    INTERFACE) INTERFACE="${value%\"}"; INTERFACE="${INTERFACE#\"}" ;;
                    RESET_DAY) RESET_DAY="${value%\"}"; RESET_DAY="${RESET_DAY#\"}" ;;
                    AUTO_UPDATE) AUTO_UPDATE="${value%\"}"; AUTO_UPDATE="${AUTO_UPDATE#\"}" ;;
                esac
            done < "${CONFIG_FILE}"
        fi
    else
        if [ -z "${SERVER_ID}" ] || [ -z "${SECRET}" ] || [ -z "${WORKER_URL}" ]; then
            print_usage
        fi

        COLLECT_INTERVAL=${COLLECT_INTERVAL:-0}
        REPORT_INTERVAL=${REPORT_INTERVAL:-60}
        [ -z "$RESET_DAY" ] && RESET_DAY=1
        AUTO_UPDATE=$(normalize_binary_value "$AUTO_UPDATE" 0) || error "auto_update 参数非法，仅支持 0 或 1"

        step "创建配置目录..."
        mkdir -p "${CONFIG_DIR}" 2>/dev/null || true

        if [ -f "${OLD_TRAFFIC_DATA_FILE}" ]; then
            step "迁移旧流量数据..."
            mv "${OLD_TRAFFIC_DATA_FILE}" "${TRAFFIC_DATA_FILE}" 2>/dev/null || true
            rm -rf /var/lib/cf-probe 2>/dev/null || true
            info "已从旧路径迁移流量数据"
        elif [ ! -f "${TRAFFIC_DATA_FILE}" ]; then
            touch "${TRAFFIC_DATA_FILE}" 2>/dev/null || true
            info "创建新流量数据文件"
        fi

        step "生成配置文件..."
        INTERFACE=$(normalize_interface_list "${INTERFACE:-}") || error "interface parameter is invalid; use comma-separated interface names"
        cat > "${CONFIG_FILE}" << EOF
SERVER_ID="${SERVER_ID}"
SECRET="${SECRET}"
WORKER_URL="${WORKER_URL}"
COLLECT_INTERVAL="${COLLECT_INTERVAL}"
REPORT_INTERVAL="${REPORT_INTERVAL}"
CT_NODE="${CT_NODE:-}"
CU_NODE="${CU_NODE:-}"
CM_NODE="${CM_NODE:-}"
BD_NODE="${BD_NODE:-}"
INTERFACE="${INTERFACE:-}"
RESET_DAY="${RESET_DAY}"
AUTO_UPDATE="${AUTO_UPDATE}"
CONFIG_MD5="none"
EOF
        chmod 600 "${CONFIG_FILE}" 2>/dev/null || true
        info "配置文件已生成: ${CONFIG_FILE}"
    fi

    COLLECT_INTERVAL=${COLLECT_INTERVAL:-0}
    REPORT_INTERVAL=${REPORT_INTERVAL:-60}
    AUTO_UPDATE=$(normalize_binary_value "$AUTO_UPDATE" 0) || error "auto_update 参数非法，仅支持 0 或 1"

    INTERFACE=$(normalize_interface_list "${INTERFACE:-}") || error "interface parameter is invalid; use comma-separated interface names"

    if [ -n "${RX_CORRECTION}" ] || [ -n "${TX_CORRECTION}" ]; then
        step "应用流量校正..."
        rm -f "${OLD_TRAFFIC_DATA_FILE}" 2>/dev/null || true
        
        mkdir -p "${CONFIG_DIR}" 2>/dev/null || true
        local now_ts=$(date '+%s')
        local rx_correction_bytes=0 tx_correction_bytes=0
        local current_net=$(get_configured_net_bytes "${INTERFACE:-}")
        local current_rx=$(echo "${current_net}" | awk '{print $1}'); current_rx=${current_rx:-0}
        local current_tx=$(echo "${current_net}" | awk '{print $2}'); current_tx=${current_tx:-0}
        [ -n "${RX_CORRECTION}" ] && rx_correction_bytes=$(echo "${RX_CORRECTION}" | awk '{printf "%.0f", $1 * 1024 * 1024 * 1024}')
        [ -n "${TX_CORRECTION}" ] && tx_correction_bytes=$(echo "${TX_CORRECTION}" | awk '{printf "%.0f", $1 * 1024 * 1024 * 1024}')
        [ -n "${RX_CORRECTION}" ] && info "下行流量校正: ${RX_CORRECTION}GB"
        [ -n "${TX_CORRECTION}" ] && info "上行流量校正: ${TX_CORRECTION}GB"
        
        cat > "${TRAFFIC_DATA_FILE}" << EOF
RX_PREV=${current_rx}
TX_PREV=${current_tx}
RX_PERIOD=${rx_correction_bytes}
TX_PERIOD=${tx_correction_bytes}
LAST_CHECK=${now_ts}
PERIOD_START=0
INTERFACE=${INTERFACE:-}
EOF
    fi

    create_script
    create_service
    start_service

    printf '\n%b=============================================%b\n' "${GREEN}" "${NC}"
    printf  '         CF-Server-Monitor %s 安装成功\n' "${AGENT_VERSION}"
    printf  '%b=============================================%b\n' "${GREEN}" "${NC}"
    printf  '  服务状态 : %bActive (Running)%b\n' "${GREEN}" "${NC}"
    printf  '  配置参数 :\n'
    printf  '    ● Server ID   : %s\n' "${SERVER_ID}"
    printf  '    ● Secret      : %s\n' "********"
    printf  '    ● Worker URL  : %s\n' "${WORKER_URL}"
    printf  '    ● 上报间隔    : %s秒\n' "${REPORT_INTERVAL}"
    printf  '    ● 采样间隔    : %s秒\n' "${COLLECT_INTERVAL}"
    printf  '    ● 自动更新    : %s\n' "${AUTO_UPDATE}"
    [ -n "${RX_CORRECTION}" ] && printf  '    ● 下行校正    : %sGB\n' "${RX_CORRECTION}"
    [ -n "${TX_CORRECTION}" ] && printf  '    ● 上行校正    : %sGB\n' "${TX_CORRECTION}"
    printf  '    Interface   : %s\n' "${INTERFACE:-auto}"
    if [ "${RESET_DAY}" = "0" ]; then
        printf  '    ● 流量重置日  : 不重置\n'
    else
        printf  '    ● 流量重置日  : %s号\n' "${RESET_DAY}"
    fi
    [ -n "${CT_NODE}" ] && printf  '    ● CT节点      : %s\n' "${CT_NODE}"
    [ -n "${CU_NODE}" ] && printf  '    ● CU节点      : %s\n' "${CU_NODE}"
    [ -n "${CM_NODE}" ] && printf  '    ● CM节点      : %s\n' "${CM_NODE}"
    [ -n "${BD_NODE}" ] && printf  '    ● BD节点      : %s\n' "${BD_NODE}"
    printf  '  运行模式 : '
    case "$INIT_SYSTEM" in
        openrc) echo "OpenRC 系统服务 (${OPENRC_FILE})" ;;
        *)      echo "手动后台进程 (PID: $(cat "$PID_FILE"))" ;;
    esac
    printf  '  管理指令 :\n'
    if [ "$INIT_SYSTEM" = "openrc" ]; then
        printf  '    ● 查看日志     : tail -f %s\n' "${LOG_FILE}"
        printf  '    ● 查看状态     : rc-service %s status\n' "${SERVICE_NAME}"
        printf  '    ● 启动/停止    : rc-service %s {start|stop|restart}\n' "${SERVICE_NAME}"
    else
        printf  '    ● 查看日志     : tail -f %s\n' "${LOG_FILE}"
        printf  '    ● 启动/停止    : sh %s {start|stop|restart|status|log}\n' "${SCRIPT_FILE}.ctl"
    fi
    printf  '    ● 彻底卸载     : sh %s uninstall\n' "$0"
    printf  '%b=============================================%b\n\n' "${GREEN}" "${NC}"
}

# ---------------------------------------------------------------
# 卸载主流程
# ---------------------------------------------------------------

uninstall_probe() {
    print_banner
    printf '%b[!] 开始执行无残留深度卸载清理方案...%b\n\n' "${YELLOW}" "${NC}"
    check_root
    detect_os

    step "停用并撤销系统守护进程..."
    stop_old_service

    step "清理服务描述性系统文件..."
    rm -f "${OPENRC_FILE}"

    step "销毁探针物理可执行代码文件..."
    rm -f "${SCRIPT_FILE}"
    rm -f "${SCRIPT_FILE}.ctl"

    step "抹除共享内存高速缓存区..."
    rm -f /tmp/.cf_ipv4 /tmp/.cf_ipv6 /tmp/.cf_probe_* 2>/dev/null || true

    step "抹除流量追踪数据..."
    rm -rf /var/lib/${SERVICE_NAME}
    rm -rf "${CONFIG_DIR}"

    step "清理日志与 PID 文件..."
    rm -f "${PID_FILE}" "${LOG_FILE}" 2>/dev/null || true

    printf '\n%b╔══════════════════════════════════════════╗%b\n' "${GREEN}" "${NC}"
    printf  '║     ✓ 卸载完毕！系统环境无任何残留。     ║\n'
    printf  '%b╚══════════════════════════════════════════╝%b\n\n' "${GREEN}" "${NC}"
}

# ---------------------------------------------------------------
# 入口
# ---------------------------------------------------------------
case "${1:-install}" in
    install)
        shift 1 2>/dev/null || true
        install_probe "$@"
        ;;
    uninstall|remove|delete|purge)
        uninstall_probe
        ;;
    *)
        echo "未知指令. 可选命令: install | uninstall"
        exit 1
        ;;
esac

#!/bin/bash
# 模拟数据发送脚本
# 用于测试 CF-Server-Monitor 工作原理
# bash test/mock-sender.sh 550e8400-e29b-41d4-a716-446655440001 123456 http://localhost:8787/update 10 1.3.0 2
# 第6个参数为GPU数量，默认1
# curl -k -i -X POST 'https://localhost:8787/update' \
#   -H 'Content-Type: application/json' \
#   -H 'X-Agent-Version: 1.3.0' \
#   -d '{"id":"550e8400-e29b-41d4-a716-446655440001","secret":"123456","metrics":{"cpu":"45.5","gpu_info":[{"name":"Mock GPU","info":60.5,"id":"0"}],"ram_total":"16","ram_used":"8","disk_total":"256","disk_used":"128","load_avg":"1.50 1.20 0.80","boot_time":"1700000000000","net_rx":"1000000000","net_tx":"500000000","net_rx_monthly":"5000000000","net_tx_monthly":"2000000000","net_in_speed":"10000000","net_out_speed":"5000000","os":"Ubuntu 22.04","arch":"x86_64","cpu_info":"Intel Core i7-12700K","cpu_cores":"8","processes":"256","tcp_conn":"128","udp_conn":"32","ip_v4":"203.0.113.10","ip_v6":"0","ping_ct":"35","ping_cu":"45","ping_cm":"55","ping_bd":"75","loss_ct":"0","loss_cu":"1","loss_cm":"2","loss_bd":"3"}}'

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;36m'
NC='\033[0m'

info() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
step() { echo -e "${BLUE}[→]${NC} $1"; }

SERVER_ID="${1:-550e8400-e29b-41d4-a716-446655440001}"
SECRET="${2:-123456}"
WORKER_URL="${3:-https://localhost:8787/update}"
REPORT_INTERVAL="${4:-10}"
AGENT_VERSION="${5:-1.3.0}"
GPU_COUNT="${6:-1}"

generate_random() {
    awk -v min="$1" -v max="$2" 'BEGIN{srand(); printf "%.2f", min + rand() * (max - min)}'
}

generate_int() {
    awk -v min="$1" -v max="$2" 'BEGIN{srand(); printf "%d", int(min + rand() * (max - min + 1))}'
}

escape_json() {
    local val="${1:-}"
    val="${val//\\/\\\\}"
    val="${val//\"/\\\"}"
    val="${val//$'\n'/ }"
    val="${val//$'\r'/}"
    printf '%s' "$val"
}

echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       CF-Server-Monitor Mock Data Sender         ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""
info "服务器ID: $SERVER_ID"
info "上报地址: $WORKER_URL"
info "上报间隔: ${REPORT_INTERVAL}秒"
info "Agent版本: ${AGENT_VERSION}"
info "GPU数量: ${GPU_COUNT}"
echo ""

RX_PREV=$(generate_int 0 100000000)
TX_PREV=$(generate_int 0 100000000)
PREV_LOOP_TIME=$(date +%s)

while true; do
    LOOP_START_TIME=$(date +%s)
    
    CPU=$(generate_random 5 85)
    RAM=$(generate_random 20 80)
    RAM_TOTAL=$(generate_int 8 64)
    RAM_USED=$(awk -v total="$RAM_TOTAL" -v pct="$RAM" 'BEGIN{printf "%d", total * pct / 100}')
    SWAP_TOTAL=$(generate_int 0 32)
    SWAP_USED=$(generate_int 0 5)
    DISK=$(generate_random 30 75)
    DISK_TOTAL=$(generate_int 100 500)
    DISK_USED=$(awk -v total="$DISK_TOTAL" -v pct="$DISK" 'BEGIN{printf "%d", total * pct / 100}')
    
    LOAD_AVG=$(echo "$(generate_random 0.1 2.0) $(generate_random 0.1 1.8) $(generate_random 0.1 1.5)")
    
    BOOT_TIME=$(($(date +%s) - $(generate_int 3600 86400)))000
    
    OS="Ubuntu 22.04 LTS"
    ARCH="x86_64"
    CPU_INFO="Intel Core i7-12700K"
    GPU_INFO_BASE="NVIDIA GeForce RTX 4090"
    CPU_CORES="8"
    PROCESSES=$(generate_int 200 400)
    TCP_CONN=$(generate_int 50 200)
    UDP_CONN=$(generate_int 5 50)
    
    TIME_DELTA=$((LOOP_START_TIME - PREV_LOOP_TIME))
    [ "${TIME_DELTA}" -le 0 ] && TIME_DELTA=${REPORT_INTERVAL}
    
    RX_NOW=$((RX_PREV + $(generate_int 1000000 50000000)))
    TX_NOW=$((TX_PREV + $(generate_int 100000 5000000)))
    
    RX_DELTA=$((RX_NOW - RX_PREV))
    TX_DELTA=$((TX_NOW - TX_PREV))
    [ "${RX_DELTA}" -lt 0 ] && RX_DELTA=0
    [ "${TX_DELTA}" -lt 0 ] && TX_DELTA=0
    
    RX_SPEED=$((RX_DELTA / TIME_DELTA))
    TX_SPEED=$((TX_DELTA / TIME_DELTA))
    
    RX_PREV=${RX_NOW}
    TX_PREV=${TX_NOW}
    PREV_LOOP_TIME=${LOOP_START_TIME}
    
    if [ "$(generate_int 0 1)" -eq 1 ]; then
        IPV4="203.0.113.$(generate_int 2 254)"
    else
        IPV4="0"
    fi
    if [ "$(generate_int 0 1)" -eq 1 ]; then
        IPV6_SUFFIX=$(generate_int 2 4095)
        IPV6=$(printf "2001:db8::%x" "$IPV6_SUFFIX")
    else
        IPV6="0"
    fi
    PING_CT=$(generate_int 10 150)
    PING_CU=$(generate_int 20 200)
    PING_CM=$(generate_int 30 250)
    PING_BD=$(generate_int 50 300)
    LOSS_CT=$(generate_int 0 8)
    LOSS_CU=$(generate_int 0 12)
    LOSS_CM=$(generate_int 0 10)
    LOSS_BD=$(generate_int 0 15)
    
    NET_RX_MONTHLY=$(generate_int 100000000 1500000000)
    NET_TX_MONTHLY=$(generate_int 150000000 750000000)
    
    EOS=$(escape_json "${OS}")
    EARCH=$(escape_json "${ARCH}")
    ECPU=$(escape_json "${CPU_INFO}")

    # 生成多卡GPU信息数组
    GPU_INFO_ARRAY=""
    GPU_UTIL_LOG=""
    for ((g=0; g<GPU_COUNT; g++)); do
        GUTIL=$(awk -v min=0 -v max=95 -v seed="$((g + 1 + LOOP_START_TIME))" 'BEGIN{srand(seed); printf "%.2f", min + rand() * (max - min)}')
        GNAME="${GPU_INFO_BASE}"
        [ "${GPU_COUNT}" -gt 1 ] && GNAME="${GPU_INFO_BASE} #${g}"
        EGNAME=$(escape_json "${GNAME}")
        GPU_ENTRY="{\"name\":\"${EGNAME}\",\"info\":${GUTIL},\"id\":\"${g}\"}"
        if [ -n "${GPU_INFO_ARRAY}" ]; then
            GPU_INFO_ARRAY="${GPU_INFO_ARRAY},${GPU_ENTRY}"
        else
            GPU_INFO_ARRAY="${GPU_ENTRY}"
        fi
        [ -n "${GPU_UTIL_LOG}" ] && GPU_UTIL_LOG="${GPU_UTIL_LOG} "
        GPU_UTIL_LOG="${GPU_UTIL_LOG}${GUTIL}%"
    done

    PAYLOAD=$(cat <<EOF
{"id":"$SERVER_ID","secret":"$SECRET","metrics":{"cpu":"$CPU","gpu_info":[${GPU_INFO_ARRAY}],"ram":"$RAM","ram_total":"$RAM_TOTAL","ram_used":"$RAM_USED","swap_total":"$SWAP_TOTAL","swap_used":"$SWAP_USED","disk":"$DISK","disk_total":"$DISK_TOTAL","disk_used":"$DISK_USED","load_avg":"$LOAD_AVG","boot_time":"$BOOT_TIME","net_rx":"$RX_NOW","net_tx":"$TX_NOW","net_rx_monthly":"$NET_RX_MONTHLY","net_tx_monthly":"$NET_TX_MONTHLY","net_in_speed":"$RX_SPEED","net_out_speed":"$TX_SPEED","os":"$EOS","arch":"$EARCH","cpu_info":"$ECPU","cpu_cores":"$CPU_CORES","processes":"$PROCESSES","tcp_conn":"$TCP_CONN","udp_conn":"$UDP_CONN","ip_v4":"$IPV4","ip_v6":"$IPV6","ping_ct":"$PING_CT","ping_cu":"$PING_CU","ping_cm":"$PING_CM","ping_bd":"$PING_BD","loss_ct":"$LOSS_CT","loss_cu":"$LOSS_CU","loss_cm":"$LOSS_CM","loss_bd":"$LOSS_BD"}}
EOF
)
    
    RESPONSE=$(curl -s -k -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "X-Agent-Version: ${AGENT_VERSION}" -d "$PAYLOAD" -m 5 --connect-timeout 2 "$WORKER_URL" 2>/dev/null || echo "000")
    
    if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "201" ]; then
        info "[$(date '+%Y-%m-%d %H:%M:%S')] 数据上报成功 - CPU: ${CPU}% | GPU: [${GPU_UTIL_LOG}] | Loss CT: ${LOSS_CT}% | RAM: ${RAM}% | Disk: ${DISK}%"
    else
        warn "[$(date '+%Y-%m-%d %H:%M:%S')] 数据上报失败 (HTTP: $RESPONSE)"
    fi
    
    LOOP_END_TIME=$(date +%s)
    EXEC_DURATION=$((LOOP_END_TIME - LOOP_START_TIME))
    SLEEP_TIME=$((REPORT_INTERVAL - EXEC_DURATION))
    [ "${SLEEP_TIME}" -le 0 ] && SLEEP_TIME=1
    
    sleep "${SLEEP_TIME}"
done

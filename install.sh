#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  ProbeDeck · 探针台 一键安装脚本
#
#  用法：
#    curl -fsSL https://github.com/gg949/ProbeDeck/releases/latest/download/install.sh | bash
#
#  可选环境变量：
#    PORT=17986                 面板端口（默认 17986）
#    DATA_DIR=/opt/probedeck/data   数据目录（默认 /opt/probedeck/data）
# ═══════════════════════════════════════════════════════════════
set -e

IMAGE="ghcr.io/gg949/probedeck:latest"
PORT="${PORT:-17986}"
DATA_DIR="${DATA_DIR:-/opt/probedeck/data}"

echo ""
echo "════════ ProbeDeck · 探针台 一键安装 ════════"
echo ""

# ① 检查 root 权限
if [ "$(id -u)" != "0" ]; then
  echo "❌ 需要 root 权限运行：sudo bash install.sh"
  echo "   （或：curl -fsSL ... | sudo bash）"
  exit 1
fi

# ② 安装 Docker（如未安装）
if ! command -v docker >/dev/null 2>&1; then
  echo "→ 未检测到 Docker，正在安装..."
  curl -fsSL https://get.docker.com | bash
  systemctl enable --now docker 2>/dev/null || true
  echo "→ Docker 安装完成"
else
  echo "→ Docker 已安装（$(docker --version | cut -d' ' -f3 | tr -d ',')）"
fi

# ③ 拉取镜像
echo "→ 拉取 ProbeDeck 镜像..."
docker pull "$IMAGE"

# ④ 启动容器（重复执行 = 升级，数据保留）
echo "→ 启动容器（端口 $PORT，数据目录 $DATA_DIR）..."
docker rm -f probedeck >/dev/null 2>&1 || true
docker run -d --name probedeck --restart unless-stopped \
  -p "${PORT}:17986" \
  -v "${DATA_DIR}:/app/data" \
  "$IMAGE" >/dev/null

# ⑤ 等待启动 + 显示访问信息
sleep 3
# 优先取 IPv4 地址（IPv6 需要方括号才能拼 URL，仅作兜底）
IP=$(curl -4 -s -m 5 ifconfig.me 2>/dev/null | grep -E '^[0-9.]+$' || true)
if [ -z "$IP" ]; then
  IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
fi
echo ""
echo "════════ ✅ 安装完成 ════════"
echo ""
echo "  面板地址 : http://${IP:-<服务器IP>}:${PORT}"
echo "  管理面板 : http://${IP:-<服务器IP>}:${PORT}/#/admin"
if [ -f "${DATA_DIR}/api_secret.txt" ]; then
  echo "  初始密码 : $(cat "${DATA_DIR}/api_secret.txt")"
else
  echo "  初始密码 : docker logs probedeck 2>&1 | grep API_SECRET"
fi
echo ""
echo "  查看日志 : docker logs -f probedeck"
echo "  升级版本 : 重新执行本脚本即可（数据保留）"
echo "  卸载     : docker rm -f probedeck && rm -rf $(dirname "$DATA_DIR")"
echo ""

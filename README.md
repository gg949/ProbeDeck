# ProbeDeck · 探针台

**ProbeDeck** 是 [CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的 **Docker / VPS 移植版**。

原版运行在 Cloudflare Workers + D1 + Durable Objects 上；本移植版把整个后端搬进一个
**Node.js 单进程**（better-sqlite3 + ws），**前端、REST API、探针脚本与原版完全一致**，
被控端探针无需任何改动。

> 适配层原理：`server/` 目录在 Node 里模拟了 Workers 的运行时环境
> （D1→SQLite、Durable Objects→单进程实例、Cron→定时器、Workers Assets→静态文件），
> `src/` 业务代码保持原样，方便跟随上游更新。

## 功能

与原版一致：实时监控、WebSocket 秒级推送、历史数据与图表、离线告警、到期通知、
三网延迟/丢包、地图展示、主题商店（7+ 第三方主题）、深色模式、中英文、探针自动更新、数据备份导入导出等。

本移植版特有的：

- **开箱即用**：不设任何环境变量即可启动——`API_SECRET` 首次启动自动生成并打印在日志里
- **地区自动识别**：内置 MaxMind GeoLite2 数据库自动识别探针所在国家（可切换 ipinfo.io）
- 单容器部署，一条命令跑起来；数据落本地 SQLite，备份 = 复制 `data/` 目录
- 同一套探针脚本，支持 Linux / Alpine / OpenWrt / macOS / 群晖 / fnOS / Windows

## 快速开始

### 第 0 步：安装 Docker（已装可跳过）

```bash
curl -fsSL https://get.docker.com | bash
```

> Docker 官方一键安装脚本，支持 Ubuntu / Debian / CentOS / Rocky 等主流系统。
> 装好后执行 `docker --version` 验证；国内服务器拉取镜像慢的话，可自行配置镜像加速器。

### 方式一：docker compose 部署（推荐）

**1. 新建 `docker-compose.yml`**，把下面内容整段复制进去（不用下载任何其他文件）：

```yaml
services:
  probedeck:
    image: ghcr.io/gg949/probedeck:latest
    container_name: probedeck
    restart: unless-stopped
    ports:
      # 左侧是宿主机端口（对外访问用），默认 17986。
      # 换端口：把左边的 17986 改成你想要的数字即可，
      # 或在启动时用环境变量：HOST_PORT=你的端口 docker compose up -d
      - "${HOST_PORT:-17986}:17986"
    environment:
      # API_SECRET 可不设置：首次启动自动生成（写入 data/api_secret.txt 并打印在日志里），
      # 如需自定义（比如从旧部署迁移探针）再取消下面这行的注释并填写。
      # API_SECRET: "改成你自己的密钥"

      # 地区自动识别：maxmind（默认，本地 GeoLite2 数据库）/ ipinfo（在线）/ off（关闭）
      GEOIP_PROVIDER: "maxmind"
    volumes:
      # SQLite 数据库、运行数据与自动下载的 GeoIP 库（备份/迁移只需保留该目录）
      - ./data:/app/data
```

**2. 启动：**

```bash
docker compose up -d
```

**3. 以后升级版本：**

```bash
docker compose pull && docker compose up -d
```

### 方式二：一行命令（docker run）

```bash
docker run -d --name probedeck --restart unless-stopped -p 17986:17986 -v ./data:/app/data ghcr.io/gg949/probedeck:latest
```

> `17986:17986` 左边是宿主机端口，换端口改左边的数字即可；
> `./data:/app/data` 是数据目录，在你希望存放数据的位置执行即可（会自动创建 `data` 文件夹）。

### 启动后访问

- 监控面板：`http://你的服务器IP:端口/`（默认 17986，改过端口就用你自己的）
- 管理面板：`http://你的服务器IP:端口/admin`
  - 用户名：`admin`
  - 初始密码：**首次启动时自动生成**，执行这行查看：
    ```bash
    docker compose logs | grep API_SECRET
    ```
  - （密码同时保存在 `data/api_secret.txt`，登录后可在设置里修改）

> 想自定义密钥（比如从旧部署迁移探针）？在 `docker-compose.yml` 里设置 `API_SECRET` 即可，优先级高于自动生成。

### 想从源码构建？（可选）

镜像已由本仓库通过 GitHub Actions 自动构建发布到 `ghcr.io/gg949/probedeck`，**普通部署不需要源码**。想自己构建或用最新未发布的代码：

```bash
git clone https://github.com/gg949/ProbeDeck.git && cd ProbeDeck
docker compose -f docker-compose.build.yml up -d --build
```

### 添加探针（与原版完全一致）

1. 进入管理面板 → 服务器 → 添加服务器
2. 点击该服务器的「安装命令」，复制生成的命令
3. 到被控机器上以 root 执行即可

> 安装命令里的地址取自你访问面板时的地址。建议先配好 HTTPS 反代（见下节）再用域名访问，
> 探针就会通过 HTTPS 上报；直接用 `http://IP:17986` 也可以，但密钥会明文传输。

## 反向代理教程

### 方案一：Cloudflare 隧道（无需公网 IP、无需开端口、自带 HTTPS）

**① 先在 Cloudflare Zero Trust 控制台创建隧道**（Networks → Tunnels → Create a tunnel）：
创建过程中把 **Public Hostname** 填成 `你的域名` → `http://localhost:17986`，最后复制页面生成的 **token**（`ey` 开头的一长串）。

**② 在服务器复制执行这一行**（把 `<token>` 换成你复制的那串）：

```bash
cloudflared service install <token>
```

完成——访问你的域名即可，HTTPS 证书与 WebSocket 全自动。

<details>
<summary>cloudflared 尚未安装？点此处展开（安装后再执行上面那行）</summary>

```bash
curl -L -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared
```

ARM 服务器把 `amd64` 换成 `arm64`。Debian/Ubuntu 也可用官方 apt 源安装。
</details>

### 方案二：Caddy（自动申请证书，一行搞定）

```bash
caddy reverse-proxy --from monitor.example.com --to 127.0.0.1:17986
```

或写入 Caddyfile（推荐持久化）：

```
monitor.example.com {
    reverse_proxy 127.0.0.1:17986
}
```

Caddy 会自动申请并续期 HTTPS 证书，WebSocket 自动透传，无需额外配置。

> ⚠️ 示例里的 `monitor.example.com` 要**换成你自己的域名**再执行。

### 方案三：Nginx（一行式 server 配置）

```nginx
server { listen 80; server_name monitor.example.com; location / { proxy_pass http://127.0.0.1:17986; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }
```

> ⚠️ 示例里的 `monitor.example.com` 要**换成你自己的域名**。
> 写入 `/etc/nginx/conf.d/monitor.conf` 后 `nginx -s reload`。
> 需要 HTTPS 可配合 `certbot --nginx` 一键签发证书。
> 注意保留 `Upgrade` / `Connection` / `X-Forwarded-*` 这几行——WebSocket 和客户端 IP 识别都依赖它们。

## 地区自动识别（GeoIP）

原版在 Cloudflare 上能自动识别探针位置（显示国家/国旗）。本移植版用同样的机制复刻：

| 模式 | 说明 | 启用方式 |
| --- | --- | --- |
| **maxmind**（默认） | 本地 GeoLite2-Country 数据库离线查询 | 默认启用，镜像内置数据库，无需联网 |
| ipinfo | ipinfo.io 在线查询（探针 IP 固定，实际请求量极小） | `GEOIP_PROVIDER=ipinfo`（可配 `IPINFO_TOKEN` 提高额度） |
| off | 关闭，地区留空（可在管理面板手动设置） | `GEOIP_PROVIDER=off` |

**自定义 IP 数据库**：把任意 GeoLite2 格式的 `.mmdb` 文件挂载进容器，然后两种方式任选——

- 放到 `./data/geoip/GeoLite2-Country.mmdb`（推荐，自动识别）
- 或设置 `GEOIP_MMDB_PATH=/app/data/geoip/你的文件.mmdb`

数据库文件查找顺序：`GEOIP_MMDB_PATH` → `data/geoip/GeoLite2-Country.mmdb` → 镜像内置；
都找不到时自动从公共镜像源下载（失败则地区功能降级，不影响其他功能）。

> 数据来源：GeoLite2 数据由 [MaxMind](https://www.maxmind.com) 提供（CC BY-SA 4.0），
> 公共镜像源为 P3TERX/GeoLite.mmdb。

**不影响主题**：地区识别的结果写入标准的 `region` 字段（与 CF 版完全相同的字段），
前端和第三方主题读取方式不变，无需任何适配。

## 环境变量

全部可选——不配置任何变量即可启动。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `API_SECRET` | 探针上报密钥 + 管理面板初始密码。不设置则首次启动自动生成 | 自动生成 |
| `PORT` | 容器内监听端口 | `17986` |
| `API_USER_NAME` | 管理面板用户名 | `admin` |
| `GEOIP_PROVIDER` | 地区识别：`maxmind` / `ipinfo` / `off` | `maxmind` |
| `GEOIP_MMDB_PATH` | 自定义 GeoLite2 数据库路径 | 空 |
| `IPINFO_TOKEN` | ipinfo.io token（可选） | 空 |
| `CORS_ALLOWED_ORIGINS` | 允许跨域的来源，逗号分隔（一般同域部署不需要） | 空 |
| `DEBUG` | 设为 `1` 输出调试日志 | 空 |
| `DATA_DIR` | 数据目录 | `/app/data` |

## 数据与备份

| 文件 | 说明 |
| --- | --- |
| `data/monitor.db` | 主数据库（SQLite：服务器、历史、设置） |
| `data/api_secret.txt` | 自动生成的密钥 |
| `data/geoip/` | 自动下载的 GeoIP 数据库（如使用） |
| `data/do-storage.json` | 实时广播模块的少量运行状态 |

备份：停止容器后复制整个 `data/` 目录；恢复：放回后启动。
历史数据与原版一致：**每周一轮表，只保留约两周**，数据库体积很小。

## 从源码直接运行（不用 Docker）

```bash
npm install
npm run build:frontend
npm start          # 默认 17986 端口；API_SECRET 同样会自动生成
```

要求 Node.js 20+（推荐 22/24）。

## 与 Cloudflare 原版的差异

| 项 | 说明 |
| --- | --- |
| 地区识别 | 已用 GeoIP 复刻（见上节），行为与原版基本一致 |
| CF 用量统计 | 管理面板中的 Cloudflare 额度查询卡片已移除（VPS 部署无此概念） |
| Turnstile 人机验证 | CF 服务，默认关闭（建议保持关闭）；如需启用需服务器能访问 challenges.cloudflare.com |
| 版本更新提示 | 面板里的"检查新版"提示的是原项目版本号，仅作参考；升级执行 `docker compose pull && docker compose up -d` |
| 其他 | 定时任务按 UTC（与原版一致）、每周表轮换、离线检测、通知渠道逻辑 100% 保留 |

## 更新上游

本移植版相对上游只新增了 `server/`（适配层）与 Docker 相关文件，`src/`、`public/`、
`scripts/` 与上游保持一致。同步上游更新时，覆盖这几个目录后推送到本仓库即可——
GitHub Actions 会自动重新构建并发布新镜像；本地从源码构建则执行：

```bash
docker compose -f docker-compose.build.yml up -d --build
```

## 卸载

### 卸载被控端（探针）

在被控机（root）上执行，把地址换成你的面板地址：

```bash
curl -fsSL 'http://你的面板地址/uninstall.sh' | sudo sh -s
```

- 脚本会先询问确认；跳过询问直接卸载：把结尾换成 `| sudo sh -s -- -y`
- 执行后会停止服务并删除探针脚本、配置、流量统计和日志
- 支持 systemd / OpenRC / OpenWrt / 群晖 DSM / macOS；Windows 被控机使用 `uninstall.ps1`
- 也可以在管理面板里「删除服务器」——弹窗中会给出对应的卸载命令，复制执行一样有效

### 卸载主控端（部署 ProbeDeck 的服务器）

```bash
# ① 停止并删除容器
docker compose down      # compose 部署：在部署目录里执行
# 或
docker rm -f probedeck   # docker run 部署

# ②（可选）删除镜像
docker rmi ghcr.io/gg949/probedeck:latest

# ③（可选）删除数据/目录 —— ⚠️ 数据库与历史数据会一并删除，需保留请先备份 data/
#    compose 部署：删除整个部署目录（含 data/）
#    docker run 部署：删除你当时执行命令所在目录（里面的 data/）
```

## 常见问题

**Q：页面提示 "Frontend not available / 未构建前端"？**
运行 `npm run build:frontend`（Docker 构建时会自动执行）。

**Q：想换端口？**
- 部署时：把一行命令里 `HOST_PORT` 后面的数字改成你要的（或在 `docker-compose.yml` / `.env` 里设置 `HOST_PORT`）
- 部署后：改 `docker-compose.yml` 里 `ports` 的左侧数字，然后 `docker compose up -d` 重建容器
- 换完记得同步调整反代（隧道/Caddy/Nginx）的目标端口

**Q：探针一直显示离线？**
检查：被控机能访问上报地址（`curl 地址/api/config`）、防火墙放行、HTTPS 证书有效、
探针进程在运行（`systemctl status cf-probe`）。

**Q：地区都显示空白？**
查看启动日志中"地区识别"一行：若显示"已降级"说明数据库未就绪——联网后重启容器会自动下载，
或手动放置 `.mmdb` 到 `./data/geoip/`。

## 致谢与许可

- 原始项目：[huilang-me/CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor)（MIT）
- 原版说明文档保留在 `README-upstream.md`
- 本项目同样以 MIT 协议开源，见 [LICENSE](LICENSE)

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

**以后升级版本**（在当初部署的目录下执行）：

```bash
docker pull ghcr.io/gg949/probedeck:latest && docker stop probedeck && docker rm probedeck && docker run -d --name probedeck --restart unless-stopped -p 17986:17986 -v ./data:/app/data ghcr.io/gg949/probedeck:latest
```

> 数据都在宿主机 `data` 文件夹里，删容器不影响；但 **`./data` 是相对路径，必须回到当初部署的目录执行**，换目录会挂到新的空 data。
> 忘了当初在哪个目录？执行 `docker inspect probedeck --format '{{range .Mounts}}{{.Source}}{{end}}'` 查看数据目录的实际位置，父目录就是部署位置。

### 启动后访问

- 监控面板：`http://你的服务器IP:端口/`（默认 17986，改过端口就用你自己的）
- 管理面板：`http://你的服务器IP:端口/admin`
  - 用户名：`admin`
  - 初始密码：**首次启动时自动生成**，查看方式按你的部署方式选一种：
    ```bash
    # 用 docker compose（方式一）部署的：
    docker compose logs | grep API_SECRET

    # 用 docker run（方式二，一行命令）部署的：
    docker logs probedeck 2>&1 | grep API_SECRET
    ```
  - （密码同时保存在 `data/api_secret.txt`，登录后可在设置里修改）

> 想自定义密钥（比如从旧部署迁移探针）？
> - docker compose 部署：在 `docker-compose.yml` 里加 `API_SECRET: "你的密钥"`
> - docker run 部署：在命令里加 `-e API_SECRET=你的密钥`
>
> 优先级高于自动生成。

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

**尚未安装 Caddy？** Debian / Ubuntu 先执行（安装包自带开机自启）：

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

装完 Caddy 会自动启动并设为开机自启（不放心可执行一次 `sudo systemctl enable --now caddy` 确认）。

然后二选一：

**方式 A（临时试一下）**——前台运行，Ctrl+C 即停：

```bash
caddy reverse-proxy --from monitor.example.com --to 127.0.0.1:17986
```

**方式 B（推荐，持久化 + 自启）**——写入 Caddyfile 后重启服务：

```
monitor.example.com {
    reverse_proxy 127.0.0.1:17986
}
```

> 写入 `/etc/caddy/Caddyfile` 后执行 `sudo systemctl restart caddy`。

Caddy 会自动申请并续期 HTTPS 证书，WebSocket 自动透传，无需额外配置。

> ⚠️ 示例里的 `monitor.example.com` 要**换成你自己的域名**再执行。

### 方案三：Nginx（一行式 server 配置）

**尚未安装 Nginx？** 先安装（装完自动启动并开机自启）：

```bash
# Debian / Ubuntu
sudo apt install -y nginx
# CentOS / RHEL 系
sudo yum install -y nginx && sudo systemctl enable --now nginx
```

然后写入配置：

```nginx
server { listen 80; server_name monitor.example.com; location / { proxy_pass http://127.0.0.1:17986; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }
```

> ⚠️ 示例里的 `monitor.example.com` 要**换成你自己的域名**。
> 写入 `/etc/nginx/conf.d/monitor.conf` 后执行 `sudo nginx -t && sudo systemctl reload nginx`（先测语法再热加载）。
> 需要 HTTPS 可配合 `sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx` 一键签发证书。
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

## 上报间隔与实时性

- **HTTP 模式**（默认）：探针每隔一段时间上报一次；本移植版已解除原版的 Cloudflare 限制，最小可设 **10 秒**（管理面板 → 编辑服务器 → 上报间隔）。
- **WSS 模式**（准实时）：设置里开启「Agent WSS 上报」并勾选全部时段后，探针与面板保持 WebSocket 长连接，数据 **1~5 秒**推送一次（编辑服务器 → WSS 上报间隔）。原版因 Cloudflare 额度限制做了时段选择，VPS 部署无此限制，**24 小时全开即可**。

## 环境变量

全部可选——不配置任何变量即可启动。

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `API_SECRET` | 探针上报密钥 + 管理面板初始密码。不设置则首次启动自动生成 | 自动生成 |
| `PORT` | 容器内监听端口 | `17986` |
| `API_USER_NAME` | 管理面板用户名 | `admin` |
| `HISTORY_RETENTION_DAYS` | 历史数据保留天数（30 = 保留约一个月） | `14` |
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
历史数据保留时长**可自定义**：默认约两周（`HISTORY_RETENTION_DAYS=14`），改成 `30` 即保留约一个月；
内部按"轮换周期 = 保留天数的一半"自动清理旧数据，数据库体积保持很小。

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
| 版本更新提示 | 面板里的"检查新版"读取的是本仓库的 version.json（发新版时同步更新它即可提示最新版）；升级方法见「部署」章节中对应你部署方式（compose / docker run）的升级说明 |
| 其他 | 定时任务按 UTC（与原版一致）、周期表轮换（保留时长可自定义）、离线检测、通知渠道逻辑 100% 保留 |

## 从 Cloudflare 原版迁移数据

原版部署在 Cloudflare（Workers + D1）上，数据**可以完整迁移**到本移植版——
D1 本身就是 SQLite，表结构与本项目完全相同：服务器列表、历史数据、流量统计、
面板设置（含登录密码、通知配置、主题设置）会**全部保留**。

### 方式一（推荐）：面板一键迁移，零命令行

ProbeDeck 的「数据库管理」页面内置了「**从 Cloudflare 一键迁移**」：
填入三项信息即可自动把全部数据拉取过来：

- **Cloudflare 账号 ID**：CF 控制台首页右侧栏
- **D1 数据库 ID**：Workers 和 Pages → D1 → 选中你的数据库（UUID 格式）
- **API Token**：My Profile → API Tokens → 创建，权限选 **D1 → 读取** 即可

> 迁移会自动备份现有数据（失败自动还原），Token 仅单次使用、不会被保存。
> 原版面板会在导出期间短暂不可用（几十秒，正常现象）。

### 方式二：手动导出 / 导入（适合想全程自己掌控的用户）

**① 导出 D1 数据**——用**任意一台电脑**操作即可（数据都在 Cloudflare 云端，与你当初用哪台电脑部署的无关；
Windows / Mac / Linux 都行，只要登录你当初部署原版的 Cloudflare 账号）：

```bash
# 没装过 Node.js 的话，先去 https://nodejs.org 下载 LTS 版安装
# 然后打开终端（Windows 用 PowerShell），逐条执行：

npx wrangler login     # 会弹出浏览器，登录你的 Cloudflare 账号
npx wrangler d1 list   # 查看数据库名（原版默认叫 server-monitor-db）
npx wrangler d1 export server-monitor-db --remote --output=backup.sql
```

> 最后一条命令里的 `server-monitor-db` 换成 `d1 list` 里看到的实际数据库名；
> 执行成功后会在当前目录生成 `backup.sql`，把它传到 VPS 继续下一步。

**② 把 backup.sql 传到 VPS，导入到 ProbeDeck**：

```bash
# 安装 sqlite3 命令行工具（没装过的话）
sudo apt install -y sqlite3

# ① 停止面板容器（导入期间必须停止，避免文件锁）——先 cd 到部署目录，再按你的部署方式选一条：
cd 你的部署目录
docker compose down      # compose 部署
docker stop probedeck    # docker run（一行命令）部署

# ② 用导出文件建一个新库（当前库如果已有数据，先改名备份、别删）
mv data/monitor.db data/monitor.db.bak 2>/dev/null
sqlite3 data/monitor.db < backup.sql

# ③ 重新启动——按你的部署方式选一条：
docker compose up -d     # compose 部署
docker start probedeck   # docker run（一行命令）部署
```

**③ 完成**：打开面板，用**原来的密码登录**——改过密码的话原密码直接可用；
从未改过密码的，登录密码 = 你原 CF 版配置的 API_SECRET。

**探针（被控机）怎么处理？** 因为面板地址变了（CF 域名 → 你的新域名），
每台被控机需要更新上报地址——最省事的办法：管理面板里对每台服务器点「安装/更新」，
把生成的命令复制到对应机器上执行一遍即可（1 分钟一台）。**历史数据都在服务端，重装探针不丢数据**。

**想让探针保留原 API_SECRET？** 在 `docker-compose.yml` 里加一行
`API_SECRET: 你原来的密钥` 即可；不设置也没关系（面板自动生成新密钥，重装探针时自动带上）。

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

**① 停止并删除容器**（按你的部署方式选一条）：

```bash
# docker compose 部署的（在部署目录里执行）：
docker compose down

# docker run（一行命令）部署的：
docker stop probedeck && docker rm probedeck
```

**②（可选）删除镜像**：

```bash
docker rmi ghcr.io/gg949/probedeck:latest
```

**③（可选）删除数据**——⚠️ 面板设置、服务器记录、全部历史数据都在这个文件夹里，删了就没了；想保留就先把它整个拷贝走备份。

先找到 data 文件夹在哪：

```bash
# 推荐在删容器之前执行（输出就是 data 的完整路径，例如 /root/data）：
docker inspect probedeck --format '{{range .Mounts}}{{.Source}}{{end}}'

# 如果容器已经删了，用这条全盘搜也行：
find / -name "api_secret.txt" 2>/dev/null
```

找到后删除（把路径换成上面查到的，例如 `/root/data`）：

```bash
rm -rf /root/data
```

> 💡 数据只存在宿主机这一个 `data` 文件夹里（容器内部没有独立存储）。想卸载得干干净净 = ① 删容器 + ② 删镜像 + ③ 删 data 文件夹，三个都做即彻底清空。

## 常见问题

**Q：页面提示 "Frontend not available / 未构建前端"？**
运行 `npm run build:frontend`（Docker 构建时会自动执行）。

**Q：想换端口？**
- 部署时：**一行命令部署** → 把 `-p 17986:17986` 左侧的 17986 改成你要的端口；**compose 部署** → 改 `docker-compose.yml` 里 `${HOST_PORT:-17986}` 的默认值，或启动时执行 `HOST_PORT=你的端口 docker compose up -d`
- 部署后：**compose 部署** → 改 `docker-compose.yml` 里 `ports` 的左侧数字，然后 `docker compose up -d` 重建容器；**docker run 部署** → 用「方式二」的升级命令重新跑一遍，只把 `-p` 左侧数字换成新端口
- 换完记得同步调整反代（隧道/Caddy/Nginx）的目标端口

**Q：上传了自定义网站图标（favicon）但不生效？**
① 上传图片后要**点页面底部的「保存设置」**才真正保存；② 浏览器对 favicon 的缓存非常顽固——
用 `Ctrl+F5` 强制刷新、或换无痕窗口/换浏览器验证；手机端清一下浏览器缓存再看。

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

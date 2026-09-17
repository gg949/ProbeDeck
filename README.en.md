<div align="center">

# ProbeDeck

[![Release](https://img.shields.io/github/v/release/gg949/ProbeDeck?style=flat-square)](https://github.com/gg949/ProbeDeck/releases)
[![License](https://img.shields.io/github/license/gg949/ProbeDeck?style=flat-square)](LICENSE)
[![Docker Build](https://img.shields.io/github/actions/workflow/status/gg949/ProbeDeck/docker-publish.yml?style=flat-square&label=docker%20build)](https://github.com/gg949/ProbeDeck/actions)
[![Stars](https://img.shields.io/github/stars/gg949/ProbeDeck?style=flat-square)](https://github.com/gg949/ProbeDeck/stargazers)
[![ghcr.io](https://img.shields.io/badge/ghcr.io-gg949%2Fprobedeck-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/gg949/ProbeDeck/pkgs/container/probedeck)

**Bring your server-status panel into your own Docker** — single-container deploy · 100% local data · report interval down to 1 second · runs great on a 1C1G VPS

[🔗 Live Demo](https://probedeck.guoba.cc.cd/) · [🚀 Quick Start](#quick-start) · [🔄 Migrate from Cloudflare](#migrating-from-cloudflare) · [🎨 Theme Development](theme-develop.md) · [📖 API Reference](API.md)

**English | [中文](README.md)**

</div>

---

**ProbeDeck** is a **Docker / VPS port** of [CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor).

The original runs on Cloudflare Workers + D1 + Durable Objects. This port moves the whole backend into a single
**Node.js process** (better-sqlite3 + ws), keeping the **frontend, REST API, and probe scripts 100% compatible**
with the original — existing probe agents need no changes, and the theme ecosystem is fully interchangeable.

> How it works: the `server/` directory emulates the Workers runtime inside Node
> (D1→SQLite, Durable Objects→in-process instance, Cron→timers, Workers Assets→static files),
> while `src/` is kept as-is so upstream updates are easy to follow.

## 📸 Screenshots

**Live overview**

![Live overview](docs/screenshots/dashboard.png)

**Server detail & real-time charts**

![Server detail & real-time charts](docs/screenshots/server-detail.png)

**Theme Store (compatible with every original theme)**

![Theme Store](docs/screenshots/theme-store.png)

<details>
<summary>🖼️ More screenshots (server editor / system settings)</summary>

**Edit server (collect/report intervals, billing, probe nodes)**

![Edit server](docs/screenshots/edit-server.png)

**System settings (notification channels, WSS hours, security)**

![System settings](docs/screenshots/admin-settings.png)

</details>

## ✨ Features

- **🚀 One-command deploy** — everything runs in a single container; `API_SECRET` is auto-generated on first launch, zero config required
- **🪶 Featherweight** — panel uses ~50-75MB RAM, probe only ~8MB (CPU average <0.1%); runs happily on a 1C1G VPS
- **⚡ Second-level monitoring** — report interval down to **1 second**, near-real-time push over WSS; probes for Linux / Alpine / OpenWrt / macOS / Synology / fnOS / Windows
- **🔒 100% local data** — everything stays in a local SQLite database: no cloud dependency, no quotas; backup = copy one directory
- **🛡️ Secure by design** — probes only report outbound: no inbound port, no remote-command capability; even a compromised panel can never touch your monitored machines
- **🔔 Rich notification channels** — Telegram / WeCom / Feishu / DingTalk / Bark / ServerChan / WxPusher / Gotify / OneBot / custom Webhook
- **🧩 Notification boost** — per-event emoji for offline / recovery / expiration / resource-alert / traffic / test events, plus custom JavaScript notification scripts (the `sendMessage` / `sendEvent` contract) to reach any push service
- **🎨 Theme ecosystem** — compatible with every original CFSM theme (one-click install from the Theme Store); custom CSS / JS / background image supported
- **🔄 One-click Cloudflare migration** — the built-in "Migrate from Cloudflare" tool moves all your D1 data over intact (servers, history, settings, password)
- **🌍 Automatic region detection** — built-in MaxMind GeoLite2 offline database; country flags out of the box

> Everything else works exactly like the original: real-time monitoring, WebSocket push, historical charts,
> offline alerts, expiry & traffic notifications, latency/packet-loss checks against China's three major ISPs,
> map view, dark mode, Chinese/English UI, probe auto-update, data backup & import/export.

## Quick Start

### Step 0: Install Docker (skip if already installed)

```bash
curl -fsSL https://get.docker.com | bash
```

> Official Docker one-liner — supports Ubuntu / Debian / CentOS / Rocky, etc.
> Verify with `docker --version`. If image pulls are slow from your region, configure a registry mirror.

### Option 1: docker compose (recommended)

**1. Create `docker-compose.yml`** and paste the following (nothing else to download):

```yaml
services:
  probedeck:
    image: ghcr.io/gg949/probedeck:latest
    container_name: probedeck
    restart: unless-stopped
    ports:
      # Left side is the host port (the one you access). Default 17986.
      # To change it, edit the number on the left,
      # or pass it at startup: HOST_PORT=your-port docker compose up -d
      - "${HOST_PORT:-17986}:17986"
    environment:
      # API_SECRET is optional: auto-generated on first launch (written to data/api_secret.txt and printed in the log).
      # Set it only if you need a custom value (e.g. migrating probes from an old deployment).
      # API_SECRET: "your-custom-secret"

      # Region detection: maxmind (default, local GeoLite2 database) / ipinfo (online) / off
      GEOIP_PROVIDER: "maxmind"
    volumes:
      # Data directory: the project-owned /opt/probedeck/data (auto-created).
      # Keeping all data in one place makes upgrading/backup/uninstall easy;
      # change the left side if you want another location.
      - /opt/probedeck/data:/app/data
```

**2. Start:**

```bash
docker compose up -d
```

**3. Upgrade later:**

```bash
docker compose pull && docker compose up -d
```

### Option 2: One-liner (docker run)

```bash
docker run -d --name probedeck --restart unless-stopped -p 17986:17986 -v /opt/probedeck/data:/app/data ghcr.io/gg949/probedeck:latest
```

> `17986:17986` — the left number is the host port; change it to anything you like.
> `/opt/probedeck/data` is the **project-owned data directory** (auto-created) — keeping everything
> in one place means upgrades never mount the wrong path, backup is a single directory, and
> uninstalling is just deleting it. Prefer another location? Change the left side
> (e.g. `-v ./data:/app/data` to keep it in the current directory).

**Upgrade later** (works from any directory):

```bash
docker pull ghcr.io/gg949/probedeck:latest && docker stop probedeck && docker rm probedeck && docker run -d --name probedeck --restart unless-stopped -p 17986:17986 -v /opt/probedeck/data:/app/data ghcr.io/gg949/probedeck:latest
```

> All data lives in `/opt/probedeck/data`; removing the container never touches it. The mount uses an absolute path, so **it works no matter which directory you run from**.

### Access

- Dashboard: `http://YOUR_SERVER_IP:PORT/` (default port 17986)
- Admin panel: `http://YOUR_SERVER_IP:PORT/admin`
  - Username: `admin`
  - Initial password: **auto-generated on first launch**, stored in `api_secret.txt` in the data directory:
    ```bash
    # docker run deployment (Option 2):
    cat /opt/probedeck/data/api_secret.txt

    # docker compose deployment (Option 1, run from the compose directory):
    cat data/api_secret.txt

    # Or read it from inside the container (works for both):
    docker exec probedeck cat /app/data/api_secret.txt
    ```
  - (It is also printed once in the startup log. After you change the password in the panel, this file's value is only used for probe reporting, no longer as the login password.)

> Want a custom secret (e.g. migrating probes from an old deployment)?
> - docker compose: add `API_SECRET: "your-secret"` to `docker-compose.yml`
> - docker run: add `-e API_SECRET=your-secret` to the command
>
> It takes priority over auto-generation.

### Build from source? (optional)

The image is built and published to `ghcr.io/gg949/probedeck` automatically via GitHub Actions — **normal deployments don't need the source**. To build it yourself or run unreleased code:

```bash
git clone https://github.com/gg949/ProbeDeck.git && cd ProbeDeck
docker compose -f docker-compose.build.yml up -d --build
```

### Adding a probe (identical to the original)

1. Admin panel → Servers → Add Server
2. Click "Install command" for that server and copy the generated command
3. Run it as root on the machine you want to monitor

> The install command uses the address you're currently browsing the panel from. It's recommended to
> set up an HTTPS reverse proxy first (see below) and then use your domain, so probes report over HTTPS.
> Plain `http://IP:17986` also works, but the secret is transmitted in cleartext.

## Reverse Proxy

### Option A: Cloudflare Tunnel (no public IP, no open ports, free HTTPS)

**① Create a tunnel in the Cloudflare Zero Trust console** (Networks → Tunnels → Create a tunnel):
set the **Public Hostname** to your domain → `http://localhost:17986`, then copy the generated **token** (a long string starting with `ey`).

**② On your server, run this one line** (replace `<token>` with the value you copied):

```bash
cloudflared service install <token>
```

Done — visit your domain. HTTPS certificates and WebSockets are handled automatically.

<details>
<summary>cloudflared not installed yet? Expand to install, then run the command above</summary>

```bash
curl -L -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared
```

On ARM servers replace `amd64` with `arm64`. Debian/Ubuntu can also use the official apt repository.
</details>

### Option B: Caddy (automatic certificates, one line)

**Caddy not installed yet?** On Debian / Ubuntu:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Caddy starts automatically and is enabled on boot (verify with `sudo systemctl enable --now caddy` if unsure).

Then pick one:

**A (quick test)** — run in the foreground, Ctrl+C to stop:

```bash
caddy reverse-proxy --from monitor.example.com --to 127.0.0.1:17986
```

**B (recommended, persistent + auto-start)** — write a Caddyfile and restart the service:

```
monitor.example.com {
    reverse_proxy 127.0.0.1:17986
}
```

> Write it to `/etc/caddy/Caddyfile`, then `sudo systemctl restart caddy`.

Caddy obtains and renews HTTPS certificates automatically and forwards WebSockets without extra config.

> ⚠️ Replace `monitor.example.com` with **your own domain** before running.

### Option C: Nginx (one-line server block)

**Nginx not installed yet?**

```bash
# Debian / Ubuntu
sudo apt install -y nginx
# CentOS / RHEL
sudo yum install -y nginx && sudo systemctl enable --now nginx
```

Then write the config:

```nginx
server { listen 80; server_name monitor.example.com; location / { proxy_pass http://127.0.0.1:17986; proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; } }
```

> ⚠️ Replace `monitor.example.com` with **your own domain**.
> Save to `/etc/nginx/conf.d/monitor.conf`, then `sudo nginx -t && sudo systemctl reload nginx`.
> For HTTPS: `sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx`.
> Keep the `Upgrade` / `Connection` / `X-Forwarded-*` lines — WebSockets and client-IP detection depend on them.

## Region Detection (GeoIP)

The original detects probe locations on Cloudflare (country / flag). This port replicates the same behavior:

| Mode | Description | How to enable |
| --- | --- | --- |
| **maxmind** (default) | Local GeoLite2-Country database, offline lookups | On by default; database bundled in the image, no network needed |
| ipinfo | Online lookups via ipinfo.io (probe IPs are fixed, so request volume is tiny) | `GEOIP_PROVIDER=ipinfo` (optionally `IPINFO_TOKEN` for higher quota) |
| off | Disabled — region left empty (can be set manually in the panel) | `GEOIP_PROVIDER=off` |

**Custom IP database**: mount any GeoLite2-format `.mmdb` file into the container, then either —

- place it at `/opt/probedeck/data/geoip/GeoLite2-Country.mmdb` (recommended, auto-detected)
- or set `GEOIP_MMDB_PATH=/app/data/geoip/your-file.mmdb`

Lookup order: `GEOIP_MMDB_PATH` → `data/geoip/GeoLite2-Country.mmdb` → image-bundled database;
if none is found the app downloads one from a public mirror (if that also fails, the region feature
degrades gracefully — nothing else is affected).

> Data source: GeoLite2 data by [MaxMind](https://www.maxmind.com) (CC BY-SA 4.0).
> Public mirror: P3TERX/GeoLite.mmdb.

**Theme-friendly**: results are written to the standard `region` field (identical to the CF version),
so the frontend and third-party themes read it the same way — no adaptation needed.

## Report Interval & Real-time Behavior

- **HTTP mode** (default): the probe reports at a fixed interval. This port removes the original Cloudflare limits — the minimum is **1 second** (Admin panel → Edit server → report interval; choices: 1 / 3 / 5 / 10 / 15 / 20 / 30 / 60 / 120 / 180 seconds).
- **WSS mode** (near-real-time): enable "Agent WSS reporting" with all hours selected, and the probe keeps a WebSocket connection open, pushing data as fast as **1 second** (Edit server → WSS report interval). The original limited hours due to Cloudflare quotas; on your own VPS just enable **all 24 hours**.

## Environment Variables

All optional — the app starts with zero configuration.

| Variable | Description | Default |
| --- | --- | --- |
| `API_SECRET` | Probe reporting secret + initial admin password. Auto-generated on first launch if unset | auto-generated |
| `PORT` | Listening port inside the container | `17986` |
| `API_USER_NAME` | Admin panel username | `admin` |
| `HISTORY_RETENTION_DAYS` | History retention in days (also settable in the panel; panel wins) | `14` |
| `GEOIP_PROVIDER` | Region detection: `maxmind` / `ipinfo` / `off` | `maxmind` |
| `GEOIP_MMDB_PATH` | Path to a custom GeoLite2 database | empty |
| `IPINFO_TOKEN` | ipinfo.io token (optional) | empty |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins (not needed for same-domain deployments) | empty |
| `DEBUG` | Set to `1` for debug logs | empty |
| `DATA_DIR` | Data directory | `/app/data` |

## Data & Backup

| File | Description |
| --- | --- |
| `/opt/probedeck/data/monitor.db` | Main database (SQLite: servers, history, settings) |
| `/opt/probedeck/data/api_secret.txt` | Auto-generated secret |
| `/opt/probedeck/data/geoip/` | Auto-downloaded GeoIP database (if used) |
| `/opt/probedeck/data/do-storage.json` | Small runtime state of the real-time broadcast module |

Backup: stop the container and copy the whole `/opt/probedeck/data/` directory; restore: put it back and start.
History retention is **configurable** (two ways; the panel setting wins):
1. **Panel setting (recommended)**: Admin → Settings → Display options → "History retention days" — 7 / 14 / 30 / 60 / 90 / 180 / 365 days ("auto" uses the default of 14);
2. Env var `HISTORY_RETENTION_DAYS=30` (handy for batch deployments; used when the panel is set to "auto").
Internally it rotates tables every "retention ÷ 2" days, so the database stays small.
Guests (not logged in) can view the last **24 hours** of history by default; widen it in Admin → Settings → Display options → "Public history range" (1 / 2 / 4 / 7 / 14 / 30 days). Logged-in admins are never limited by this setting.

## Run from Source (without Docker)

```bash
npm install
npm run build:frontend
npm start          # defaults to port 17986; API_SECRET is auto-generated too
```

Requires Node.js 20+ (22/24 recommended).

## Differences from the Cloudflare Version

| Item | Notes |
| --- | --- |
| Region detection | Replicated with GeoIP (see above); behavior matches the original |
| CF usage stats | The Cloudflare quota card in the admin panel was removed (not applicable on a VPS) |
| Turnstile | A Cloudflare service, off by default (recommended); enabling it requires the server to reach challenges.cloudflare.com |
| Update check | "Check for updates" reads version.json from this repo (bump it when releasing to notify users); see the upgrade instructions for your deployment method (compose / docker run) |
| Others | Cron timing follows UTC (same as original), table-rotation cleanup (retention configurable), offline detection and notification logic — 100% kept |

## Migrating from Cloudflare

Your original deployment (Workers + D1) can be **fully migrated** — D1 is SQLite, and the table
schema is identical: servers, history, traffic stats and panel settings (including login password,
notification config, theme settings) are **all preserved**.

### Method 1 (recommended): built-in one-click migration, zero command line

The "Database" page in ProbeDeck includes a **"Migrate from Cloudflare"** tool — fill in three values and everything is pulled over automatically:

- **Cloudflare Account ID**: right sidebar of the CF dashboard home
- **D1 Database ID**: Workers & Pages → D1 → your database (UUID format)
- **API Token**: My Profile → API Tokens → Create, with **D1 → Read** permission

> The migration backs up your current data first (auto-restores on failure); the token is used once and never stored.
> The original panel is briefly unavailable during export (a few dozen seconds — normal).

### Method 2: manual export / import (for those who want full control)

**① Export D1 data** — you can do this **from any computer** (the data lives in Cloudflare's cloud, unrelated to where you originally deployed; Windows / Mac / Linux all work — just log into the same Cloudflare account):

```bash
# Install Node.js LTS from https://nodejs.org if you don't have it,
# open a terminal (PowerShell on Windows), then run:

npx wrangler login     # opens a browser to log into your Cloudflare account
npx wrangler d1 list   # find your database name (the original default is server-monitor-db)
npx wrangler d1 export server-monitor-db --remote --output=backup.sql
```

> Replace `server-monitor-db` in the last command with the actual name from `d1 list`;
> this creates `backup.sql` in the current directory — copy it to your VPS for the next step.

**② Copy backup.sql to the VPS and import into ProbeDeck**:

```bash
# Install the sqlite3 CLI if needed
sudo apt install -y sqlite3

# ① Stop the panel container (must be stopped during import to avoid file locks) — pick one:
docker compose down      # compose deployment (run in the compose directory)
docker stop probedeck    # docker run (one-liner) deployment

# ② Import into a fresh database (if the current one has data, rename it as a backup first — never delete)
mv /opt/probedeck/data/monitor.db /opt/probedeck/data/monitor.db.bak 2>/dev/null
sqlite3 /opt/probedeck/data/monitor.db < backup.sql

# ③ Start again — pick one:
docker compose up -d     # compose deployment
docker start probedeck   # docker run (one-liner) deployment
```

**③ Done**: open the panel and log in with your **original password** — a password you changed before
works as-is; if you never changed it, the login password equals your old CF deployment's API_SECRET.

**What about the probes (monitored machines)?** The panel address changed (CF domain → your new domain),
so each machine needs its reporting address updated — easiest path: in the admin panel, click "Install/Update"
for each server and run the generated command on the corresponding machine (about one minute per machine).
**History data lives server-side, so reinstalling a probe never loses data.**

**Want to keep the original API_SECRET?** Add `API_SECRET: your-original-secret` to `docker-compose.yml`;
unset is also fine (the panel generates a new one, and reinstalled probes pick it up automatically).

## Updating from Upstream

Relative to upstream, this port only adds `server/` (the adapter layer) and Docker-related files;
`src/`, `public/` and `scripts/` stay in sync with upstream. To sync upstream updates, overwrite those
directories and push — GitHub Actions rebuilds and publishes the image automatically. For local builds:

```bash
docker compose -f docker-compose.build.yml up -d --build
```

## Uninstall

### Probe (monitored machine)

On the monitored machine (as root), using your panel address:

```bash
curl -fsSL 'http://YOUR_PANEL_ADDRESS/uninstall.sh' | sudo sh -s
```

- The script asks for confirmation first; skip it with `| sudo sh -s -- -y`
- It stops the service and removes the probe, its config, traffic stats and logs
- Works on systemd / OpenRC / OpenWrt / Synology DSM / macOS; for Windows targets use `uninstall.ps1`
- Alternatively use "Delete server" in the panel — the dialog shows the matching uninstall command

### Panel (the machine running ProbeDeck)

**① Stop and remove the container** (pick one):

```bash
# docker compose deployment (run in the deployment directory):
docker compose down

# docker run (one-liner) deployment:
docker stop probedeck && docker rm probedeck
```

**② (Optional) Remove the image**:

```bash
docker rmi ghcr.io/gg949/probedeck:latest
```

**③ (Optional) Delete the data** — ⚠️ all panel settings, server records and history live in `/opt/probedeck/data`; once deleted they're gone. Copy a backup first if you want to keep them.

```bash
# All data sits in the project-owned directory — just delete it
rm -rf /opt/probedeck
```

> 💡 Data only lives in `/opt/probedeck/data` (no separate storage inside the container). A completely clean uninstall = ① remove container + ② remove image + ③ `rm -rf /opt/probedeck`.

## FAQ

**Q: "Frontend not available" on the page?**
Run `npm run build:frontend` (Docker builds do this automatically).

**Q: How do I change the port?**
- At deploy time: **one-liner** → change the left side of `-p 17986:17986`; **compose** → edit the default of `${HOST_PORT:-17986}` in `docker-compose.yml`, or run `HOST_PORT=your-port docker compose up -d`
- After deployment: **compose** → edit `ports` in `docker-compose.yml` and run `docker compose up -d`; **docker run** → re-run the upgrade command with a new `-p`
- Remember to update your reverse proxy target port too

**Q: I uploaded a custom favicon but it doesn't show?**
① Click "Save settings" at the bottom of the page — uploading alone doesn't save; ② browsers cache favicons aggressively — hard-refresh (`Ctrl+F5`), try a private window or another browser; on mobile, clear the browser cache.

**Q: The probe keeps showing offline?**
Check: the machine can reach the reporting address (`curl <address>/api/config`), firewall allows it, HTTPS certificate is valid, and the probe process is running (`systemctl status cf-probe`).

**Q: All regions show empty?**
Check the "Region detection" line in the startup log: if it says "degraded", the database isn't ready —
restart the container with network access to auto-download it, or manually place a `.mmdb` file into `/opt/probedeck/data/geoip/`.

## Related Docs

- [Theme Development Guide](theme-develop.md): third-party theme spec — data APIs, WebSocket protocol, build artifacts, footer requirements and submission process
- [API Reference](API.md): complete REST / WebSocket API — auth, endpoints, data structures, error codes

> **Theme ecosystem**: ProbeDeck and the original CF-Server-Monitor themes are **fully interchangeable**.
> You can paste any theme link in the panel (no count limit), format `https://github.com/<author>/<repo>/tree/<branch>`;
> or install one-click from the Theme Store. Even if a theme link breaks, the site falls back to the built-in UI automatically.

## Credits & License

- Original project: [huilang-me/CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) (MIT)
- Original README preserved at `README-upstream.md`
- This project is also MIT licensed — see [LICENSE](LICENSE)

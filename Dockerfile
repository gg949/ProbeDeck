# syntax=docker/dockerfile:1

# ──────────────────────────────────────────────────────────────
# 构建阶段：安装依赖（含 better-sqlite3 编译）并构建前端
# ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:frontend \
 && npm prune --omit=dev

# 尝试内置 GeoLite2 国家数据库（下载失败不阻塞构建；运行时仍会自动重试下载）
RUN mkdir -p /app/geoip \
 && (curl -fsSL --retry 2 --connect-timeout 10 -o /app/geoip/GeoLite2-Country.mmdb \
      https://cdn.jsdelivr.net/gh/P3TERX/GeoLite.mmdb@download/GeoLite2-Country.mmdb \
     || curl -fsSL --retry 2 --connect-timeout 10 -o /app/geoip/GeoLite2-Country.mmdb \
      https://raw.githubusercontent.com/P3TERX/GeoLite.mmdb/download/GeoLite2-Country.mmdb \
     || echo "warn: GeoLite2 下载跳过，运行时/手动放置均可") \
 && ls -la /app/geoip/

# ──────────────────────────────────────────────────────────────
# 运行阶段：只保留运行所需文件（Node + 适配层 + 前端产物 + 数据库驱动）
# ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    PORT=17986 \
    DATA_DIR=/app/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/geoip ./geoip

# 容器入口：以 root 启动时先修正数据目录属主，再用 setpriv 降权到 node 用户运行（非 root）
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 17986

# 健康检查：访问 /api/config（返回任意非 5xx 均视为存活）
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||17986)+'/api/config').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]

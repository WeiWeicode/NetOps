# NetOps 後端映像檔(netops-api,port 51292;機密一律以 *_FILE 指向 Docker secret,不寫進映像檔)
#   docker build --secret id=npm_token,env=GITLAB_NPM_TOKEN backend
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# @giganexus/* 取自公司 GitLab npm Registry:Token 以 BuildKit secret(npm_token)傳入,不留在映像層
RUN --mount=type=secret,id=npm_token GITLAB_NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev
# 戰情室離線 GeoIP(WARROOM-PLAN Q2):DB-IP「IP to Country Lite」,CC BY 4.0(畫面須標示 IP Geolocation by DB-IP,連到 https://db-ip.com)。
# 只在建置時下載、執行時不連外;每月初發布新版,更新時改 DBIP_MONTH(或 --build-arg)重新建置。下載或雜湊不符 → 建置失敗(不靜默缺檔)
ARG DBIP_MONTH=2026-11
# 下載檔的 SHA-256(換月份時一併更新;在可連外的電腦下載後 sha256sum 取得)
ARG DBIP_SHA256=75fe430010f6d38a8c4331c202bf0df6ce3221a6e6d823b9e5a6d951e4cf9758
RUN test "${#DBIP_SHA256}" -eq 64 && mkdir -p /app/geoip   && wget -qO /tmp/dbip.mmdb.gz "https://download.db-ip.com/free/dbip-country-lite-${DBIP_MONTH}.mmdb.gz"   && echo "${DBIP_SHA256}  /tmp/dbip.mmdb.gz" | sha256sum -c -   && gunzip -c /tmp/dbip.mmdb.gz > /app/geoip/dbip-country-lite.mmdb   && rm /tmp/dbip.mmdb.gz && test -s /app/geoip/dbip-country-lite.mmdb

FROM node:22-alpine
# PA / AD log 與知識庫的時間是台灣當地時間(舊版 IIS 主機時區);Node 內建 ICU 時區資料,不需 tzdata
ENV NODE_ENV=production PORT=51292 TZ=Asia/Taipei
WORKDIR /app
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY package.json ./
COPY --from=build /app/geoip geoip/
ENV GEOIP_DB=/app/geoip/dbip-country-lite.mmdb
# netops-ingest 冷歸檔的本機暫存(C4;Compose 掛 named volume,第一次掛載時沿用這裡的擁有者 node)
RUN mkdir -p /var/lib/netops-ingest/staging && chown -R node:node /var/lib/netops-ingest
USER node
EXPOSE 51292
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:51292/healthz >/dev/null || exit 1
CMD ["node", "dist/src/server.js"]

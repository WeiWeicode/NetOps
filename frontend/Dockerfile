# NetOps 前端 SPA 映像檔(同 GigaItApp、giga-Portal;Gateway DEPLOYMENT.md §3.4):內含 dist,部署時以一次性容器發佈到 Nginx 的 gw_www volume
#   由 deploy/docker-compose.yml 的 spa-netops 建置(@giganexus/web-kit 取自公司 GitLab npm Registry,需 BuildKit secret npm_token)
#   docker run --rm -v <gw_www>:/srv/www spa-netops:<版本> publish netops     # 原子切換 /srv/www/netops/current(Nginx /netops/)
#   docker run --rm -v <gw_www>:/srv/www spa-netops:<版本> rollback netops    # 指回上一版
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# Token 以 BuildKit secret 傳入,不留在映像層;--include=dev:主機上的基底映像可能帶 NODE_ENV=production(同 giga-Portal)
RUN --mount=type=secret,id=npm_token GITLAB_NPM_TOKEN="$(cat /run/secrets/npm_token)" npm ci --include=dev --no-audit --no-fund
COPY . .
# 版本名稱:releases/<版本> 的目錄名,也是 web-kit 監控回報的 release;未指定時用建置時間
ARG RELEASE_SHA=
RUN SHA="${RELEASE_SHA:-netops-$(date +%Y%m%d%H%M%S)}" \
  && VITE_RELEASE="$SHA" npm run build && mkdir -p /out && mv dist /out/netops && echo "$SHA" > /out/RELEASE

FROM alpine:3.20
RUN apk add --no-cache coreutils
COPY --from=build /out /dist
COPY publish.sh /usr/local/bin/spa
RUN chmod +x /usr/local/bin/spa
ENTRYPOINT ["spa"]
CMD ["publish", "netops"]

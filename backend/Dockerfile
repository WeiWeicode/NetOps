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

FROM node:22-alpine
# PA / AD log 與知識庫的時間是台灣當地時間(舊版 IIS 主機時區);Node 內建 ICU 時區資料,不需 tzdata
ENV NODE_ENV=production PORT=51292 TZ=Asia/Taipei
WORKDIR /app
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY package.json ./
USER node
EXPOSE 51292
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:51292/healthz >/dev/null || exit 1
CMD ["node", "dist/src/server.js"]

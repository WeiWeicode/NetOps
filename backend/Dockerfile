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
ENV NODE_ENV=production PORT=51292
WORKDIR /app
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/dist dist/
COPY package.json ./
USER node
EXPOSE 51292
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:51292/healthz >/dev/null || exit 1
CMD ["node", "dist/src/server.js"]

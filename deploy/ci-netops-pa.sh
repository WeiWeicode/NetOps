#!/bin/sh
# CI deploy-api-test:判斷 netops-pa 要不要重建(在 repo 根目錄執行;stdout 只印 keep 或 rebuild,原因印在 stderr)。
#   PA_PLAN="$(sh deploy/ci-netops-pa.sh)"
# 為什麼:netops-pa 重建會讓 PA-560 的 Syslog TCP 斷線,PA-560 不會自動重連(error 110),要請網通對 netops-syslog 再 Commit
#   (docs/PA-FORWARDING-SPEC.md F.3)。映像標籤是 commit 短 SHA,每個 commit 都不同,原本每次部署都會重建。
# 判斷:正在執行的 netops-pa 同時符合下列條件才 keep(不 build、不 up,沿用原容器與原映像):
#   1. 容器存在且 healthy
#   2. 映像標籤(建置時的 commit 短 SHA)在 git 歷史裡,且從那個 commit 到 HEAD,pa-collector/ 沒有變更
#   3. 用原標籤算出的 Compose 設定雜湊(docker compose config --hash:image、environment、ports、volumes、secrets 定義等)
#      等於容器上的 com.docker.compose.config-hash → compose 的 netops-pa 段與 netops.env 的 PA_* 都沒變
#   1b. 容器用的映像就是標籤現在指的映像(沒被手動重建或 retag)
#   4. 沒有設 NETOPS_PA_RECREATE=1(機密檔或憑證檔內容換了時,手動重跑 pipeline 帶這個變數強制重建)
# 需要的環境變數同 CI(COMPOSE_ENV_FILES、NETOPS_SECRETS_DIR、GW_ENV 等由 netops.env 提供);只執行唯讀指令。
set -eu
C="docker compose -f deploy/docker-compose.yml"

plan() {
  if [ "${NETOPS_PA_RECREATE:-0}" = 1 ]; then echo "NETOPS_PA_RECREATE=1:強制重建"; return; fi
  id="$($C ps -q netops-pa 2>/dev/null || true)"
  [ -n "$id" ] || { echo "netops-pa 沒有在執行"; return; }
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
  [ "$health" = healthy ] || { echo "netops-pa 狀態是 $health"; return; }
  image="$(docker inspect -f '{{.Config.Image}}' "$id")"
  # 同一個標籤被手動重建或 retag 過時,容器跑的已不是標籤現在指的映像
  [ "$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)" = "$(docker inspect -f '{{.Image}}' "$id")" ] || { echo "映像標籤 $image 已不是容器使用的映像"; return; }
  old="${image##*:}"
  case "$old" in
    *[!0-9a-f]* | "") echo "映像標籤 $old 不是 commit SHA"; return ;;
  esac
  git cat-file -e "$old^{commit}" 2>/dev/null || { echo "git 歷史找不到 $old"; return; }
  git diff --quiet "$old" HEAD -- pa-collector || { echo "pa-collector/ 在 $old 之後有變更"; return; }
  want="$(IMAGE_TAG="$old" $C config --hash netops-pa 2>/dev/null | awk '{print $2}' || true)"
  have="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$id")"
  [ -n "$want" ] && [ "$want" = "$have" ] || { echo "Compose 的 netops-pa 設定或 netops.env 有變更"; return; }
  echo "keep $old"
}

# 判斷過程出錯(容器剛好消失、docker 暫時失敗)一律當成要重建:退回原本的行為
reason="$(plan)" || reason="判斷失敗(${reason:-無訊息})"
case "$reason" in
  "keep "*) echo "netops-pa 沒有變更(沿用映像 ${reason#keep },不重建、不重啟)" >&2; echo keep ;;
  *) echo "netops-pa 要重建:$reason" >&2; echo rebuild ;;
esac

# netops-pa(PA-560 即時監控收集器)

NetOps R1。設計依據 [`docs/PA-LIVE-PLAN.md`](../docs/PA-LIVE-PLAN.md)(§3.1、§4、§9),PA-560 端的設定見 [`docs/PA-FORWARDING-SPEC.md`](../docs/PA-FORWARDING-SPEC.md)。

| 元件 | 內容 |
| --- | --- |
| SDK 輪詢(`PA_POLL_ENABLED`) | pan-os-python 唯讀 op 查詢(`poller.py` 白名單 4 個 `show` 指令),寫 `netops:pa:snap:*`(60 秒 TTL)與 `netops:pa:series:*`(2 天) |
| PA 精準查詢(`PA_QUERY_ENABLED`,C5) | 從 Redis `netops:paq:jobs` 取工作,一次一個:XML API `type=log`(單一 IP、≤ 15 分鐘、≤ 500 筆)或 Session Browser;送出前取樣管理平面 CPU(> `PA_QUERY_MAX_MGMT_CPU`,預設 50% 不送)、60 秒逾時送 `action=finish`;Key 放 `X-PAN-KEY` 標頭(`pa_query.py`) |
| HTTP 接收 :51293(`PA_RECEIVE_ENABLED`) | `POST /v1/logs/{type}`(TRAFFIC 以外),標頭 `X-NetOps-Token`;只接受 `PA_ALLOWED_SOURCES` |
| Syslog 接收 :51294(同上) | TCP(選用 TLS),只收 TRAFFIC;訊息本文為 JSON |
| 寫入 | `netops:pa:log:{type}` Stream(TRAFFIC 1 小時、其他 2 天,MINID 修剪)、`agg` / `top` 每分鐘統計(TRAFFIC 1 天、其他 2 天,TTL)、`netops:pa:heartbeat` |

鍵格式只在 `netops_pa/keys.py` 定義(Node 端 `backend/src/infra/redis/` 同一份規則)。**不寫入資料庫**(D20)、**不寫入防火牆**(D22)。

## 本機測試

```bash
cd pa-collector
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements-dev.txt   # Linux:.venv/bin/python
.venv/Scripts/python -m ruff check .
.venv/Scripts/python -m pytest
```

測試用假 PA(`tests/fake_pa.py`,模擬 PAN-OS XML API,真正的 pan-os-python 連過去)與 fakeredis,不連任何外部主機。CI 以 `docker build --target test` 在 Python 3.12 執行同樣的檢查。

## 設定

見 `netops_pa/config.py` 檔頭;部署變數與機密見 `deploy/docker-compose.yml` 的 `netops-pa` 段。

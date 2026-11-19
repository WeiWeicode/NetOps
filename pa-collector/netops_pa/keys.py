"""Redis 鍵格式與保留時間(PA-LIVE-PLAN §4、ARCHITECTURE D21)。

鍵格式只在這裡定義;Node 端 backend/src/infra/redis/ 有同一份規則,兩邊要一起改,改之前先回報需求方。
分鐘桶一律用 UTC 的 yyyyMMddHHmm(收集器收到 log 的時間),不用 log 自己的時間欄位:
log 時間可能延遲或格式錯誤,用收到的時間才能保證修剪與 TTL 正確。
"""

from __future__ import annotations

from datetime import UTC, datetime

PREFIX = "netops:pa"

# log 類型(PA-LIVE-PLAN §4);traffic 經 Syslog,其他經 HTTP(P7 定案)
LOG_TYPES = ("traffic", "threat", "url", "wildfire", "data", "decryption", "globalprotect", "userid")
HTTP_TYPES = tuple(t for t in LOG_TYPES if t != "traffic")

# 快照指標
METRICS = ("session", "cpu", "throughput", "interfaces")

HOUR = 3600
DAY = 24 * HOUR

# 保留時間(秒),2026-11-04 需求方決定:TRAFFIC 明細 1 小時、統計 1 天;其他類型明細與統計 2 天
LOG_RETENTION = {t: (HOUR if t == "traffic" else 2 * DAY) for t in LOG_TYPES}
AGG_RETENTION = {t: (DAY if t == "traffic" else 2 * DAY) for t in LOG_TYPES}
SERIES_RETENTION = 2 * DAY
# Stream 筆數上限(防護用,正常量遠低於此;每筆約 300 bytes,合計最壞約 1.5 GB < maxmemory 2 GB):
#   TRAFFIC 1 小時:平均每秒 90–130 筆(PA-LIVE-PLAN §5),上限約每秒 400 筆;其他類型 2 天各 50 萬筆
LOG_MAXLEN = {t: (1_500_000 if t == "traffic" else 500_000) for t in LOG_TYPES}
# 快照 60 秒過期:過期即視為「停止更新」,畫面不把舊快照當即時資料(PA-LIVE-PLAN §3.1)
SNAP_TTL = 60


def minute_bucket(ts: float) -> str:
    """Unix 秒 → UTC yyyyMMddHHmm。"""
    return datetime.fromtimestamp(ts, UTC).strftime("%Y%m%d%H%M")


def snap(metric: str) -> str:
    return f"{PREFIX}:snap:{metric}"


def series(metric: str) -> str:
    return f"{PREFIX}:series:{metric}"


def log_stream(log_type: str) -> str:
    return f"{PREFIX}:log:{log_type}"


def agg(log_type: str, bucket: str) -> str:
    return f"{PREFIX}:agg:{log_type}:{bucket}"


def top(log_type: str, dim: str, bucket: str) -> str:
    return f"{PREFIX}:top:{log_type}:{dim}:{bucket}"


HEARTBEAT = f"{PREFIX}:heartbeat"

# 測試區手動開關(2026-11-09 需求方決定;PA-LIVE-PLAN §4):netops-api 寫入(netops.pa-realtime.write)、netops-pa 只讀。
# Hash 欄位 pollPaused / receivePaused("1" 暫停、"0" 或沒有 = 繼續)、updatedAt、updatedBy。不設 TTL;
# 正式區(GW_ENV=prod)netops-pa 不讀這個鍵,netops-api 也不允許寫入。
CONTROL = f"{PREFIX}:control"

# PA 精準查詢(C5;docs/PA-LOG-CLICKHOUSE-GUIDE.md §9、ARCHITECTURE D31)。netops-api 送出工作、netops-pa 執行;
# 鍵格式同 backend/src/infra/redis/pa-query.ts,兩邊一起改。
#   jobs          List:待執行的工作 id(netops-api LPUSH、netops-pa BRPOP)
#   job:{id}      Hash:kind、params(JSON)、emp、status、時間、結果;TTL 10 分鐘(netops-api 建立,netops-pa 更新)
#   active        String:全系統唯一的查詢名額(值 = 工作 id;netops-api SET NX,netops-pa 結束時比對後刪除);TTL 90 秒
#   cool:global   String:全域最小間隔(netops-pa 每個工作結束時設 10 秒)
#   cool:{emp}    String:每人冷卻(netops-api 送出時設 60 秒)
PAQ_PREFIX = "netops:paq"
PAQ_JOBS = f"{PAQ_PREFIX}:jobs"
PAQ_ACTIVE = f"{PAQ_PREFIX}:active"
PAQ_COOL_GLOBAL = f"{PAQ_PREFIX}:cool:global"
PAQ_JOB_TTL = 600
PAQ_COOL_GLOBAL_SEC = 10


def paq_job(job_id: str) -> str:
    return f"{PAQ_PREFIX}:job:{job_id}"


# PA 安全規則(PR-1;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3)。netops-pa 寫入、netops-api 讀取;
# 鍵格式同 backend/src/infra/redis/pa-policy.ts,兩邊一起改。
#   snapshot  String(JSON):fetchedAt、hash(規則 + 物件內容雜湊)、vsys、rules(依 PA 順序,含 position)、objects
#   hits      String(JSON):fetchedAt、items{規則名稱: hitCount、lastHit、firstHit、lastReset、created、modified}
#   status    Hash:state(ok / failed / rejected / paused)、message、lastRunAt、trigger、mgmtCpu(本次;沒讀到為空字串)
#             與最近一次成功的 lastOkAt、durationMs、ruleCount、hash(失敗時保留,快照仍是那一次的內容)
#   refresh   String:手動重新整理請求(netops-api SET、netops-pa GETDEL);值為 JSON(requestedAt、emp)
#   cool      String:手動重新整理冷卻(netops-api SET NX EX 300)
# 快照 7 天過期:收集器停很久時不把很舊的規則當成現況(畫面另依 fetchedAt 標示過期)
POLICY_PREFIX = f"{PREFIX}:policy"
POLICY_SNAPSHOT = f"{POLICY_PREFIX}:snapshot"
POLICY_HITS = f"{POLICY_PREFIX}:hits"
POLICY_STATUS = f"{POLICY_PREFIX}:status"
POLICY_REFRESH = f"{POLICY_PREFIX}:refresh"
POLICY_COOL = f"{POLICY_PREFIX}:cool"
POLICY_TTL = 7 * DAY

# PA 威脅特徵碼(TS-1;docs/THREAT-SIGNATURE-PLAN.md §4.1、§5.4)。netops-pa 寫入、netops-api 讀取;
# 鍵格式同 backend/src/infra/redis/pa-signature.ts(TS-2),兩邊一起改。
#   meta                 String(JSON):fetchedAt、checkedAt、threatVersion、threatReleaseDate、appVersion、appReleaseDate、
#                        avVersion、avReleaseDate、wildfireVersion、wildfireReleaseDate、urlFilteringVersion、
#                        counts({vulnerability,spyware,total})、hash、baselineAt
#   items:vulnerability  String(JSON):弱點特徵正規化清單(TS-0 實測約 2.5 萬筆)
#   items:spyware        String(JSON):間諜軟體特徵正規化清單(TS-0 實測約 1 萬筆)
#   profiles             String(JSON):fetchedAt、vsys、profileGroups、vulnerabilityProfiles、spywareProfiles(vsys1)
#   status               Hash:state(ok / failed / rejected / paused)、message、lastRunAt、trigger、mgmtCpu
#                        與最近一次成功的 lastOkAt、durationMs、count、threatVersion、fullFetch
#   refresh              String:手動重新整理請求(netops-api SET、netops-pa GETDEL)
#   cool                 String:手動重新整理冷卻(netops-api SET NX EX 300)
#   lookup:jobs          List:抽屜按需單筆查詢工作 id(netops-api LPUSH、netops-pa RPOP)
#   lookup:job:{id}      Hash:threatId、emp、status(queued/running/done/not_found/rejected/failed)、時間、結果;TTL 10 分鐘
#   lookup:cache:{tid}   String(JSON):單筆查詢結果快取({found,item?,checkedAt});TTL 1 天
#   lookup:cool          String:單筆查詢全域限流(netops-pa 每次查詢 PA 前 SET NX EX 10)
# 快照 7 天過期(每次定期檢查成功時續期):收集器停很久時不把過期快照當現況
SIG_PREFIX = f"{PREFIX}:sig"
SIG_META = f"{SIG_PREFIX}:meta"
SIG_ITEMS_VULN = f"{SIG_PREFIX}:items:vulnerability"
SIG_ITEMS_SPYWARE = f"{SIG_PREFIX}:items:spyware"
SIG_PROFILES = f"{SIG_PREFIX}:profiles"
SIG_STATUS = f"{SIG_PREFIX}:status"
SIG_REFRESH = f"{SIG_PREFIX}:refresh"
SIG_COOL = f"{SIG_PREFIX}:cool"
SIG_TTL = 7 * DAY

SIG_LOOKUP_JOBS = f"{SIG_PREFIX}:lookup:jobs"
SIG_LOOKUP_COOL = f"{SIG_PREFIX}:lookup:cool"
SIG_LOOKUP_JOB_TTL = 600
SIG_LOOKUP_CACHE_TTL = DAY
SIG_LOOKUP_COOL_SEC = 10


def sig_items(kind: str) -> str:
    return f"{SIG_PREFIX}:items:{kind}"


def sig_lookup_job(lookup_id: str) -> str:
    return f"{SIG_PREFIX}:lookup:job:{lookup_id}"


def sig_lookup_cache(threat_id: str) -> str:
    return f"{SIG_PREFIX}:lookup:cache:{threat_id}"

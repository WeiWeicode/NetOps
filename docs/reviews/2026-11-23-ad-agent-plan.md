# 審查紀錄:AD Log 即時收集 Agent 計畫書(!176)

- **審查對象**:`docs/AD-AGENT-PLAN.md`(commit `2ed73da`,MR !176,Gemini 撰寫)
- **審查者**:Claude(需求方 2026-11-23 指定)
- **狀態**:!176 已於 2026-11-23 合併 develop 並隨 !181 進 main;本紀錄是事後審查,修正請另開 MR 改計畫書。
- **核對方式**:對照 `origin/develop` 的程式與文件(`scripts/dc/ADLog-FtpBackup-3.ps1`、`backend/src/modules/ad/`、`backend/src/ingest/`、`pa-collector/netops_pa/receiver_http.py`、`deploy/docker-compose.yml`、`deploy/gateway-rbac.yaml`、`docs/VIZ-RULES-DESIGN.md`、`docs/IMPL-PLAN.md`)。沒有在 DC 上實測。

## 結論

方向可行:Agent 增量讀取 + 水位續傳、Watchdog 管道看守、FTP 降為對帳補漏、讀寫帳號分離、不自創權限代碼,都和既有 PA 架構一致。**但有 4 項 High 要在 AD-1 開工前改計畫書或由需求方決定**(H1–H4),其中 H1、H2、H3 需要需求方決定。

## High

### H1 AD 接收放進 `netops-pa`,每次改 AD 接收都會斷 PA Syslog

- 計畫 AD4 / §4.1 / AD-1:在 `pa-collector` 的 `:51293` 加 `/ad/v1/logs`、`/ad/v1/heartbeat`。
- 問題:改到 `pa-collector/` 就會在部署時重建 `netops-pa`,PA-560 的 Syslog 連線會斷,要網通在場重新 Commit(`deploy/RUNBOOK-prod.md` §8;11-19 TS-1、11-20 推正式區、!172 都遇過)。AD 接收程式在 AD-1 ~ AD-3 期間會反覆修改,每次都要約網通。反過來,PA 收集器的修改也會讓 DC Agent 斷線(Agent 有續傳,影響較小)。
- 建議(**需求方決定**):
  - A.(建議)AD 接收獨立成一個小容器(例如 `netops-ad-receiver`,沿用 `netops-pa` 映像或 TS 寫在 `backend/`),只寫 Redis,不碰 PA。
  - B. 照計畫放 `netops-pa`,接受每次修改都要網通在場。

### H2 AD-5 依賴的偵測規則引擎(V-c)還沒有實作

- 計畫 §6.3、§7 第 4 點寫「沿用既有 `netops.alert.read`、`netops.alert.write`、`netops.detect.read`、`netops.detect.write`」「告警統一寫入 `netops.detect_alerts`」「直接呈現在『偵測告警 › 告警』頁面」。
- 實際:`deploy/gateway-rbac.yaml` 沒有 `netops.alert.*`、`netops.detect.*`;`backend/`、`frontend/`、`deploy/` 都沒有 `detect_alerts` 或規則引擎。這些只在 `VIZ-RULES-DESIGN.md`(V-c,規劃已合併、未實作);IMPL-PLAN V-c 仍等網段清單(X11),V-d 的前置是「V-a–V-c 完成」。
- 影響:AD-5 的規則 8 / 9 / 10 沒有地方寫、沒有頁面顯示;§7「不新增權限代碼」也不成立(V-c 的 4 個代碼要先在 Gateway 登記)。
- 建議(**需求方決定**):
  - A.(建議)AD-1 ~ AD-4 照做;AD-5 改成「V-c 完成後」,計畫書寫明依賴。
  - B. 先做 V-c(PA 規則 1–7 + 告警頁 + 權限),再做 AD-5。
  - C. AD-5 自己建引擎(範圍會大很多,不建議)。

### H3 傳輸明文、所有 DC 共用一把 Token、`computer` 由用戶端自填

- 正式區接收端是明文 HTTP(主機 3 `netops.env` `PA_RECEIVE_PLAINTEXT=1`,PA 管理憑證問題所致);計畫沒寫 AD 走 TLS。Token 在內網可被擷取。
- 所有 DC 共用 `AD_AGENT_TOKEN_FILE`,`computer` 由 payload 自填:拿到 Token 的人可以偽造任何 DC 的事件(灌假暴力破解告警)或偽造「正常」心跳,掩蓋真的停擺(規則 10 失效)。
- `AD_ALLOWED_SOURCES` 擋不住:`:51293` 是 `127.0.0.1` 發佈再經主機轉入,容器看到的來源是 Docker 閘道(正式區 `PA_ALLOWED_SOURCES=192.168.64.1/32`),不是 DC IP。
- 建議(**需求方決定**是否全做;建議全做):
  1. Agent → 接收端走 TLS:主機 3 已有 `host3-pa-pki.sh` 建的 CA 與 `server.crt`(SAN `IP:10.10.130.122`),Rust 端內建 CA 驗證即可;PA 的明文例外不延伸到 AD。
  2. 每台 DC 一把 Token,伺服器端用 Token 對應 `computer` / `domain`,payload 的值不一致就拒收。
  3. 來源限制寫在主機 Windows 防火牆規則(列出 DC IP),計畫書刪掉「`AD_ALLOWED_SOURCES` 限制來源 DC IP」的說法或註明只在非 NAT 環境有效。

### H4 Event Log 清除後 `record_id` 重編,去重與補漏的鍵會撞號

- §3.3:偵測到最大 RecordID 小於水位時「水位重設為 0 從頭讀取」。§4.3.1、§5 的去重與補漏都以 `(computer, channel, record_id)` 為鍵。
- 若清除後 RecordID 從 1 重新編號,新事件會和 ClickHouse 裡的舊事件同號:FTP 補漏會把缺漏的新事件當成「已存在」而不補,任何以 record_id 判斷重複的邏輯都會誤判。1102(稽核記錄清除)正是最需要完整紀錄的時候。
- 建議:鍵加上世代欄位(例如偵測到重置時 `log_epoch` 加 1,寫進 `ad_events` 與 bookmarks),或改用 `(record_id, event_time)`;「清除後 RecordID 是否重編」列為 AD-2 DC 實測項目。

## Medium

- **M1 FTP 對帳的事件範圍要對齊**:FTP CSV 的 Security 只有 v3 的 23 種 ID(`$SecurityEventIds`),Agent 另收 4672、4776、4768 失敗(選用 4624)。對帳 `count()` 必須只比同一組 ID,否則每天都對不起來。已確認 CSV 有 `RecordID`、`Computer` 欄,補漏鍵可行;但 CSV 時間只到秒、沒有時區,`Message` 是 DC 本地化文字,補寫列和 Agent 寫入的格式可能不同,要在 AD-3 測試裡比對。
- **M2 至少一次投遞的重複**:`insert_deduplication_token` 只擋「完全相同的批次」。Agent 沒收到 200 重送時,批次可能多了新事件、首尾 RecordID 不同;`netops-ingest` 在 INSERT 後、XACK 前重啟也會重讀。`ad_events` 是一般 MergeTree,重複不會被合併,MV 也會重複計數。建議 Agent 未 ACK 前重送「同一批」(不加新事件),並寫重送測試;或 `ad_events` 改 ReplacingMergeTree(熱力圖 MV 仍會重複,需一併說明)。
- **M3 §5 第 2 點「補寫前停用或補寫後重建 `ad_heat_*` 分桶」**:MV 在 INSERT 時自動累加,只補缺漏列時不需要也不應重建;重建反而會重複計數。改寫成「補漏只寫缺漏列,MV 自然累加」。
- **M4 Watchdog 與 SCM 同時重啟**:`TerminateProcess` 後 SCM 失敗復原(10 秒)也會拉起,Watchdog 再 `StartService` 會遇到已在執行;要處理 `ERROR_SERVICE_ALREADY_RUNNING`。狀態圖寫 `last_collect_tick` 只在 200 OK 後更新,和 §3.2 第 2 點「後端連不上仍推進」矛盾,以後者為準並寫進測試。
- **M5 DC 維護時無法暫停 Agent**:服務被停會自動拉起。需要維護方式(例如 `Uninstall` / `-Pause` 先停 Watchdog 再停 Agent),並說明停 Watchdog 後心跳中斷會觸發規則 10。
- **M6 DC 上的執行檔簽章與 CI**:Rust Windows 建置要在 `host2-windows` Runner 加 job(CI 屬敏感變更);DC 是最高權限主機,建議沿用 RustIt S1 簽章流程,安裝腳本驗證簽章或雜湊。計畫沒寫。
- **M7 決策文件順序**:AD7 是 `AGENT.md` §7.2 與 D20 的資料範圍例外,AGENT.md 要求「先由需求方決定並改 ARCHITECTURE」,但計畫把 AGENT.md / ARCHITECTURE 更新放在最後的 AD-5。建議 AD-1 前先開 docs MR,把 AD1–AD10 寫成 ARCHITECTURE 的 D 編號並更新 AGENT.md §7.2。
- **M8 首次啟動基準**:「最新一筆」和「往回推 1 小時」兩種說法,要選一個預設(建議 60 分鐘);並註明安裝當天較早的事件要到隔天 08:10 對帳才補。

## Low

- L1 簡體字「与」:§3.1 標題「目錄結構与執行模式」、§6.1 表格「對帳結果与補漏」。
- L2 第 4 行「依 `AGENT.md` §7」:分工在 AGENT.md「AI 分工」節,不是 §7。
- L3 §4.2 說 `netops:ad:computers` 下線「可由管理 API 移除」,§6.1 沒有這支 API。
- L4 容量估算以「3 台 DC」計,但 AD1 要推到三網域全部 DC,台數未確認;4624 開關打開時的量級沒估。
- L5 §1.2 AD3 心跳逾時 90 秒顯示停止更新、3 分鐘告警;§6.3 規則 10 寫 `> 180` 秒,一致,但建議兩處都寫成同一個設定名稱。

## 要 Gemini 修改計畫書的項目

H1–H4 依需求方決定改寫;M1–M8、L1–L5 直接修正。修正請另開 `docs/` MR,MR 描述逐項對應本紀錄編號。

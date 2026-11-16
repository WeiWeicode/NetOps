# NetOps 流程架構

> 資料怎麼取得、存在哪裡、AI 怎麼串,分現況、過渡期與未來目標三個階段。決策見 [ARCHITECTURE.md](ARCHITECTURE.md),工作項目見 [IMPL-PLAN.md](IMPL-PLAN.md)。**時程以 NexusPlan 甘特圖為準**,本文件只記架構。
> 現況依 `server/` 程式與 `README.md` 整理,IIS 實際部署版本與 `.env` 設定未核對;過渡期與未來目標尚未實作。

| 項目 | 現況 | 過渡期 | 未來目標 |
| --- | --- | --- | --- |
| 期間 | 目前到正式切換前 | 正式切換後到 A1(AI 搬移)完成前 | A1、R1 完成後 |
| 使用者入口 | IIS `/NetOps` | 新版 `/netops/`;AI 連到舊版 | `/netops/`,舊版 IIS 停用 |
| 登入與權限 | 自簽 JWT、`.env` 名單 | 新版經 BFF;舊版維持自簽 JWT | 經 BFF |
| 資料取得 | 舊版同步 FTP | 新舊各自同步 FTP | FTP(歷史)+ SDK 輪詢與 HTTP Log Forwarding(即時,D19) |
| 資料存放 | IIS `uploads/` | 新版 `/srv/giga-netops/{env}`;舊版 `uploads/` | 檔案(歷史)+ Redis 2 天(即時,D21);不寫資料庫(D20) |
| 知識庫 | 舊版可寫 | 以新版為準,舊版關閉寫入 | 新版管理內容與向量同步 |
| AI | 舊版直連 vLLM、Qdrant | 同現況,知識庫內容會落後 | 新版 `netops-api` 直連 AI 主機 .46(D23) |

---

## 1. 現況(IIS 舊版)

單一 Node 程序同時提供前端、API 與背景工作。

```mermaid
flowchart TD
    PA["PA-560 防火牆<br/>每天匯出流量與事件 log"] --> FTP["FTP 10.10.130.66<br/>log 原檔,系統只讀取"]
    DC["GSMC-DC1<br/>每天排程匯出 AD 事件"] --> FTP

    subgraph IIS["IIS + iisnode:NetOps 舊版"]
        JOB["匯入背景工作<br/>定時或手動同步,串流解析"] --> DATA[("uploads/<br/>摘要、統計、AD、知識庫")]
        API["Express API"]
        DATA --> API
    end

    FTP --> JOB
    FTP -->|"明細查詢直接掃,原始 log 不落地"| API
    B["瀏覽器 Vue<br/>自簽 JWT"] --> API
    API --> SQL["SQL Server<br/>只供登入與跳轉"]
    API --> LLM["vLLM 10.10.130.45<br/>:8080 問答 / :8081 embedding"]
    API --> Q["Qdrant 10.10.130.46<br/>知識庫向量"]
```

### 1.1 資料取得

| 資料 | 怎麼來 | 存放位置 |
| --- | --- | --- |
| PA TRAFFIC log | PA-560 每天匯出 CSV 到 FTP,系統串流解析 | `palogs/summaries/`(摘要)、`palogs/flows/`(連線組合統計) |
| 威脅、URL、VPN 等其他 log | FTP 各類型目錄,用同一個同步間隔 | `palogs/events/` |
| AD 事件 | GSMC-DC1 排程匯出到 FTP `/AD_Log_Backup/yyyyMMdd/` | `adlogs/yyyyMMdd.json` |
| 知識庫 | 管理者手寫、請 AI 整理,或外部 IP 自動學習 | `knowledge/*.md`;向量同步到 Qdrant |

- 同步依 `FTP_SYNC_MINUTES` 自動執行,PA 與 AD 的 FTP Log 頁也能手動同步。
- 明細查詢依時間挑檔案後即時掃 FTP,不讀本機資料。

### 1.2 AI 問答流程

```mermaid
flowchart TD
    A["瀏覽器 POST /ai/ask<br/>問題、時間範圍、最近 6 則對話"] --> B["解析問題<br/>IP、Port、帳號、事件 ID;沒寫就沿用上一題"]
    B --> C1["連線組合統計<br/>本機 flows,優先查"]
    B --> C2["FTP 原始 log<br/>沒有統計才掃"]
    B --> C3["本機摘要與事件<br/>期間統計、安全事件、AD"]
    C1 --> D["挑知識庫筆記<br/>.45 embedding + Qdrant 語意搜尋,加上 IP 與關鍵字比對"]
    C2 --> D
    C3 --> D
    D --> E["組成提示<br/>系統提示 + 對話 + 問題 + 查到的資料 + 筆記"]
    E --> F["vLLM 10.10.130.45:8080<br/>/chat/completions 串流回答"]
    F --> G["SSE 回傳瀏覽器<br/>掃描進度、查到的資料、引用筆記、回答內容"]
```

### 1.3 其他 AI 功能

| 功能 | 送給模型的內容 | 回傳方式 |
| --- | --- | --- |
| AI 分析 | 期間摘要與其他 log 統計,不掃 FTP;有輸入問題才做語意搜尋 | SSE 串流 |
| 整理筆記 | 管理者的說明與最近對話,AI 回 JSON 後存成筆記 | 一次回傳 |
| 翻譯 | AI 的回答內容,關閉思考模式 | 一次回傳 |
| 向量同步 | 筆記內容經 `.45:8081` 算向量後寫入 Qdrant;異動 3 秒後同步,另外每 30 分鐘全部比對 | 背景執行 |
| 外部 IP 自動學習 | 每天查 RDAP 與 DNS 反查,交給 AI 整理成筆記 | 背景執行 |

---

## 2. 過渡期(新版上線,舊版留給 AI)

新版接入 Gateway 負責一般功能,AI 不改寫(D17)。正式切換後舊版 IIS 繼續運作,只提供 AI(D18)。切換前新版只在測試區,正式使用者仍用舊版。

```mermaid
flowchart TD
    PA["PA-560 防火牆"] --> FTP["FTP 10.10.130.66"]
    DC["GSMC-DC1"] --> FTP
    U["使用者瀏覽器"] -->|"一般功能 HTTPS :443"| N["Gateway:Nginx / BFF<br/>登入、RBAC、路由"]

    subgraph NEW["新版 NetOps"]
        S["SPA /netops/"]
        A["netops-api :51292<br/>同步、總覽、明細、知識庫"]
        D[("/srv/giga-netops/{env}<br/>摘要、統計、AD、知識庫")]
        A --> D
    end

    N --> S
    N -->|"X-Internal-Token"| A
    FTP -->|"同步與明細查詢"| A
    A --> O["giga-observe<br/>紀錄與心跳"]

    subgraph OLD["舊版 IIS:只提供 AI"]
        API["Express API<br/>AI 問答、分析、翻譯"]
        UP[("uploads/<br/>知識庫不再更新")]
        API --> UP
    end

    S -.->|"選單連結,另行登入"| API
    FTP -->|"繼續同步"| API
    API --> SQL["SQL Server<br/>舊版登入"]
    API --> LLM["vLLM 10.10.130.45"]
    API --> Q["Qdrant 10.10.130.46"]
    UP -.->|"切換時全部複製一次(D14)"| D
```

| 規則 | 內容 |
| --- | --- |
| 資料複製 | 切換時關閉舊版知識庫寫入與自動學習,全部複製後核對檔數與總覽數字 |
| 知識庫 | 以新版為準,不寫回舊版;舊版 AI 參考的內容會落後 |
| FTP | 新舊各同步一份,要控制連線數;測試區連線數為 1 |
| 回滾 | 舊版同時作為回滾路徑;切換時在 `main` 打標籤保留程式 |

**未定**:舊版關閉知識庫寫入的做法,D2 切換前確認。

---

## 3. 未來目標(A1 AI 搬移、R1 即時監控完成後)

2026-11-04 取消 AI 中控台(原規劃見工作區 `GigaNexusAIPlan/docs/AI-CONSOLE-PRD.md`,已標示取消)。AI 搬進 `netops-api`(D23),PA 即時資料走 Redis(D19),不寫資料庫(D20);A1 完成後停用舊版 IIS。細節見 [PA-LIVE-PLAN.md](PA-LIVE-PLAN.md),虛線是之後才做的部分。

```mermaid
flowchart TD
    PA["PA-560 防火牆"] -->|"每天匯出 log"| FTP["FTP 10.10.130.66<br/>歷史(事後查詢)"]
    DC["GSMC-DC1"] --> FTP
    U["使用者瀏覽器"] --> N["Gateway:Nginx / BFF"]

    subgraph NET["NetOps"]
        S["SPA /netops/"]
        A["netops-api :51292<br/>總覽、明細、知識庫、AI、即時監控"]
        D[("資料檔<br/>摘要、統計、AD、知識庫")]
        R[("netops-redis<br/>快照 + 2 天 log")]
        P["netops-pa(Python)<br/>SDK 輪詢 + Log 接收"]
        A --> D
        A --> R
        P --> R
    end

    N --> S
    N -->|"X-Internal-Token<br/>REST + SSE"| A
    FTP --> A
    P -->|"10–15 秒輪詢(唯讀)"| PA
    PA -->|"HTTP Log Forwarding"| P
    A --> O["giga-observe"]
    A --> LLM["AI 主機 10.10.130.46<br/>:8080 模型 / :8081 embedding"]
    A --> Q["Qdrant<br/>知識庫向量"]
    A -.->|"R2 封鎖 IP(DAG)"| PA
```

**開工前要確認**:PA-LIVE-PLAN §11(P1–P6);串流實測(S0,D7);外部 IP 自動學習的對外連線(D10)。

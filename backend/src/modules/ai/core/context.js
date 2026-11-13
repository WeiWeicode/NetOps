/**
 * AI 分析與問答的資料整理與提示(由舊版 server/routes/ai.js 搬移,IMPL-PLAN A1;ARCHITECTURE D4、D23)
 *   buildContext:期間內 PA 摘要 → 精簡文字(只送統計摘要給模型,不送原始 log,AGENT.md §7.4)
 *   SYSTEM_PROMPT / ASK_PROMPT:提示文字與舊版逐字相同(整理筆記的 NOTE_PROMPT 與 parseJsonReply 依 2026-11-09 決定不搬,ARCHITECTURE D25)
 * 只搬純函式:摘要的讀取由呼叫端注入 summarize(from, to, topN)(舊版直接呼叫 importer 的 filesInRange / readSummary)。
 */

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`
const parseDay = (s) => {
  const [y, m, d] = s.split('/').map(Number)
  return new Date(y, m - 1, d)
}
const addDays = (s, n) => {
  const d = parseDay(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}
const num = (n) => (Number(n) || 0).toLocaleString('en-US')
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-')
function bytes(n) {
  let v = Number(n) || 0
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${i ? v.toFixed(1) : v}${u[i]}`
}

// ---------- 資料整理：精簡文字，控制提示長度 ----------

const topLines = (rows, withBytes) =>
  rows?.length ? rows.map((x, i) => `${i + 1}. ${x.key}｜${num(x.n)} 次${withBytes ? `｜${bytes(x.bytes)}` : ''}`) : ['（無）']


/**
 * 期間 [from, to]('yyyy/MM/dd')的分析資料;沒有資料回 null
 *   summarize(from, to, topN) → mergeSummaries 的結果(hours 已篩到期間內),由呼叫端注入
 *   opts.source(s):資料來源的說明,取代「N 個匯出檔」(AC2:ClickHouse 來源是每小時摘要與每天彙總);省略時同舊版
 */
export function buildContext(summarize, from, to, opts = {}) {
  const s = summarize(from, to, 15)
  if (!s.files) return null
  const days = Math.round((parseDay(to) - parseDay(from)) / 86400000) + 1
  const pFrom = addDays(from, -days)
  const pTo = addDays(from, -1)
  const p = summarize(pFrom, pTo, 15)

  const kpi = (x) =>
    `連線紀錄 ${num(x.rows)} 筆｜允許 ${num(x.allow)}（${pct(x.allow, x.rows)}）｜阻擋 ${num(x.block)}（${pct(x.block, x.rows)}）｜總流量 ${bytes(x.bytes)}（送出 ${bytes(x.sent)}、接收 ${bytes(x.recv)}）`

  const lines = [
    `# 分析範圍：${from} ~ ${to}（${days} 天，PA-560 TRAFFIC log，${opts.source ? opts.source(s) : `${s.files} 個匯出檔`}，資料時間 ${s.timeMin} ~ ${s.timeMax}）`,
    '\n## 整體',
    `- ${kpi(s)}`,
    p.files ? `- 前一段同長度期間 ${pFrom} ~ ${pTo}：${kpi(p)}` : `- 前一段期間 ${pFrom} ~ ${pTo} 沒有資料，無法比較`,
    '\n## 動作分布',
    ...Object.entries(s.actions).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}：${num(n)}（${pct(n, s.rows)}）`),
    '\n## 連線結束原因',
    ...topLines(s.top.endReason?.slice(0, 8)),
    '\n## 每小時（時間｜連線數｜允許｜阻擋｜流量）',
    ...s.hours.map((h) => `- ${h.hour}時｜${num(h.n)}｜${num(h.allow)}｜${num(h.block)}｜${bytes(h.bytes)}`),
    '\n## 連線次數最多的來源 IP（次數｜流量）',
    ...topLines(s.top.src, true),
    '\n## 流量最大的來源 IP',
    ...topLines(s.topBytes.src, true),
    '\n## 連線次數最多的目的 IP',
    ...topLines(s.top.dst, true),
    '\n## 流量最大的目的 IP',
    ...topLines(s.topBytes.dst, true),
    '\n## 目的 Port（協定/Port）',
    ...topLines(s.top.dport, true),
    '\n## 流量最大的應用程式',
    ...topLines(s.topBytes.app, true),
    '\n## 區域流向（來源區域 → 目的區域）',
    ...topLines(s.top.zone, true),
    '\n## 目的國家 / 私有區段',
    ...topLines(s.top.dstCountry, true),
    '\n## 規則命中',
    ...topLines(s.top.rule),
    '\n## 被擋最多的來源 IP',
    ...topLines(s.top.blockSrc),
    '\n## 被擋最多的目的 IP',
    ...topLines(s.top.blockDst),
    '\n## 被擋最多的目的 Port',
    ...topLines(s.top.blockDport),
    '\n## 阻擋規則',
    ...topLines(s.top.blockRule),
    '\n## 外部（公網 IP、來源區域 WAN）被擋的來源',
    ...topLines(s.top.inboundBlockSrc),
    '\n## 外部（公網 IP、來源區域 WAN）被允許連入（來源 → 目的:協定/Port）',
    ...topLines(s.top.inboundAllow),
    '\n## 被允許的高風險應用程式（PA App 風險 4~5，已排除 ssl、web-browsing、ms-update 等一般上網）',
    ...topLines(s.top.riskApp, true),
    '\n## 資料外流：上傳到外部最多的內部 IP（內部 IP → 公網 IP 且允許；次數｜送出位元組）',
    ...topLines(s.topBytes.upSrc, true),
    '\n## 資料外流：上傳最多的外部目的地（目的 IP（國家）｜次數｜送出位元組）',
    ...topLines(s.topBytes.upDst, true),
    '\n## 資料外流：高風險管道上傳（檔案分享、雲端儲存、加密通道、郵件、遠端存取、即時通訊、P2P）——依內部 IP → App',
    ...topLines(s.topBytes.upRiskPair, true),
    '\n## 資料外流：高風險管道（App（子分類））',
    ...topLines(s.topBytes.upRiskApp, true),
    '\n## AI 應用：內部 IP → AI App（次數｜上傳到 AI 的位元組）',
    ...topLines(s.top.aiPair, true),
    '\n## AI 應用排行',
    ...topLines(s.top.aiApp, true),
    '\n## 被擋且目標分散的來源（來源｜區域流向｜被擋次數｜不同目的 IP 數｜不同目的 Port 數；數量為單一匯出檔內的最大值，1000 表示 1000 以上）',
    ...(s.scan.length ? s.scan.slice(0, 30).map((x) => `- ${x.src}｜${x.zone}｜${num(x.n)}｜${x.dsts}｜${x.ports}`) : ['（無）']),
  ]
  if (p.files) {
    // 前期沒出現、這期被擋很多的來源（新出現的異常）
    const prevBlock = new Set((summarize(pFrom, pTo, 100).top.blockSrc ?? []).map((x) => x.key))
    const fresh = summarize(from, to, 100).top.blockSrc.filter((x) => !prevBlock.has(x.key)).slice(0, 15)
    lines.push('\n## 這段期間被擋次數排前 100、但前一段期間沒有排進前 100 的來源（新出現）', ...topLines(fresh))
  }
  return { text: lines.join('\n'), files: s.files, rows: s.rows }
}

// ---------- 提示 ----------
export const ENV_NOTES = `環境說明：
- 區域：LAN（使用者）、Server（伺服器區）、WAN（對外，也連到其他廠區 / 子公司，所以 WAN 區域會出現 10.x、172.x 等其他廠區的內部 IP，這不代表網際網路攻擊）、sslvpn（SSL VPN 使用者）。
- 「外部」只指來源為公網 IP 的連線。
- interzone-default 是 PAN-OS 預設的跨區域拒絕規則；被它擋下代表沒有任何允許規則符合。
- 國家欄位出現「10.0.0.0-10.255.255.255」等是私有位址區段，不是國家。
- action：allow 允許；deny / drop 拒絕或丟棄；reset-* 是送出 TCP RST 中斷。
- App 為 incomplete / insufficient-data / not-applicable 通常是交握未完成或被擋在辨識應用之前。
- 「被擋且目標分散的來源」：不同目的 Port 很多 → 疑似 Port 掃描；不同目的 IP 很多 → 疑似主機掃描、蠕蟲擴散，或是程式設定錯誤不斷嘗試連線（例如連不到的更新伺服器、NTP、DNS）。
- 內部主機大量被擋連往同一個外部 IP / Port，常見原因是軟體更新、雲端代理程式、惡意程式回連（C2）或政策遺漏，需要依目的位址與 Port 判斷。
- 「資料外流」排行只算內部 IP 送到公網 IP 的位元組（上傳）：少數連線、大量且集中送往固定的外部 IP，常見是異地備份 / 雲端同步，也可能是資料外流，要提醒確認該主機用途與目的地；經檔案分享、雲端儲存、個人郵件、遠端存取、即時通訊上傳公司資料屬高風險。
- 「AI 應用」依 PA App-ID 子分類 artificial-intelligence（ChatGPT、Gemini、Claude、Copilot 等）：上傳量大代表可能把文件或程式碼貼給外部 AI，需依公司 AI 使用規範確認；公司內部 AI（10.10.130.45 / .46）不在此列。
- 結束原因：policy-deny 被規則擋下；aged-out 逾時沒有回應（常見於 UDP 或對方沒回應）；tcp-rst-from-client / server 是一方送 RST 中斷；tcp-fin 正常結束；decrypt-error 解密失敗。
- 封包數 1、接收 0 bytes 的阻擋紀錄代表第一個封包就被擋，連線完全沒有建立。`

/** AD 事件記錄的背景說明 */
export const AD_NOTES = `AD 事件記錄說明：
- 來自網域控制站（例如 GSMC-DC1）每天匯出的 Windows 事件記錄：Security（安全性）、System（系統）、Directory_Service（目錄服務）、DNS_Server（DNS 伺服器）。
- 常見事件：4624 登入成功、4625 登入失敗、4740 帳號被鎖定、4771 Kerberos 預先驗證失敗（多半是密碼錯誤）、4720/4726 建立 / 刪除帳號、4728/4732/4756 加入安全群組、4724 重設密碼、1102 稽核記錄被清除；
  4771 錯誤碼 0x25 字面是 Kerberos 時間差，但時間與時區都正確時仍可能出現（例如 NAS 等加入網域的設備，某個服務用過期的認證固定間隔重試），只憑錯誤碼不可斷定「時鐘不準」，要建議實際量測（DC 上 w32tm /stripchart /computer:<IP>）並檢查該設備的網域狀態與記錄；
  System 37（KDC 票證缺少帳戶資訊 / PAC，常與 Kerberos 強化更新相關）、5719（NETLOGON 無法與 DC 建立安全通道）、7036 / 7040（服務狀態 / 啟動類型變更）；
  Directory_Service 2089（目錄分割太久沒有備份）、2887 / 3041（有用戶端用未簽章或明文的 LDAP 繫結，建議強制 LDAP 簽章與通道繫結）；DNS_Server 3150（區域寫入檔案，屬正常）、6522（區域轉送）。
- 建立帳號（4720）與加入 / 移出特權群組（Domain Admins、Enterprise Admins、Schema Admins、Administrators、Account Operators、Backup Operators、Server Operators、DnsAdmins 等，資料標示【特權】）一定要逐筆列出：時間、執行者、對象、群組，並提醒確認是否有變更單或主管核准；新建帳號隨即加入特權群組、非 MIS 人員執行特權異動、非上班時間的特權異動，都要列為高風險。
- 若資料註明 Security 記錄是空的，登入、鎖定、帳號異動相關問題要說明「沒有 Security 記錄資料無法判斷」，並建議檢查匯出排程權限與 DC 稽核原則。`

/** PA 其他類型 log 的背景說明 */
export const EV_NOTES = `PA 其他類型 log 說明（資料標題寫明類型）：
- 威脅（THREAT）：IPS / 防毒 / 間諜軟體偵測。severity critical / high 要優先處理；action alert 只記錄沒有阻擋，reset / drop / block 才有擋下；內部 IP 對內部主機的暴力破解（例如 SMB: User Password Brute Force Attempt）可能是密碼錯誤一直重試的程式，也可能是橫向移動，要建議確認來源主機。
- URL 過濾：使用者瀏覽的網站與 URL 類別，block-url 是被擋下的網站。
- 資料過濾（data-filtering）：PA 的檔案 / 資料樣式偵測；方向 client-to-server 是連線發起方送出（上傳），server-to-client 是下載；數量是事件次數，不是檔案大小。
- WildFire：送到 Palo Alto 雲端沙箱分析的檔案，判定 benign 良性、malware / grayware / phishing 需處理。
- 解密（DECRYPTION）：SSL / TLS 解密失敗的紀錄；Proxy 類型 GlobalProtect 是 VPN 入口的 TLS 交握失敗，大量來自國外 IP 多半是掃描。
- GlobalProtect：VPN 登入事件，portal-prelogin / portal-auth / gateway-auth 失敗而且來自同一個國外 IP、帳號不是公司格式（例如 gsmctw\\S 工號），通常是撞密碼攻擊，建議封鎖來源 IP、檢查是否有成功登入。
- User-ID：IP 與使用者帳號的對應（例如 VPN 配發的 172.16.3.x 是哪個工號），可以用來回答「這個 IP 是誰」。`

export const KB_RULE ='「管理者記錄的知識」是知識庫匯整檔（全部筆記，與問題相關的會在開頭標出編號），是 MIS 管理者確認過的環境資訊（主機用途、網段用途、已知正常的連線、處理過的問題、公司規定）。判斷時要先比對這些筆記：資料中的 IP 落在筆記的 IP 或網段內，就要套用該筆記的說明，並在回答中註明引用了哪一則；與問題無關的筆記不用提。若與 log 數據衝突，以 log 為準並指出差異。標籤「自動學習」的筆記是 AI 依公開 IP 註冊資料（RDAP / DNS 反查）整理的外部 IP 擁有者，可用來說明外部 IP 是誰（例如 Microsoft 365 寄信伺服器），但可信度低於管理者手寫的筆記，兩者衝突時以管理者筆記為準。'
export const kbSection = (kb) => (kb.text ? `\n\n## 管理者記錄的知識（知識庫匯整，請先比對）\n\n${kb.text}` : '')

export const SYSTEM_PROMPT = `你是企業 IT 的資深網路與資安顧問，負責分析 Palo Alto PA-560 防火牆的 TRAFFIC log 統計。
資料是防火牆每天匯出的 TRAFFIC log，經系統統計後的摘要（排行只列前幾名），不是完整明細。
${ENV_NOTES}
${EV_NOTES}

回答規則：
1. 一律使用繁體中文，以 Markdown 輸出。
2. 只能根據提供的資料判斷，不可編造資料中沒有的數字、IP、主機名稱或原因；推測要標明「可能」，資料不足時直接說明「資料不足以判斷」，並說明要查哪些明細（例如來源 IP、目的 Port、時間）確認。
3. 提到問題時要具體寫出 IP、Port、App、規則、時間與數字。
4. 同一個原因造成的多筆紀錄要合併說明。
5. ${KB_RULE}
6. 依以下章節輸出：
   ## 整體結論
   （一句話說明狀態：🟢 正常／🟡 需注意／🔴 需立即處理，並說明理由；有前期資料時說明變化）
   ## 資安疑慮
   （依嚴重程度排序；每項寫：現象（數字）、可能原因、建議查證方式；有附「PA 其他 log 摘要」時，威脅 critical / high、GlobalProtect 撞密碼、WildFire 非良性檔案也列在這裡）
   ## 政策與設定
   （阻擋規則、對外開放的服務、高風險應用、可能多餘或遺漏的規則）
   ## 流量與使用狀況
   （尖峰時段、主要流量來源 / 目的 / 應用，有無異常的大量傳輸）
   ## 建議行動
   （編號清單，每項標註優先順序：高／中／低，並寫出具體做法，例如要在防火牆調整什麼、要檢查哪台主機）`

export const ASK_PROMPT = `你是企業 IT 的資深網路與資安顧問，協助 MIS 人員依 Palo Alto PA-560 防火牆的 TRAFFIC log 與 AD 網域控制站的事件記錄查問題（例如某台主機連不到某個服務、為什麼被擋、帳號登入或 AD 服務異常）。
系統會依使用者問題中的 IP / Port 掃描防火牆 log，把相關紀錄彙整後附在問題後面；沒有 IP 時附上的是期間的整體統計。問到 AD（帳號、登入、DNS、Kerberos、事件 ID）或問題的 IP 出現在 AD 事件中時，另外附上 AD 事件記錄。
${ENV_NOTES}
${AD_NOTES}
${EV_NOTES}

回答規則：
1. 一律使用繁體中文，以 Markdown 輸出，直接回答問題，不要重複貼出資料。
2. 只能根據附上的資料判斷，不可編造資料中沒有的紀錄、規則、主機名稱或原因；推測要標明「可能」。
3. 回答要引用具體數字與紀錄：來源 → 目的:Port、動作、規則、App、區域、結束原因、時間、次數。
4. 說明「被擋」時要判斷是哪條規則擋的（interzone-default 代表沒有任何允許規則符合，需要新增或調整允許規則；其他 deny 規則代表被明確拒絕），以及連線卡在哪一段（第一個封包就被擋、逾時沒回應、對方 RST 等）。
5. 若是合法需求被擋，建議怎麼調整政策：具體寫出來源區域 / 來源位址、目的區域 / 目的位址、App 或 Service（Port），並提醒只開必要的範圍。
6. 若看起來是異常（大量嘗試、目標分散、連往可疑外部位址），說明風險與要檢查的主機。
7. 若查無紀錄或資料不完整（掃描逾時），要明確說明，並建議改用哪個時間範圍或 IP 再查。
8. ${KB_RULE}
9. 章節：## 結論（一兩句）、## 查到的紀錄、## 原因判斷、## 建議處理（編號清單）。追問時可以簡短回答，不必每次都用完整章節。`

/** 問到這些關鍵字（沒有 IP 時）帶入 PA 其他類型 log 的期間摘要 */
export const EVENT_Q = /威脅|攻擊|入侵|漏洞|暴力|破解|撞密碼|brute|threat|ips\b|url|網站|網址|瀏覽|vpn|globalprotect|wildfire|沙箱|惡意|病毒|木馬|解密|decrypt|tls|ssl|資料過濾|data.?filter|檔案|上傳|user.?id|哪個使用者|是誰/i

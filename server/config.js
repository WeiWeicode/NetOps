import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env'), quiet: true })

const env = (key, fallback = '') => (process.env[key] ?? fallback).toString().trim()
const list = (key) => env(key).split(/[,;，\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean)
/** FTP 路徑：一律以 / 開頭、結尾不帶 /（根目錄為 /） */
const ftpPath = (p) => ('/' + p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).replace(/\/{2,}/g, '/')
/** PA 其他類型 log 的 FTP 目錄；設成 - 表示不匯入 */
const evDir = (key, def) => (env(key, def) === '-' ? '' : ftpPath(env(key, def)))

export const config = {
  // IIS（iisnode）會把 PORT 設成 named pipe 字串，數字才轉成 port
  // 開發預設 3081（ERMS 3001、SolarMES 3011、SolarDMA 3021、E-Learning 3031、Veeam 3043）
  port: /^\d+$/.test(env('PORT', '3081')) ? Number(env('PORT', '3081')) : env('PORT'),
  // IIS / 正式環境的虛擬目錄，API 同時掛在 /api 與 {basePath}/api
  basePath: env('BASE_PATH', '/NetOps'),
  jwtSecret: env('JWT_SECRET', 'change-me'),
  jwtExpires: env('JWT_EXPIRES', '12h'),
  distDir: path.join(__dirname, '..', 'dist'),
  appUrl: env('APP_URL', 'https://gsmc-web.gigasolar.com.tw/NetOps'),
  // 入口網站同步登入的系統代碼（PortalSolar.dbo.SyncLoginInfo.SyncParagram）
  syncParagram: env('SYNC_PARAGRAM', 'NetOps'),

  // 可使用本系統的人員：工號清單或部門代號清單，任一符合即可；兩個都空白 = 所有在職員工
  viewUsers: list('VIEW_USERS'),
  viewDepts: list('VIEW_DEPTS'),

  // 樣式設定存檔位置（不隨 npm run publish 覆蓋）
  themeFile: path.resolve(__dirname, '..', env('THEME_FILE', path.join('uploads', '_settings', 'theme.json'))),

  // PA 防火牆 log 所在的 FTP
  ftp: {
    host: env('FTP_HOST'),
    port: Number(env('FTP_PORT', '21')) || 21,
    user: env('FTP_USER'),
    password: env('FTP_PWD'),
    // FTPS（explicit TLS）；預設一般 FTP
    secure: env('FTP_SECURE') === '1',
    // 畫面上只能瀏覽這個目錄以下（避免看到整台主機的分享）
    root: ftpPath(env('FTP_ROOT', '/')),
    // 「同步」按鈕 / 自動同步抓的目錄與檔名規則
    logDir: ftpPath(env('FTP_LOG_DIR', env('FTP_ROOT', '/'))),
    pattern: env('FTP_PATTERN', '\\.(csv|log|txt|gz)$'),
    // 自動同步間隔（分鐘），0 = 不自動同步
    syncMinutes: Number(env('FTP_SYNC_MINUTES', '0')) || 0,
    // 同時開幾條 FTP 連線分析檔案
    parallel: Math.min(Math.max(Number(env('FTP_PARALLEL', '2')) || 2, 1), 6),
  },

  // PA-560 其他類型的 log（lib/paevents.js）：FTP 目錄，設成 - = 不匯入該類型；摘要存在 {PA_DATA_DIR}/events
  paEvents: {
    dirs: {
      threat: evDir('FTP_THREAT_DIR', '/threat'),
      url: evDir('FTP_URL_DIR', '/url-filtering'),
      data: evDir('FTP_DATA_FILTER_DIR', '/data-filtering'),
      wildfire: evDir('FTP_WILDFIRE_DIR', '/wildfire-submissions'),
      decryption: evDir('FTP_DECRYPTION_DIR', '/decryption'),
      globalprotect: evDir('FTP_GLOBALPROTECT_DIR', '/globalprotect'),
      userid: evDir('FTP_USERID_DIR', '/user-id'),
    },
  },

  // AD 網域控制站事件記錄：FTP {dir}/yyyyMMdd/*.csv（Security / System / Directory_Service / DNS_Server），匯入後存在 dataDir
  ad: {
    dir: ftpPath(env('FTP_AD_DIR', '/AD_Log_Backup')),
    dataDir: path.resolve(__dirname, '..', env('AD_DATA_DIR', path.join('uploads', 'adlogs'))),
  },

  // 每個 log 檔分析後的摘要（JSON，原始 log 不落地）存放位置，不隨 npm run publish 覆蓋
  dataDir: path.resolve(__dirname, '..', env('PA_DATA_DIR', path.join('uploads', 'palogs'))),
  // 跳轉到其他系統（同步登入）：寫一筆同步碼到 PortalSolar.dbo.SyncLoginInfo（SyncParagram = 對方系統代碼），開啟 {url}/SyncLogin?SyncCode=...
  jumps: {
    veeam: { url: env('VEEAM_URL', 'https://gsmc-web.gigasolar.com.tw/Veeam').replace(/\/+$/, ''), paragram: env('VEEAM_SYNC_PARAGRAM', 'Veeam') },
  },

  // 知識庫：管理者請 AI 記錄的筆記（.md），AI 問答 / 分析時當參考；不隨 npm run publish 覆蓋
  kbDir: path.resolve(__dirname, '..', env('KB_DIR', path.join('uploads', 'knowledge'))),
  kbAdmins: list('KB_ADMINS'),
  // 每次送給 AI 的筆記最多幾個字（筆記全部帶入、相關的在前，超過的只列標題）
  kbMaxChars: Number(env('KB_MAX_CHARS', '20000')) || 20000,

  // 知識庫向量資料庫：Qdrant（10.10.130.46）+ embedding（10.10.130.45:8081 Qwen3-Embedding-8B）；url 空白 = 不使用
  qdrant: {
    url: env('QDRANT_URL').replace(/\/+$/, ''),
    apiKey: env('QDRANT_API_KEY'),
    collection: env('QDRANT_COLLECTION', 'NetOpsKb'),
    embedUrl: env('EMBED_URL', 'http://10.10.130.45:8081/v1').replace(/\/+$/, ''),
  },

  // 外部 IP 自動學習：查 RDAP / DNS 反查後請 AI 整理進知識庫
  ipLearn: {
    // 每天幾點自動跑（0～23），-1 = 不自動（知識庫頁可手動執行）
    hour: /^-?\d+$/.test(env('IPLEARN_HOUR', '3')) ? Number(env('IPLEARN_HOUR', '3')) : 3,
    // 看最近幾天的 log、一次最多查幾個新 IP、查過的 IP 幾天內不重查
    days: Number(env('IPLEARN_DAYS', '7')) || 7,
    max: Number(env('IPLEARN_MAX', '150')) || 150,
    ttlDays: Number(env('IPLEARN_TTL_DAYS', '90')) || 90,
  },

  // 明細查詢：一次最多回傳幾筆、最多掃描幾秒
  searchLimit: Number(env('PA_SEARCH_LIMIT', '2000')) || 2000,
  searchSeconds: Number(env('PA_SEARCH_SECONDS', '180')) || 180,

  // AI 分析：公司內部 vLLM（OpenAI 相容 API），模型空白 = 自動取 /v1/models 的第一個
  llm: {
    url: env('LLM_URL', 'http://10.10.130.45:8080/v1').replace(/\/+$/, ''),
    model: env('LLM_MODEL'),
    apiKey: env('LLM_API_KEY'),
    // 單次分析最多等多久（毫秒），深入思考會比較久
    timeoutMs: Number(env('LLM_TIMEOUT_MS', '300000')) || 300000,
  },

  // 翻譯：與 AiService 會議翻譯相同，用 10.10.130.45 的 Qwen（關閉思考模式、翻譯專用提示）；空白 = 沿用 LLM_URL / LLM_MODEL
  translate: {
    url: (env('TRANSLATE_URL') || env('LLM_URL', 'http://10.10.130.45:8080/v1')).replace(/\/+$/, ''),
    model: env('TRANSLATE_MODEL') || env('LLM_MODEL'),
  },

  db: {
    server: env('DB_SERVER'),
    user: env('DB_USER'),
    password: env('DB_PWD'),
    database: env('DB_NAME', 'PortalSolar'),
  },
}

/**
 * 設定:Gateway 相關(GW_ENV、SERVICE_CODE、GW_BASE_URL、API Key…)由 SDK loadGatewayEnv 讀取,
 * 本檔補上服務自己的設定(資料目錄、FTP、明細查詢、背景同步)。部署區差異見 AGENT.md §6;
 * 缺少必要設定時啟動失敗,不加預設值繞過(test / prod 的資料目錄與 FTP 都必填)。
 * 機密一律讀 <NAME>_FILE(Docker secret);dev / test 可用明文 <NAME>,正式區只接受 _FILE(同 SDK 的 GW_API_KEY)。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayEnvError, isGatewayPort, loadGatewayEnv, loadMonitorEnv, type GatewayEnv, type GwEnv, type MonitorEnv } from '@giganexus/backend-sdk';

/** 服務代碼與 port(ARCHITECTURE D1、Gateway BACKEND-GUIDE §3.3) */
export const SERVICE_CODE = 'netops-api';
export const DEFAULT_PORT = 51292;

/** PA 其他類型 log 的 FTP 目錄(舊版 server/config.js 的預設值);設成 - 表示不匯入該類型 */
export const EVENT_DIR_ENV = {
  threat: ['FTP_THREAT_DIR', '/threat'],
  url: ['FTP_URL_DIR', '/url-filtering'],
  data: ['FTP_DATA_FILTER_DIR', '/data-filtering'],
  wildfire: ['FTP_WILDFIRE_DIR', '/wildfire-submissions'],
  decryption: ['FTP_DECRYPTION_DIR', '/decryption'],
  globalprotect: ['FTP_GLOBALPROTECT_DIR', '/globalprotect'],
  userid: ['FTP_USERID_DIR', '/user-id'],
} as const;
export type EventType = keyof typeof EVENT_DIR_ENV;

export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /** FTPS(explicit TLS);預設一般 FTP */
  secure: boolean;
  /** FTPS 時是否接受自簽憑證(FTP_TLS_INSECURE=1);預設驗證憑證 */
  tlsInsecure: boolean;
  /** 畫面上只能瀏覽這個目錄以下 */
  root: string;
  /** PA TRAFFIC log 目錄與檔名規則 */
  logDir: string;
  pattern: RegExp;
  /** PA 其他類型 log 的目錄;空字串 = 不匯入 */
  eventDirs: Record<EventType, string>;
  /** AD 事件匯出目錄({dir}/yyyyMMdd/*.csv) */
  adDir: string;
  /** 本服務同時開啟的 FTP 連線上限(匯入與明細查詢共用;AGENT.md §6:test 1、prod 2) */
  maxConnections: number;
  /** 自動同步間隔(分鐘),0 = 不自動同步 */
  syncMinutes: number;
}

/**
 * AI(IMPL-PLAN A1、ARCHITECTURE D23、PA-LIVE-PLAN §6):直接呼叫 AI 主機,位址只從設定讀(AGENT.md §7.4)
 *   LLM_URL 空白 = 不提供 AI 分析 / 問答 / 外部 IP 自動學習(API 回 409 NETOPS_AI_DISABLED);QDRANT_URL 空白 = 不使用向量庫
 */
export interface AiConfig {
  llm: { url: string; model: string; apiKey: string; timeoutMs: number };
  vector: { url: string; apiKey: string; collection: string; embedUrl: string };
  /**
   * 是否把筆記寫進向量庫(VECTOR_SYNC=1)。預設關閉:舊版 IIS 仍在同步同一個 collection(NetOpsKb),
   * 兩邊都同步會互相刪除對方的筆記;關閉時只做語意搜尋(與舊版不同,D18 切換時再開)
   */
  vectorSync: boolean;
  /** 外部 IP 自動學習(D10):每天幾點自動跑(-1 = 不自動,預設)、看最近幾天、一次最多查幾個新 IP、查過的 IP 幾天內不重查 */
  ipLearn: { hour: number; days: number; max: number; ttlDays: number };
  /** 每次送給 AI 的知識庫筆記最多幾個字(同舊版 KB_MAX_CHARS) */
  kbMaxChars: number;
  /** 同時進行的 AI 串流上限:全系統、每人(超過回 429,不回 5xx;S0 報告 §3.6) */
  maxStreams: number;
  maxStreamsPerUser: number;
}

export interface Config {
  gateway: GatewayEnv;
  /** giga-observe 監控(MONITOR_URL、MONITOR_API_KEY_FILE;dev 預設關閉) */
  monitor: MonitorEnv;
  port: number;
  logLevel: string;
  /** 資料目錄(摘要、統計、AD 事件、知識庫);只經 infra/store 存取(ARCHITECTURE D8) */
  dataDir: string;
  /** dev 未設定 FTP_HOST 時為 null(FTP 相關功能回 503);test / prod 必填 */
  ftp: FtpConfig | null;
  /** 明細查詢:一次最多幾筆、最多掃描幾秒(工作模式,ARCHITECTURE D6) */
  search: { limit: number; seconds: number };
  ai: AiConfig;
  /** PA 即時監控的 netops-redis(R1,只讀);dev 未設定時為 null(即時監控回 424 / unavailable),test / prod 必填 */
  redisUrl: string | null;
}

/** 空字串視同未設定(Compose 的 ${X:-} 會傳空字串) */
const str = (env: NodeJS.ProcessEnv, key: string, fallback = ''): string => env[key]?.trim() || fallback;

/** FTP 路徑:一律以 / 開頭、結尾不帶 /(根目錄為 /);.. 先正規化掉 */
export const ftpPath = (p: string): string => path.posix.normalize('/' + p.replace(/\\/g, '/')).replace(/\/+$/, '') || '/';

/** 是否在 root 之下(含 root 本身) */
const under = (p: string, root: string) => root === '/' || p === root || p.startsWith(root + '/');

/** 整數設定;不是整數或超出範圍時啟動失敗 */
function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = str(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new GatewayEnvError(`${key} 必須是 ${min}–${max} 的整數:${raw}`);
  return n;
}

/** 開關:只接受 1 / 0 / true / false,其他值啟動失敗(避免寫錯時悄悄關掉加密) */
function bool(env: NodeJS.ProcessEnv, key: string): boolean {
  const raw = str(env, key).toLowerCase();
  if (!raw || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  throw new GatewayEnvError(`${key} 只能是 1 / 0 / true / false:${raw}`);
}

/**
 * 機密:<NAME>_FILE 優先;dev / test 可用明文 <NAME>,正式區只接受 _FILE。
 * 讀不到檔案時啟動失敗(訊息不含機密內容)。
 */
export function readSecret(env: NodeJS.ProcessEnv, name: string, gwEnv: GwEnv): string {
  // 正式區連同時設定明文也拒絕:明文會留在容器環境變數(docker inspect 看得到)
  if (str(env, name) && gwEnv === 'prod') throw new GatewayEnvError(`正式區不可用 ${name} 明文設定,請改用 ${name}_FILE(Docker secret)`);
  const file = str(env, `${name}_FILE`);
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new GatewayEnvError(`無法讀取 ${name}_FILE:${(err as NodeJS.ErrnoException).code ?? 'ERROR'}`);
    }
  }
  return str(env, name);
}

function loadFtp(env: NodeJS.ProcessEnv, gwEnv: GwEnv): FtpConfig | null {
  const host = str(env, 'FTP_HOST');
  const user = str(env, 'FTP_USER');
  const password = readSecret(env, 'FTP_PASSWORD', gwEnv);
  if (gwEnv !== 'dev') {
    const missing = [!host && 'FTP_HOST', !user && 'FTP_USER', !password && 'FTP_PASSWORD_FILE'].filter(Boolean);
    if (missing.length) throw new GatewayEnvError(`${gwEnv} 缺少必要設定:${missing.join('、')}`);
  }
  if (!host) return null;
  const pattern = str(env, 'FTP_PATTERN', '\\.(csv|log|txt|gz)$');
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    throw new GatewayEnvError(`FTP_PATTERN 不是正確的正規表示式:${pattern}`);
  }
  const root = ftpPath(str(env, 'FTP_ROOT', '/'));
  const eventDirs = Object.fromEntries(
    Object.entries(EVENT_DIR_ENV).map(([type, [key, def]]) => {
      const v = str(env, key, def);
      return [type, v === '-' ? '' : ftpPath(v)];
    }),
  ) as Record<EventType, string>;
  const logDir = ftpPath(str(env, 'FTP_LOG_DIR', root));
  const adDir = ftpPath(str(env, 'FTP_AD_DIR', '/AD_Log_Backup'));
  // 所有匯入目錄都要在可瀏覽的根目錄之下,否則畫面看不到、刪除也找不到
  const dirs: [string, string][] = [['FTP_LOG_DIR', logDir], ['FTP_AD_DIR', adDir], ...Object.entries(EVENT_DIR_ENV).map(([t, [key]]): [string, string] => [key, eventDirs[t as EventType]])];
  const outside = dirs.filter(([, dir]) => dir && !under(dir, root));
  if (outside.length) throw new GatewayEnvError(`${outside.map(([k]) => k).join('、')} 必須在 FTP_ROOT(${root})之下`);
  const tlsInsecure = bool(env, 'FTP_TLS_INSECURE');
  if (tlsInsecure && gwEnv === 'prod') throw new GatewayEnvError('正式區不可設定 FTP_TLS_INSECURE');
  return {
    host,
    port: int(env, 'FTP_PORT', 21, 1, 65535),
    user,
    password,
    secure: bool(env, 'FTP_SECURE'),
    tlsInsecure,
    root,
    logDir,
    pattern: re,
    eventDirs,
    adDir,
    maxConnections: int(env, 'FTP_MAX_CONNECTIONS', 1, 1, 6),
    syncMinutes: int(env, 'FTP_SYNC_MINUTES', 0, 0, 1440),
  };
}

/** http(s) URL,結尾的 / 拿掉;空字串 = 未設定;格式錯誤啟動失敗 */
function url(env: NodeJS.ProcessEnv, key: string): string {
  const raw = str(env, key).replace(/\/+$/, '');
  if (!raw) return '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GatewayEnvError(`${key} 不是正確的網址:${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new GatewayEnvError(`${key} 只接受 http / https:${raw}`);
  if (u.username || u.password) throw new GatewayEnvError(`${key} 不可帶帳密,請改用對應的 *_API_KEY_FILE`);
  return raw;
}

function loadAi(env: NodeJS.ProcessEnv, gwEnv: GwEnv): AiConfig {
  const llmUrl = url(env, 'LLM_URL');
  const qdrantUrl = url(env, 'QDRANT_URL');
  const embedUrl = url(env, 'EMBED_URL');
  // 只設 Qdrant 沒設 embedding 時,語意搜尋一定失敗;啟動就擋下(舊版預設寫死 .45:8081)
  if (qdrantUrl && !embedUrl) throw new GatewayEnvError('有設定 QDRANT_URL 時必須設定 EMBED_URL');
  const collection = str(env, 'QDRANT_COLLECTION', 'NetOpsKb');
  if (!/^[\w-]{1,64}$/.test(collection)) throw new GatewayEnvError(`QDRANT_COLLECTION 只能是英數、底線與 -:${collection}`);
  return {
    llm: { url: llmUrl, model: str(env, 'LLM_MODEL'), apiKey: readSecret(env, 'LLM_API_KEY', gwEnv), timeoutMs: int(env, 'LLM_TIMEOUT_MS', 300000, 10000, 600000) },
    vector: { url: qdrantUrl, apiKey: readSecret(env, 'QDRANT_API_KEY', gwEnv), collection, embedUrl },
    vectorSync: bool(env, 'VECTOR_SYNC'),
    ipLearn: { hour: int(env, 'IPLEARN_HOUR', -1, -1, 23), days: int(env, 'IPLEARN_DAYS', 7, 1, 60), max: int(env, 'IPLEARN_MAX', 150, 1, 500), ttlDays: int(env, 'IPLEARN_TTL_DAYS', 90, 1, 3650) },
    kbMaxChars: int(env, 'KB_MAX_CHARS', 20000, 1000, 200000),
    maxStreams: int(env, 'AI_MAX_STREAMS', 6, 1, 50),
    maxStreamsPerUser: int(env, 'AI_MAX_STREAMS_PER_USER', 2, 1, 10),
  };
}

/** netops-redis 位址(R1):test / prod 必填;只接受 redis:// 或 rediss:// */
function loadRedisUrl(env: NodeJS.ProcessEnv, gwEnv: GwEnv): string | null {
  const url = str(env, 'REDIS_URL');
  if (!url) {
    if (gwEnv !== 'dev') throw new GatewayEnvError(`${gwEnv} 缺少必要設定:REDIS_URL`);
    return null;
  }
  if (!/^rediss?:\/\//.test(url)) throw new GatewayEnvError('REDIS_URL 必須以 redis:// 或 rediss:// 開頭');
  return url;
}

/** 資料目錄:test / prod 必填且為絕對路徑;dev 未設定時用本機暫存目錄(AGENT.md §6) */
function loadDataDir(env: NodeJS.ProcessEnv, gwEnv: GwEnv): string {
  const dir = str(env, 'NETOPS_DATA_DIR');
  if (!dir) {
    if (gwEnv !== 'dev') throw new GatewayEnvError(`${gwEnv} 缺少必要設定:NETOPS_DATA_DIR`);
    return path.join(os.tmpdir(), 'giga-netops-dev');
  }
  if (!path.isAbsolute(dir)) throw new GatewayEnvError(`NETOPS_DATA_DIR 必須是絕對路徑:${dir}`);
  return path.resolve(dir);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd?: string): Config {
  const gateway = loadGatewayEnv(env, cwd);
  // 服務代碼同時是內部 Token 的 aud;設錯會讓所有請求 401,啟動時就擋下
  if (gateway.serviceCode !== SERVICE_CODE) throw new Error(`SERVICE_CODE 必須是 ${SERVICE_CODE}:${gateway.serviceCode}`);
  const port = Number(env.PORT ?? DEFAULT_PORT);
  if (!isGatewayPort(port)) throw new Error(`PORT 必須在 51200–51300(BACKEND-GUIDE.md §3):${env.PORT}`);
  return {
    gateway,
    monitor: loadMonitorEnv(gateway.gwEnv, env),
    port,
    logLevel: env.LOG_LEVEL ?? (gateway.gwEnv === 'dev' ? 'debug' : 'info'),
    dataDir: loadDataDir(env, gateway.gwEnv),
    ftp: loadFtp(env, gateway.gwEnv),
    // 掃描秒數上限 600:工作模式不受路由逾時限制,但仍要有上限(AGENT.md §7.3)
    search: { limit: int(env, 'PA_SEARCH_LIMIT', 2000, 1, 10000), seconds: int(env, 'PA_SEARCH_SECONDS', 180, 10, 600) },
    ai: loadAi(env, gateway.gwEnv),
    redisUrl: loadRedisUrl(env, gateway.gwEnv),
  };
}

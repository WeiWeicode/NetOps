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
}

/** 空字串視同未設定(Compose 的 ${X:-} 會傳空字串) */
const str = (env: NodeJS.ProcessEnv, key: string, fallback = ''): string => env[key]?.trim() || fallback;

/** FTP 路徑:一律以 / 開頭、結尾不帶 /(根目錄為 /) */
export const ftpPath = (p: string): string => ('/' + p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).replace(/\/{2,}/g, '/');

/** 整數設定;不是整數或超出範圍時啟動失敗 */
function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = str(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new GatewayEnvError(`${key} 必須是 ${min}–${max} 的整數:${raw}`);
  return n;
}

/**
 * 機密:<NAME>_FILE 優先;dev / test 可用明文 <NAME>,正式區只接受 _FILE。
 * 讀不到檔案時啟動失敗(訊息不含機密內容)。
 */
export function readSecret(env: NodeJS.ProcessEnv, name: string, gwEnv: GwEnv): string {
  const file = str(env, `${name}_FILE`);
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (err) {
      throw new GatewayEnvError(`無法讀取 ${name}_FILE:${(err as NodeJS.ErrnoException).code ?? 'ERROR'}`);
    }
  }
  if (str(env, name) && gwEnv === 'prod') throw new GatewayEnvError(`正式區不可用 ${name} 明文設定,請改用 ${name}_FILE(Docker secret)`);
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
  return {
    host,
    port: int(env, 'FTP_PORT', 21, 1, 65535),
    user,
    password,
    secure: str(env, 'FTP_SECURE') === '1',
    tlsInsecure: str(env, 'FTP_TLS_INSECURE') === '1',
    root,
    logDir: ftpPath(str(env, 'FTP_LOG_DIR', root)),
    pattern: re,
    eventDirs,
    adDir: ftpPath(str(env, 'FTP_AD_DIR', '/AD_Log_Backup')),
    maxConnections: int(env, 'FTP_MAX_CONNECTIONS', 1, 1, 6),
    syncMinutes: int(env, 'FTP_SYNC_MINUTES', 0, 0, 1440),
  };
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
  };
}

/**
 * netops-ingest 設定(C2;deploy/docker-compose.yml 的 netops-ingest)。缺少必要設定時啟動失敗,不加預設值繞過(AGENT.md §6)。
 *   GW_ENV                    dev / test / prod
 *   REDIS_URL                 redis://netops-redis:6379/0
 *   CLICKHOUSE_URL            http://netops-clickhouse:8123(只在 Compose 內部網路)
 *   CLICKHOUSE_USER           netops_writer
 *   CLICKHOUSE_PASSWORD_FILE  Docker secret ch_writer_password(正式區只接受 _FILE;dev / test 可用明文 CLICKHOUSE_PASSWORD)
 *   INGEST_BATCH_SECONDS      一批最長等待秒數,3–5(預設 5,C1 報告 §9-2)
 *   INGEST_BATCH_MAX          每種類型一批最多筆數(100–5000,預設 5000;容器 256m,資安審查 M1)
 *   兩次啟動之間不要改批次設定:待處理清單的切法要和當機前相同,去重 token 才對得上
 *   RELEASE_SHA               寫進心跳(哪一版在跑)
 *   FTP_HOST、FTP_USER、FTP_PASSWORD_FILE、FTP_ROOT…  FTP 補漏(C3;同 netops-api 的設定,只讀)。沒有設定 FTP_HOST 時不執行補漏工作
 * 冷歸檔(C4,手冊 §8;NETOPS_ARCHIVE_ENABLED=1 才執行):
 *   INGEST_ARCHIVE_DIR              NAS 掛載點(預設 /archive;要有標記檔 .giga-netops-archive 才寫)
 *   INGEST_ARCHIVE_STAGING          本機暫存(預設 /var/lib/netops-ingest/staging,WSL 磁碟的 volume)
 *   INGEST_ARCHIVE_KEEP_DAYS        保留天數:測試區 / 本機預設 14;正式區預設 0(不刪),設定時至少 366(CQ12:Parquet 至少 1 年)
 *   INGEST_ARCHIVE_ALERT_DAYS       前一天起算第幾天還沒成功就告警(預設 min(25, TRAFFIC 保留天數 − 1))
 *   CLICKHOUSE_COLD_USER / CLICKHOUSE_COLD_PASSWORD_FILE  讀回核對 Parquet 列數(netops_cold;只有它能用 file())
 *   NETOPS_TTL_TRAFFIC_DAYS / NETOPS_TTL_THREAT_DAYS      原始表保留天數(重試範圍;同 netops-api)
 */
import type { GwEnv } from '@giganexus/backend-sdk';
import { archiveEnabled, loadFtp, loadPaTtlDays, readSecret, type FtpConfig } from '../config.js';
import type { ArchiveKind } from '../infra/clickhouse/archive.js';
import { defaultAlertDays } from './archive.js';

export interface IngestConfig {
  gwEnv: GwEnv;
  redisUrl: string;
  clickhouse: { url: string; user: string; password: string };
  batchMs: number;
  batchMax: number;
  release: string;
  /** FTP 補漏(C3);null = 不執行補漏 */
  ftp: FtpConfig | null;
  /** 冷歸檔(C4);null = 不執行 */
  archive: ArchiveConfig | null;
}

export interface ArchiveConfig {
  dir: string;
  staging: string;
  keepDays: number;
  alertDays: number;
  ttlDays: Record<ArchiveKind, number>;
  cold: { url: string; user: string; password: string };
}

export class IngestConfigError extends Error {}

const str = (env: NodeJS.ProcessEnv, k: string) => (env[k] ?? '').trim();

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = str(env, key);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new IngestConfigError(`${key} 必須是 ${min}–${max} 的整數:${raw}`);
  return n;
}

export function loadIngestConfig(env: NodeJS.ProcessEnv = process.env): IngestConfig {
  const gwEnv = str(env, 'GW_ENV');
  if (gwEnv !== 'dev' && gwEnv !== 'test' && gwEnv !== 'prod') throw new IngestConfigError(`GW_ENV 只能是 dev / test / prod:${gwEnv || '(未設定)'}`);
  const redisUrl = str(env, 'REDIS_URL');
  if (!/^rediss?:\/\//.test(redisUrl)) throw new IngestConfigError('REDIS_URL 必須設定,且以 redis:// 或 rediss:// 開頭');
  const url = str(env, 'CLICKHOUSE_URL');
  if (!/^https?:\/\//.test(url)) throw new IngestConfigError('CLICKHOUSE_URL 必須設定,且以 http:// 或 https:// 開頭');
  const user = str(env, 'CLICKHOUSE_USER');
  if (!/^[\w-]{1,64}$/.test(user)) throw new IngestConfigError('CLICKHOUSE_USER 必須設定(英數、底線、-)');
  let password: string;
  try {
    password = readSecret(env, 'CLICKHOUSE_PASSWORD', gwEnv);
  } catch (e) {
    throw new IngestConfigError((e as Error).message);
  }
  if (!password) throw new IngestConfigError('缺少 CLICKHOUSE_PASSWORD_FILE');
  return {
    gwEnv,
    redisUrl,
    clickhouse: { url, user, password },
    batchMs: int(env, 'INGEST_BATCH_SECONDS', 5, 3, 5) * 1000,
    batchMax: int(env, 'INGEST_BATCH_MAX', 5000, 100, 5000),
    release: str(env, 'RELEASE_SHA').slice(0, 40) || 'dev',
    ftp: loadIngestFtp(env, gwEnv),
    archive: loadArchive(env, gwEnv, url),
  };
}

const absDir = (env: NodeJS.ProcessEnv, k: string, fallback: string) => {
  const v = str(env, k) || fallback;
  if (!v.startsWith('/') || v.split('/').includes('..')) throw new IngestConfigError(`${k} 必須是絕對路徑:${v}`);
  return v;
};

function loadArchive(env: NodeJS.ProcessEnv, gwEnv: GwEnv, chUrl: string): ArchiveConfig | null {
  let enabled: boolean;
  let ttlDays: Record<ArchiveKind, number>;
  try {
    enabled = archiveEnabled(env);
    ttlDays = loadPaTtlDays(env, gwEnv);
  } catch (e) {
    throw new IngestConfigError((e as Error).message);
  }
  if (!enabled) return null;
  const keepDays = int(env, 'INGEST_ARCHIVE_KEEP_DAYS', gwEnv === 'prod' ? 0 : 14, 0, 3650);
  // 正式區 Parquet 至少保留 1 年(CQ12)
  if (gwEnv === 'prod' && keepDays > 0 && keepDays < 366) throw new IngestConfigError(`正式區 INGEST_ARCHIVE_KEEP_DAYS 只能是 0(不刪)或至少 366(CQ12):${keepDays}`);
  let password: string;
  try {
    password = readSecret(env, 'CLICKHOUSE_COLD_PASSWORD', gwEnv);
  } catch (e) {
    throw new IngestConfigError((e as Error).message);
  }
  if (!password) throw new IngestConfigError('NETOPS_ARCHIVE_ENABLED=1 時必須設定 CLICKHOUSE_COLD_PASSWORD_FILE');
  const user = str(env, 'CLICKHOUSE_COLD_USER') || 'netops_cold';
  if (!/^[\w-]{1,64}$/.test(user)) throw new IngestConfigError('CLICKHOUSE_COLD_USER 只能是英數、底線、-');
  return {
    dir: absDir(env, 'INGEST_ARCHIVE_DIR', '/archive'),
    staging: absDir(env, 'INGEST_ARCHIVE_STAGING', '/var/lib/netops-ingest/staging'),
    keepDays,
    alertDays: int(env, 'INGEST_ARCHIVE_ALERT_DAYS', defaultAlertDays(ttlDays.traffic), 1, 3650),
    ttlDays,
    cold: { url: chUrl, user, password },
  };
}

/** FTP 補漏只在設定 FTP_HOST 時啟用(netops-api 的 loadFtp 在 test / prod 要求必填,這裡改成選填) */
function loadIngestFtp(env: NodeJS.ProcessEnv, gwEnv: GwEnv): FtpConfig | null {
  if (!str(env, 'FTP_HOST')) return null;
  try {
    // 補漏一次只開 1 條 FTP 連線
    return loadFtp({ ...env, FTP_MAX_CONNECTIONS: '1', FTP_SYNC_MINUTES: '0' }, gwEnv);
  } catch (e) {
    throw new IngestConfigError((e as Error).message);
  }
}

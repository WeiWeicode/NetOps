/**
 * 時段明細的冷路由(C4 / V-a 第 5 步;ARCHITECTURE D35、docs/VIZ-RULES-DESIGN.md §4.3):讀 NAS 上的 Parquet 歸檔。
 *   - 先查歸檔紀錄(netops.pa_archive_manifest):期間涵蓋的每一天都要歸檔成功,缺任何一天回 404 NETOPS_COLD_ARCHIVE_NOT_FOUND
 *     (details.missing 列出哪一天、哪一類、狀態;不回傳檔案路徑)。TRAFFIC 明細另外要威脅歸檔(摘要列的威脅數)
 *   - 查詢和熱路由同一份條件與運算式(heat.ts runSlice),資料來源換成 Parquet 子查詢(archive.ts coldSource);帳號 netops_cold
 *   - 冷查詢全系統 1 個、30 秒同步 / 轉工作由 service.ts 處理;這裡只負責查詢與錯誤對應
 * ClickHouse 找不到檔案(檔案被刪、NAS 沒掛上)也回 404;其他錯誤 503 NETOPS_CLICKHOUSE_UNAVAILABLE(原文只寫日誌)。
 */
import { AppError } from '../../errors.js';
import { coldSource, daysCovering, type ArchiveKind, type ColdFileClient, type ManifestEntry } from '../../infra/clickhouse/archive.js';
import { runSlice } from '../../infra/clickhouse/heat.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import { unavailable } from '../pa/ch-overview.js';
import type { ColdSlice } from './service.js';

/** 冷查詢單一查詢上限(netops_cold constraints 最多 50 秒) */
const COLD_CH_SECONDS = 50;
/** FILE_DOESNT_EXIST、CANNOT_EXTRACT_TABLE_STRUCTURE(檔案不存在時 file() 推不出欄位) */
const NOT_FOUND_CODES = new Set([107, 636]);

export interface MissingDay {
  type: ArchiveKind;
  day: string;
  /** missing = 沒有歸檔紀錄;failed = 歸檔失敗(重試中);expired = 已超過歸檔保留期限;unreadable = 紀錄成功但檔案讀不到 */
  status: 'missing' | 'failed' | 'expired' | 'unreadable';
}

const LABEL: Record<MissingDay['status'], string> = { missing: '尚未歸檔', failed: '歸檔失敗', expired: '已超過歸檔保留期限', unreadable: '檔案讀不到(NAS 未掛載或檔案遺失)' };

export function notFound(missing: MissingDay[]): AppError {
  const first = missing[0]!;
  return new AppError(404, 'NETOPS_COLD_ARCHIVE_NOT_FOUND', `${first.day} 的冷歸檔${LABEL[first.status]},查不到這段時間的明細(可改查熱力圖格子的彙總)`, { missing });
}

/** 需要的歸檔是否都成功;缺的列出來 */
export function missingDays(entries: readonly ManifestEntry[], kinds: readonly ArchiveKind[], days: readonly string[]): MissingDay[] {
  const out: MissingDay[] = [];
  for (const kind of kinds)
    for (const day of days) {
      const e = entries.find((x) => x.kind === kind && x.day === day);
      if (e?.status !== 'ok') out.push({ type: kind, day, status: e?.status === 'failed' || e?.status === 'expired' ? e.status : 'missing' });
    }
  return out;
}

export function createColdSlice(client: ColdFileClient, log: { warn(o: object, m: string): void }): ColdSlice {
  const chFail = (err: unknown, missing: () => MissingDay[]): never => {
    if (!(err instanceof ClickHouseError)) throw err;
    if (err.code !== undefined && NOT_FOUND_CODES.has(err.code)) throw notFound(missing());
    log.warn({ code: err.code, status: err.status }, 'ClickHouse 冷資料查詢失敗');
    throw unavailable({ code: err.code, status: err.status });
  };
  return {
    async query(type, f, rowsLimit, sort, signal) {
      const days = daysCovering(f.fromMs, f.toMs);
      const kinds: ArchiveKind[] = type === 'traffic' ? ['traffic', 'threat'] : ['threat'];
      let entries: ManifestEntry[] = [];
      try {
        entries = await client.manifest(days);
      } catch (err) {
        chFail(err, () => []);
      }
      const missing = missingDays(entries, kinds, days);
      if (missing.length) throw notFound(missing);
      try {
        return await runSlice(client.rows, { traffic: coldSource('traffic', days), threat: coldSource('threat', days) }, type, f, rowsLimit, sort, COLD_CH_SECONDS, signal);
      } catch (err) {
        // 紀錄說成功、檔案卻讀不到(被手動刪除、NAS 沒掛上)
        return chFail(err, () => kinds.flatMap((k) => days.map((day) => ({ type: k, day, status: 'unreadable' as const }))));
      }
    },
  };
}

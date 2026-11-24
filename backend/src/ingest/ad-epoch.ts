/**
 * FTP 補寫列的 Event Log 世代(log_epoch)判定與「能不能寫」(AD-3;需求方 2026-11-24 D1「CSV 分段錨定 + 水位保護」、D2、D5)。純函式。
 *
 * 同一台 DC、同一個記錄(channel)的 CSV 列:
 *   1. 分段:依 (時間, RecordID) 排序,RecordID 變小的地方切段;一段 = 一個實體 Event Log 世代(清除重編號後是新的一段)。
 *   2. 錨定:段內有任何一列在 ClickHouse 找得到 Agent 列「RecordID、時間(秒)、EventID 都相同」→ 該段的世代 = 那筆 Agent 列的 log_epoch。
 *   3. 沒有錨點的段:
 *      - 這台 DC 這個記錄在 ClickHouse 完全沒有 Agent 列 → 世代 0,全部可補(D2:未裝 Agent 的 DC)。
 *      - 有 Agent 資料:取段開始之前最近一筆 Agent 列(prev);段的最小 RecordID > prev 的 RecordID(同一世代 RecordID 隨時間遞增)→ prev 的世代。
 *        沒有 prev 時取段結束之後最早一筆 Agent 列(next);段的最大 RecordID < next 的 RecordID → next 的世代(Agent 安裝前的同一份 log)。
 *        都不成立(中間被清除重編號、無法確定)→ ambiguous,不寫(D1)。
 *   4. 水位保護:世代 e 是該記錄目前最新的世代時,只補 RecordID ≤ H(e) 的列,H(e) = ClickHouse 該世代 Agent 已寫入的最大 RecordID
 *      (不用接收端水位:它在收到時就前進,事件可能還在 Stream,先補會重複;netops-redis 沒有 ACL,竄改後缺口永遠補不回來
 *       (程式碼審查 M2、資安審查 M1)。同一個 Stream 依序寫入,ClickHouse 有 X 就表示 X 之前收到的都已寫入;Redis 遺失的事件也因此能由 FTP 補回);
 *      更大的列 Agent 之後還會送(接收端不知道 FTP 補寫過,先補會重複),標 waiting,隔天對帳再看(D1、D5)。
 *      e 比目前世代舊時 Agent 已換世代,不會再送舊世代 → 不受水位限制。
 */

export interface CsvRow {
  /** Unix 秒(台灣時間解析) */
  t: number;
  /** RecordID(安全整數) */
  rid: number;
  eventId: number;
}

export interface AgentRef {
  epoch: number;
  rid: number;
}

export interface EpochContext {
  /** 這台 DC 這個記錄在 ClickHouse 有沒有 Agent 列 */
  hasAgent: boolean;
  /** 錨點:`${rid}|${t}|${eventId}` → Agent 列的世代 */
  anchors: Map<string, number>;
  /** 段開始(Unix 秒)之前最近一筆 Agent 列 */
  prevAgent: (t: number) => AgentRef | null;
  /** 段結束(Unix 秒)之後最早一筆 Agent 列 */
  nextAgent: (t: number) => AgentRef | null;
  /** 世代 → 有效水位 H(e)(ClickHouse Agent 已寫入的最大 RecordID) */
  watermark: Map<number, number>;
}

export type RowDecision = { kind: 'write'; epoch: number } | { kind: 'waiting'; epoch: number } | { kind: 'ambiguous' };

export interface Segment {
  rows: CsvRow[];
  epoch: number | null;
  /** 世代怎麼決定的(測試與日誌用) */
  by: 'anchor' | 'no-agent' | 'prev' | 'next' | 'ambiguous';
}

export const anchorKey = (rid: number, t: number, eventId: number) => `${rid}|${t}|${eventId}`;

/** RecordID 與事件時間的小幅倒序容許量(寫入順序 ≠ 產生時間;程式碼審查 H1) */
export const REORDER_TOLERANCE = 10_000;

/**
 * 依 (時間, RecordID) 排序後切段。RecordID 是寫入順序、時間是事件產生時間,忙碌的記錄常有小幅倒序,不能一變小就切:
 * 只有「比段內最大值小超過 REORDER_TOLERANCE」或「小於段內最小值的一半」(清除後從 1 重新編號)才視為新的一段
 */
export function splitSegments(rows: readonly CsvRow[]): CsvRow[][] {
  const sorted = [...rows].sort((a, b) => a.t - b.t || a.rid - b.rid);
  const out: CsvRow[][] = [];
  let cur: CsvRow[] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const r of sorted) {
    if (cur.length && r.rid < max && (max - r.rid > REORDER_TOLERANCE || r.rid < min / 2)) {
      out.push(cur);
      cur = [];
      min = Infinity;
      max = -Infinity;
    }
    cur.push(r);
    min = Math.min(min, r.rid);
    max = Math.max(max, r.rid);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 迴圈計算 min/max RecordID(避免 Math.min(...arr) 超過 ~10 萬筆觸發 V8 RangeError;審查 M1) */
export function ridBounds(rows: readonly { rid: number }[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (r.rid < min) min = r.rid;
    if (r.rid > max) max = r.rid;
  }
  return [min, max];
}

/** 每一段的世代 */
export function segmentEpochs(rows: readonly CsvRow[], ctx: EpochContext): Segment[] {
  return splitSegments(rows).map((seg) => {
    for (const r of seg) {
      const e = ctx.anchors.get(anchorKey(r.rid, r.t, r.eventId));
      if (e !== undefined) return { rows: seg, epoch: e, by: 'anchor' as const };
    }
    if (!ctx.hasAgent) return { rows: seg, epoch: 0, by: 'no-agent' as const };
    const [minRid, maxRid] = ridBounds(seg);
    const prev = ctx.prevAgent(seg[0]!.t);
    if (prev) return prev.rid < minRid ? { rows: seg, epoch: prev.epoch, by: 'prev' as const } : { rows: seg, epoch: null, by: 'ambiguous' as const };
    const next = ctx.nextAgent(seg[seg.length - 1]!.t);
    if (next && maxRid < next.rid) return { rows: seg, epoch: next.epoch, by: 'next' as const };
    return { rows: seg, epoch: null, by: 'ambiguous' as const };
  });
}

/** 一列能不能寫(水位保護);currentEpoch = 該記錄目前最新的世代(沒有 Agent 資料時為 null) */
export function decide(row: CsvRow, epoch: number | null, ctx: Pick<EpochContext, 'hasAgent' | 'watermark'>, currentEpoch: number | null): RowDecision {
  if (epoch === null) return { kind: 'ambiguous' };
  if (!ctx.hasAgent || currentEpoch === null || epoch < currentEpoch) return { kind: 'write', epoch };
  const h = ctx.watermark.get(epoch) ?? 0;
  return row.rid <= h ? { kind: 'write', epoch } : { kind: 'waiting', epoch };
}

/** 目前最新的世代(Agent 列的世代取最大;沒有 Agent 列為 null) */
export function currentEpochOf(watermark: Map<number, number>): number | null {
  return watermark.size ? Math.max(...watermark.keys()) : null;
}

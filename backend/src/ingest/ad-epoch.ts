/**
 * FTP 補寫列的 Event Log 世代(log_epoch)判定與「能不能寫」(AD-3;需求方 2026-11-24 D1「CSV 分段錨定 + 水位保護」、D2、D5)。純函式。
 *
 * 同一台 DC、同一個記錄(channel)的 CSV 列:
 *   1. 分段:依 (時間, RecordID) 排序,RecordID 變小的地方切段;一段 = 一個實體 Event Log 世代(清除重編號後是新的一段)。
 *   2. 錨定:段內有任何一列在 ClickHouse 找得到 Agent 列「RecordID、時間(秒)、EventID 都相同」→ 該段的世代 = 那筆 Agent 列的 log_epoch。
 *   3. 沒有錨點的段:
 *      - 這台 DC 這個記錄完全沒有 Agent 資料(沒有 Agent 列、也沒有接收端水位)→ 世代 0,全部可補(D2:未裝 Agent 的 DC)。
 *      - 有 Agent 資料:取段開始之前最近一筆 Agent 列(prev);段的最小 RecordID > prev 的 RecordID(同一世代 RecordID 隨時間遞增)→ prev 的世代。
 *        沒有 prev 時取段結束之後最早一筆 Agent 列(next);段的最大 RecordID < next 的 RecordID → next 的世代(Agent 安裝前的同一份 log)。
 *        都不成立(中間被清除重編號、無法確定)→ ambiguous,不寫(D1)。
 *   4. 水位保護:世代 e 是該記錄目前最新的世代時,只補 RecordID ≤ H(e) 的列,H(e) = max(接收端水位, ClickHouse 該世代 Agent 最大 RecordID);
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
  /** 這台 DC 這個記錄有沒有任何 Agent 資料(ClickHouse Agent 列或接收端水位) */
  hasAgent: boolean;
  /** 錨點:`${rid}|${t}|${eventId}` → Agent 列的世代 */
  anchors: Map<string, number>;
  /** 段開始(Unix 秒)之前最近一筆 Agent 列 */
  prevAgent: (t: number) => AgentRef | null;
  /** 段結束(Unix 秒)之後最早一筆 Agent 列 */
  nextAgent: (t: number) => AgentRef | null;
  /** 世代 → 有效水位 H(e)(接收端水位與 ClickHouse Agent 最大 RecordID 取大) */
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

/** 依 (時間, RecordID) 排序後在 RecordID 變小處切段 */
export function splitSegments(rows: readonly CsvRow[]): CsvRow[][] {
  const sorted = [...rows].sort((a, b) => a.t - b.t || a.rid - b.rid);
  const out: CsvRow[][] = [];
  let cur: CsvRow[] = [];
  for (const r of sorted) {
    if (cur.length && r.rid < cur[cur.length - 1]!.rid) {
      out.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 每一段的世代 */
export function segmentEpochs(rows: readonly CsvRow[], ctx: EpochContext): Segment[] {
  return splitSegments(rows).map((seg) => {
    for (const r of seg) {
      const e = ctx.anchors.get(anchorKey(r.rid, r.t, r.eventId));
      if (e !== undefined) return { rows: seg, epoch: e, by: 'anchor' as const };
    }
    if (!ctx.hasAgent) return { rows: seg, epoch: 0, by: 'no-agent' as const };
    const minRid = Math.min(...seg.map((r) => r.rid));
    const maxRid = Math.max(...seg.map((r) => r.rid));
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

/** 目前最新的世代(水位與 Agent 列的世代取最大;沒有 Agent 資料為 null) */
export function currentEpochOf(watermark: Map<number, number>): number | null {
  return watermark.size ? Math.max(...watermark.keys()) : null;
}

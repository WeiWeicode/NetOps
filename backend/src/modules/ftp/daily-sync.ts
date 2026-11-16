/**
 * 對帳後的每日同步(IMPL-PLAN AC1;ARCHITECTURE D43、D44):
 *   每天自動對帳(NETOPS_RECON_TIME,預設 08:10)的每一輪之後,接著從 FTP 同步解密、GlobalProtect、User-ID 摘要與 AD 匯入。
 *   這四類不進 ClickHouse,測試區 FTP_SYNC_MINUTES=0、FTP 只保留 10 天,不排程會遺失(需求方 2026-11-13)。
 *   不同步 TRAFFIC 與威脅類(查詢已改 ClickHouse;TRAFFIC 由對帳自己同步)。
 *
 * 重試照對帳的規則:前一天的檔還沒出現、還在分析或 FTP 失敗時,10 分鐘後(對帳的下一輪)再看;
 * FTP 目錄 30 分鐘最多列一次;一天最多試 DAILY_MAX_TRIES 次(約 15 小時)後停止並記 warn。
 * 只排 FTP 保留期限內的日子(1 ~ retentionDays − 1 天前,依檔名日期),避免第一次啟動就把 FTP 上很舊的檔全部排進佇列。
 * 超過保留期限仍沒匯入的日子記 warn(每個類型、每天一次;從沒匯入過的類型不記,PA 可能沒有匯出)。
 * NETOPS_DAILY_SYNC=0 關閉;NETOPS_RECON_TIME=-1(不自動對帳)時也不跑。狀態只在記憶體,重新啟動後當天重新判斷。
 */
import type { AdImporter } from '../ad/importer.js';
import type { EventImporter } from '../pa-events/importer.js';
import { dayOut, taipeiDayStartMs, taipeiText } from '../../shared/time.js';

/** 每日同步的 PA 類型(不進 ClickHouse 的三類,ARCHITECTURE D27) */
export const DAILY_EVENT_TYPES = ['decryption', 'globalprotect', 'userid'] as const;
/** 一天最多試幾次(對帳每 10 分鐘一輪,約 15 小時:08:10 開始時到 23:00 左右停止並 warn,不會跨到隔天才停) */
export const DAILY_MAX_TRIES = 90;
/** FTP 目錄最短多久列一次(同對帳的同步間隔) */
export const DAILY_SYNC_GAP_MS = 30 * 60_000;

export type DailyDayState = 'done' | 'pending' | 'error' | 'none';
/** disabled 關閉;waiting 今天還沒開始;retrying 前一天還沒全部匯入,稍後再試;done 今天已完成;gave-up 試太多次停止 */
export type DailyRunState = 'disabled' | 'waiting' | 'retrying' | 'done' | 'gave-up';

export interface DailySyncStatus {
  enabled: boolean;
  /** 每天幾點開始(同對帳,台灣時間 HH:MM);不自動時 null */
  at: string | null;
  retentionDays: number;
  state: DailyRunState;
  /** 最近一輪的日期(台灣時間,YYYY-MM-DD) */
  runDay: string | null;
  lastRunAt: string | null;
  lastSyncAt: string | null;
  /** 今天完成(或停止)的時間 */
  finishedAt: string | null;
  tries: number;
  /** 每個類型在保留期限內每一天的狀態(新的在前) */
  categories: { key: string; label: string; days: { day: string; state: DailyDayState }[] }[];
}

type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

export interface DailySync {
  /** 跑一輪(對帳每一輪之後呼叫);錯誤只寫日誌,不丟出 */
  run(): Promise<void>;
  status(): DailySyncStatus;
}

interface Category {
  key: string;
  label: string;
  state(day: string): DailyDayState;
  /** 有沒有匯入過任何一天(從沒有的類型過期不記 warn) */
  used(): boolean;
}

export function createDailySync({
  events,
  ad,
  log,
  enabled,
  at,
  retentionDays,
  now = Date.now,
}: {
  events: Pick<EventImporter, 'eventTypes' | 'sync' | 'dayState' | 'hasAnyFile'>;
  ad: Pick<AdImporter, 'configured' | 'sync' | 'dayState' | 'hasAnyDay'>;
  log: Log;
  /** NETOPS_DAILY_SYNC 開著、有自動對帳 */
  enabled: boolean;
  /** 對帳開始時間(當天第幾分鐘;-1 = 不自動) */
  at: number;
  retentionDays: number;
  now?: () => number;
}): DailySync {
  let runDay = '';
  let tries = 0;
  let finished: 'done' | 'gave-up' | null = null;
  let finishedAt: string | null = null;
  let lastRunAt: string | null = null;
  let lastSyncMs = 0;
  /** 已記過「超過保留期限」warn 的 類型|日期(重新啟動前不重複記) */
  const warned = new Set<string>();

  const dayAgo = (today: string, i: number) => taipeiText(taipeiDayStartMs(today) - i * 86_400_000).slice(0, 10);
  const today = () => taipeiText(now()).slice(0, 10);
  /** 保留期限內要同步的日子:1 ~ retentionDays − 1 天前(最後一天 FTP 檔可能已被刪,同對帳) */
  const windowDays = (t: string) => Array.from({ length: Math.max(1, retentionDays - 1) }, (_, i) => dayAgo(t, i + 1));

  function categories(): Category[] {
    const enabledTypes = new Map(events.eventTypes().map((t) => [t.type, t.label]));
    const out: Category[] = DAILY_EVENT_TYPES.filter((t) => enabledTypes.has(t)).map((t) => ({
      key: t,
      label: enabledTypes.get(t)!,
      state: (d: string) => events.dayState(t, d),
      used: () => events.hasAnyFile(t),
    }));
    if (ad.configured()) out.push({ key: 'ad', label: 'AD 事件', state: (d) => ad.dayState(d), used: () => ad.hasAnyDay() });
    return out;
  }

  const code = (err: unknown) => (err as { code?: unknown }).code;

  /** 列 FTP 目錄、把保留期限內還沒匯入的檔排進分析(PA 三類)與匯入(AD);FTP 失敗只記 warn,下一輪再試 */
  async function syncFtp(days: string[]) {
    const types = DAILY_EVENT_TYPES.filter((t) => events.eventTypes().some((e) => e.type === t));
    if (types.length) {
      try {
        const r = await events.sync({ types: [...types], days: new Set(days) });
        if (r.errors.length) log.warn({ errors: r.errors.length }, '每日同步:部分 PA 類型目錄列不出來(FTP),稍後再試');
        else if (r.added) log.info({ added: r.added }, '每日同步:解密 / GlobalProtect / User-ID 新檔已排入分析');
      } catch (err) {
        log.warn({ code: code(err) }, '每日同步:PA 類型目錄同步失敗,稍後再試');
      }
    }
    if (ad.configured()) {
      try {
        const r = await ad.sync({ days, force: false });
        if ('imported' in r && r.imported.length) log.info({ days: r.imported.length }, '每日同步:AD 已匯入');
      } catch (err) {
        log.warn({ code: code(err) }, '每日同步:AD 同步失敗(FTP),稍後再試');
      }
    }
  }

  /** 超過 FTP 保留期限(retentionDays ~ retentionDays + 7 天前)仍沒匯入的日子記 warn */
  function warnExpired(t: string, cats: Category[]) {
    for (let i = retentionDays; i <= retentionDays + 7; i++) {
      const d = dayAgo(t, i);
      for (const c of cats) {
        const k = `${c.key}|${d}`;
        if (warned.has(k) || c.state(d) === 'done' || !c.used()) continue;
        warned.add(k);
        log.warn({ type: c.key, day: d, retentionDays }, `每日同步:${c.label} ${d} 超過 FTP 保留期限(${retentionDays} 天)仍沒匯入,無法再從 FTP 補`);
      }
    }
    // 不讓 warned 無限長:只留最近的日子
    const oldest = dayAgo(t, retentionDays + 8);
    for (const k of warned) if (k.slice(k.indexOf('|') + 1) < oldest) warned.delete(k);
  }

  async function run() {
    if (!enabled) return;
    try {
      const t = today();
      if (runDay !== t) {
        runDay = t;
        tries = 0;
        finished = null;
        finishedAt = null;
      }
      const cats = categories();
      warnExpired(t, cats);
      if (finished || !cats.length) return;
      lastRunAt = new Date(now()).toISOString();
      const days = windowDays(t);
      if (now() - lastSyncMs >= DAILY_SYNC_GAP_MS) {
        lastSyncMs = now();
        await syncFtp(days);
      }
      // 前一天每個類型都匯入完成才算今天完成;較舊的日子同一輪一起排,沒補到的明天再排
      const yesterday = days[0]!;
      const left = cats.filter((c) => c.state(yesterday) !== 'done');
      if (!left.length) {
        finished = 'done';
        finishedAt = new Date(now()).toISOString();
        log.info({ day: yesterday }, '每日同步完成(解密 / GlobalProtect / User-ID / AD)');
        return;
      }
      tries++;
      if (tries >= DAILY_MAX_TRIES) {
        finished = 'gave-up';
        finishedAt = new Date(now()).toISOString();
        log.warn({ day: yesterday, tries, left: left.map((c) => `${c.key}:${c.state(yesterday)}`) }, '每日同步:前一天的檔一直沒有匯入完成,今天停止自動重試(可在 FTP Log 檔案頁手動同步)');
      }
    } catch (err) {
      log.warn({ code: code(err) }, '每日同步發生錯誤,下一輪再試');
    }
  }

  function status(): DailySyncStatus {
    const t = today();
    const cats = enabled ? categories() : [];
    const days = windowDays(t);
    const state: DailyRunState = !enabled ? 'disabled' : runDay !== t || !lastRunAt ? 'waiting' : finished ?? 'retrying';
    return {
      enabled,
      at: enabled && at >= 0 ? `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}` : null,
      retentionDays,
      state,
      runDay: runDay ? dayOut(runDay) : null,
      lastRunAt,
      lastSyncAt: lastSyncMs ? new Date(lastSyncMs).toISOString() : null,
      finishedAt: runDay === t ? finishedAt : null,
      tries: runDay === t ? tries : 0,
      categories: cats.map((c) => ({ key: c.key, label: c.label, days: days.map((d) => ({ day: dayOut(d), state: c.state(d) })) })),
    };
  }

  return { run, status };
}

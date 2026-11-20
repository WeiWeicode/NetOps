/**
 * PA 威脅特徵碼服務(TS-2;docs/THREAT-SIGNATURE-PLAN.md §4.2、§5.1、§5.2、§5.4、§7、Claude 審查 D1 / D2):
 *   - 背景定期 sync()(每 10 分鐘,單一容器內):比對 Redis 最新清單與 infra/store 上一版精簡索引,產生差異檔(保留 90 份)
 *   - D2 基準:infra/store 沒有歷史時將第一次讀到的清單存成基準版本(不算新增),基準日由 infra/store 持久保存,不依賴 Redis 7 天 TTL
 *   - 命中比對:ClickHouse pa_threat_logs(唯讀帳號);依路由決定是否包含 IP(TS-Q8);超過同步時間或 > 30 天改走 D6 工作模式
 *   - 規則覆蓋:結合 PA 安全規則快照與 vsys1 Profile Group(TS-Q5 第一版只看有沒有掛 VP / AS profile)
 *   - 戰情室新特徵碼集合:從 infra/store 取近 30 天新增 ID,快取 5 分鐘
 *   - 外部依賴(Redis / ClickHouse)失敗一律不回 5xx(避免 BFF 斷路器累積),回明確 NETOPS_PA_SIGNATURE_* 代碼或 available: false
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import type { ClickHouseReader, SignatureHitRow } from '../../infra/clickhouse/reader.js';
import type { JobRunner, JobView } from '../../infra/jobs/index.js';
import { PA_SIG_COOL_SEC, type PaSignatureRedis } from '../../infra/redis/pa-signature.js';
import type {
  LatestSigIndex,
  PaSignatureStore,
  PaSigVersionDiffFile,
  PaSigVersionMeta,
  SigDiffFieldChange,
  SigFirstSeen,
  SigKind,
} from '../../infra/store/pa-signature.js';
import type { HitInfo, Snapshot as PolicySnapshot } from '../pa-policy/core.js';
import {
  buildSignatureAiContext,
  pickHighRiskSignatures,
  SIG_AI_MAX_ITEMS,
  SIG_AI_TOP_APPS,
  toAiCoverageSummary,
  type PaSignatureForAi,
  type SigAiCoverageSummary,
  type SigAiHitStat,
} from './ai.js';
import {
  computeCoverage,
  diffSignatures,
  filterSignatures,
  parseItems,
  parseMeta,
  parseProfiles,
  SIG_DAYS,
  toCompactEntry,
  type LookupThreatResult,
  type SigDays,
  type SigItem,
  type SigListFilter,
  type SigListRow,
  type SigMeta,
  type SigProfiles,
} from './core.js';

const DAY_MS = 86_400_000;
/** 快照超過 2 小時沒檢查(收集週期 30 分鐘)視為過期 */
export const SIG_STALE_MS = 2 * 3600_000;
/** 30 天命中數與戰情室新特徵碼集合快取 5 分鐘(計畫 §5.4) */
export const SIG_CACHE_MS = 5 * 60_000;
/** 命中比對同步等待上限(D6:路由逾時 15 秒,同步等 8 秒;> 30 天直接轉工作) */
export const HIT_QUERY_SYNC_MS = 8_000;
/** 命中比對工作執行上限(60 秒) */
const HIT_QUERY_JOB_TIMEOUT_MS = 60_000;
export const HIT_JOB_KIND = 'pa-sig-hits';
export const HIT_IP_JOB_KIND = 'pa-sig-hit-ips';

export interface SignatureStatus {
  collectorEnabled: boolean;
  state: string | null;
  message: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  trigger: string | null;
  mgmtCpu: number | null;
  durationMs: number | null;
  count: number | null;
  threatVersion: string | null;
  fullFetch: boolean | null;
  refreshCooldownSec: number;
  lookupCooldownSec: number;
}

export interface NewSignatureEntry {
  id: string;
  name: string;
  severity: string;
  firstVersion: string;
}

export interface PolicySnapshotProvider {
  currentSnapshot(): Promise<{ snap: PolicySnapshot; hits: Record<string, HitInfo>; fetchedAt: string } | null>;
}

export interface HitQueryInput {
  days?: SigDays;
  scope?: 'new' | 'ids';
  ids?: string[];
}

export interface HitQueryItem extends SignatureHitRow {
  name: string;
  kind: SigKind | null;
  severity: string | null;
  ruleDetails: { name: string; unprotected: boolean }[];
}

export interface HitQueryResult {
  days: SigDays;
  since: string | null;
  from: string;
  to: string;
  scope: 'new' | 'ids';
  includeIps: boolean;
  queriedIds: number;
  truncatedIds: boolean;
  items: HitQueryItem[];
}

type Log = { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
type Unavailable = { available: false; reason: 'no-redis' | 'redis-down' | 'no-snapshot'; message: string; status: SignatureStatus | null };

interface LoadedSnapshot {
  meta: SigMeta;
  items: SigItem[];
  byId: Map<string, SigItem>;
  profiles: SigProfiles | null;
  status: SignatureStatus;
}

const num = (s: string | undefined): number | null => (s !== undefined && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);

export type PaSignatureService = ReturnType<typeof createPaSignatureService>;

export function createPaSignatureService(deps: {
  redis: PaSignatureRedis | null;
  store: PaSignatureStore;
  chReader: ClickHouseReader | null;
  policy?: PolicySnapshotProvider | null;
  jobs: JobRunner;
  log?: Log;
  now?: () => number;
  syncWaitMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const syncWaitMs = deps.syncWaitMs ?? HIT_QUERY_SYNC_MS;

  /** 同版本快照的記憶體快取(避免每次分頁都重解 10 MB JSON) */
  let snapCache: { key: string; items: SigItem[]; byId: Map<string, SigItem> } | null = null;
  /** P1:記憶體記住上次成功同步(或開機後核對過)的 threatVersion,版本未變時 sync() 直接跳過不解壓 latest-index.json.gz */
  let syncedVersion: string | null = null;
  /** P1:同版本精簡索引記憶體快取,供 list / get / hit-query / warroom 共用,避免每次請求都解壓 3.5 萬筆 gz */
  let latestIndexCache: LatestSigIndex | null = null;
  /** 近 30 天 ClickHouse 命中數快取(5 分鐘) */
  let hits30dCache: { at: number; data: Record<string, number> } | null = null;
  /** 戰情室新特徵碼集合快取(5 分鐘,計畫 §5.4) */
  let newSigCache: { at: number; data: Map<string, NewSignatureEntry> } | null = null;
  /** 避免並發 sync 重複寫檔 */
  let syncing: Promise<boolean> | null = null;

  /** 取得目前版本的精簡索引(優先命中記憶體快取;損壞時記 warn 並回 null,不讓查詢變 500) */
  function getLatestIndex(headVersion: string | null): LatestSigIndex | null {
    if (!headVersion) return null;
    if (latestIndexCache && latestIndexCache.threatVersion === headVersion) return latestIndexCache;
    try {
      const idx = deps.store.readLatestIndex();
      if (idx) latestIndexCache = idx;
      return idx;
    } catch (err) {
      deps.log?.warn({ err: (err as Error).name }, 'PA 威脅特徵碼精簡索引損壞,暫時無法讀取首次出現紀錄');
      return null;
    }
  }

  async function readStatus(): Promise<SignatureStatus> {
    const r = deps.redis!;
    const [h, enabled, cool, lookupCool] = await Promise.all([r.status(), r.collectorEnabled(), r.coolSec(), r.lookupCoolSec()]);
    return {
      collectorEnabled: enabled,
      state: h.state || null,
      message: h.message || null,
      lastRunAt: h.lastRunAt || null,
      lastOkAt: h.lastOkAt || null,
      trigger: h.trigger || null,
      mgmtCpu: num(h.mgmtCpu),
      durationMs: num(h.durationMs),
      count: num(h.count),
      threatVersion: h.threatVersion || null,
      fullFetch: h.fullFetch === '1' ? true : h.fullFetch === '0' ? false : null,
      refreshCooldownSec: cool,
      lookupCooldownSec: lookupCool,
    };
  }

  /** 從 Redis 讀取清單(同 hash / threatVersion 時重用解析結果) */
  async function loadItems(meta: SigMeta): Promise<{ items: SigItem[]; byId: Map<string, SigItem> } | null> {
    const key = `${meta.threatVersion}|${meta.hash}`;
    if (snapCache && snapCache.key === key) return { items: snapCache.items, byId: snapCache.byId };
    const [rawVuln, rawSpy] = await Promise.all([deps.redis!.items('vulnerability'), deps.redis!.items('spyware')]);
    if (!rawVuln && !rawSpy) return null;
    const vuln = parseItems(rawVuln, 'vulnerability');
    const spy = parseItems(rawSpy, 'spyware');
    if (!vuln.length && !spy.length) return null;
    const items = [...vuln, ...spy];
    const byId = new Map(items.map((x) => [x.id, x]));
    snapCache = { key, items, byId };
    return { items, byId };
  }

  /**
   * D1 / D2 背景同步:比較 Redis 最新 threatVersion 與已同步版本(P1)及 infra/store 精簡索引。
   *   - 版本未變時直接回 false(不解壓 latest-index.json.gz);程序重啟後首次或版本變更時才從磁碟讀取精簡索引
   *   - 無歷史且無索引 → 基準版本(isBaseline=true、rebuilt=false,不算新增)
   *   - 有歷史但精簡索引遺失或損壞(P2) → 重建索引(isBaseline=false、rebuilt=true、記 warn 日誌,不算新增且保留原 baselineAt)
   *   - 正常版本更新 → 計算 added / changed / removed 並依 D1 順序原子落地
   */
  async function sync(): Promise<boolean> {
    if (!deps.redis) return false;
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const meta = parseMeta(await deps.redis!.meta());
        if (!meta) return false;
        // P1:版本與上次已確認同步的版本相同,直接略過不讀 latest-index.json.gz
        if (syncedVersion !== null && syncedVersion === meta.threatVersion) return false;

        const historyIdx = deps.store.readHistoryIndex();
        let latestIndex: LatestSigIndex | null = null;
        let indexCorrupt = false;
        try {
          latestIndex = deps.store.readLatestIndex();
        } catch (err) {
          indexCorrupt = true;
          deps.log?.warn(
            { reason: 'corrupt-index', err: (err as Error).name, threatVersion: meta.threatVersion },
            'PA 威脅特徵碼精簡索引損壞,將重建索引(本版差異無法計算)',
          );
        }
        if (latestIndex && latestIndex.threatVersion === meta.threatVersion) {
          syncedVersion = meta.threatVersion;
          latestIndexCache = latestIndex;
          return false;
        }

        const loaded = await loadItems(meta);
        if (!loaded) return false;

        const savedAt = new Date(now()).toISOString();
        // D2 / P2:區分「真的第一次基準」與「有歷史但索引遺失/損壞重建」
        const isBaseline = !latestIndex && historyIdx.versions.length === 0;
        const isRebuilt = !latestIndex && historyIdx.versions.length > 0;
        if (isRebuilt && !indexCorrupt) {
          deps.log?.warn(
            {
              reason: 'missing-index',
              threatVersion: meta.threatVersion,
              previousVersion: historyIdx.versions[0]?.threatVersion ?? null,
            },
            'PA 威脅特徵碼精簡索引遺失,將重建索引(本版差異無法計算)',
          );
        }

        let nextIndex: LatestSigIndex;
        let versionMeta: PaSigVersionMeta;
        let diffFile: PaSigVersionDiffFile;

        if (isBaseline || isRebuilt) {
          const compactItems: Record<string, ReturnType<typeof toCompactEntry>> = {};
          const firstSeen: Record<string, SigFirstSeen> = {};
          for (const item of loaded.items) {
            compactItems[item.id] = toCompactEntry(item);
            firstSeen[item.id] = isBaseline
              ? { version: meta.threatVersion, seenAt: savedAt, isBaseline: true }
              : { version: meta.threatVersion, seenAt: savedAt, isBaseline: false, rebuilt: true };
          }
          versionMeta = {
            threatVersion: meta.threatVersion,
            releaseDate: meta.threatReleaseDate,
            fetchedAt: meta.fetchedAt,
            savedAt,
            isBaseline,
            rebuilt: isRebuilt,
            counts: meta.counts,
            added: 0,
            changed: 0,
            removed: 0,
            hash: meta.hash,
          };
          diffFile = {
            threatVersion: meta.threatVersion,
            baseVersion: null,
            releaseDate: meta.threatReleaseDate,
            fetchedAt: meta.fetchedAt,
            savedAt,
            isBaseline,
            rebuilt: isRebuilt,
            counts: meta.counts,
            hash: meta.hash,
            added: [],
            changed: [],
            removed: [],
          };
          nextIndex = {
            threatVersion: meta.threatVersion,
            savedAt,
            hash: meta.hash,
            items: compactItems,
            firstSeen,
          };
        } else {
          const diff = diffSignatures(latestIndex!.items, loaded.items);
          const firstSeen: Record<string, SigFirstSeen> = {};
          for (const item of loaded.items) {
            const prev = latestIndex!.firstSeen[item.id];
            firstSeen[item.id] = prev ?? { version: meta.threatVersion, seenAt: savedAt, isBaseline: false };
          }
          versionMeta = {
            threatVersion: meta.threatVersion,
            releaseDate: meta.threatReleaseDate,
            fetchedAt: meta.fetchedAt,
            savedAt,
            isBaseline: false,
            rebuilt: false,
            counts: meta.counts,
            added: diff.added.length,
            changed: diff.changed.length,
            removed: diff.removed.length,
            hash: meta.hash,
          };
          diffFile = {
            threatVersion: meta.threatVersion,
            baseVersion: latestIndex!.threatVersion,
            releaseDate: meta.threatReleaseDate,
            fetchedAt: meta.fetchedAt,
            savedAt,
            isBaseline: false,
            rebuilt: false,
            counts: meta.counts,
            hash: meta.hash,
            added: diff.added,
            changed: diff.changed,
            removed: diff.removed,
          };
          nextIndex = {
            threatVersion: meta.threatVersion,
            savedAt,
            hash: meta.hash,
            items: diff.nextItems,
            firstSeen,
          };
        }

        deps.store.commitVersion({ meta: versionMeta, diff: diffFile, nextIndex });
        syncedVersion = meta.threatVersion;
        latestIndexCache = nextIndex;
        newSigCache = null; // 有新版本立即刷新戰情室新特徵碼快取
        return true;
      } catch (err) {
        deps.log?.warn({ err: (err as Error).name }, 'PA 威脅特徵碼版本同步失敗');
        return false;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  /** 計算「最近 N 天新特徵碼」的基準日與 ID 集合(D2:基準日只看 infra/store;P2:排除 rebuilt 版本) */
  function computeNewWindow(days: SigDays): {
    baselineAt: string | null;
    since: string | null;
    newIds: Set<string>;
    firstSeen: Record<string, SigFirstSeen>;
    latest: LatestSigIndex | null;
    versions: PaSigVersionMeta[];
  } {
    const hist = deps.store.readHistoryIndex();
    const headVersion = hist.versions[0]?.threatVersion ?? null;
    const latest = getLatestIndex(headVersion);
    const baselineAt = hist.baselineAt;
    const cutoff = now() - days * DAY_MS;
    const baseMs = baselineAt ? Date.parse(baselineAt) : Number.NaN;
    // 基準日晚於「今天 − days」時回 since = 基準日 YYYY-MM-DD(§1.2 #14)
    const since = !Number.isNaN(baseMs) && baseMs > cutoff ? baselineAt!.slice(0, 10) : null;
    const firstSeen = latest?.firstSeen ?? {};
    const newIds = new Set<string>();
    for (const [id, fs] of Object.entries(firstSeen)) {
      if (fs.isBaseline || fs.rebuilt) continue;
      const t = Date.parse(fs.seenAt);
      if (!Number.isNaN(t) && t >= cutoff) newIds.add(id);
    }
    return { baselineAt, since, newIds, firstSeen, latest, versions: hist.versions };
  }

  async function loadSnapshot(): Promise<LoadedSnapshot | Unavailable> {
    if (!deps.redis) return { available: false, reason: 'no-redis', message: '沒有設定 netops-redis,無法讀取 PA 威脅特徵碼', status: null };
    let rawMeta: Record<string, unknown> | null;
    let rawProfiles: Record<string, unknown> | null;
    let st: SignatureStatus;
    try {
      [rawMeta, rawProfiles, st] = await Promise.all([deps.redis.meta(), deps.redis.profiles(), readStatus()]);
    } catch (err) {
      deps.log?.warn({ err: (err as Error).name }, 'netops-redis 讀取 PA 威脅特徵碼失敗');
      return { available: false, reason: 'redis-down', message: 'netops-redis 暫時無法連線,稍後再試', status: null };
    }
    const meta = parseMeta(rawMeta);
    if (!meta) {
      return {
        available: false,
        reason: 'no-snapshot',
        message: st.collectorEnabled ? '收集器尚未讀到 PA 威脅特徵碼(或快照已超過 7 天過期)' : '收集器未啟用威脅特徵碼收集(PA_SIGNATURE_ENABLED)',
        status: st,
      };
    }
    let loaded: { items: SigItem[]; byId: Map<string, SigItem> } | null;
    try {
      loaded = await loadItems(meta);
    } catch (err) {
      deps.log?.warn({ err: (err as Error).name }, 'netops-redis 讀取 PA 威脅特徵碼清單失敗');
      return { available: false, reason: 'redis-down', message: 'netops-redis 暫時無法連線,稍後再試', status: null };
    }
    if (!loaded) {
      return {
        available: false,
        reason: 'no-snapshot',
        message: '特徵碼清單快照不完整,請稍後重試或手動更新',
        status: st,
      };
    }
    // 確保最新快照已被記錄進版本歷史
    await sync();
    return { meta, items: loaded.items, byId: loaded.byId, profiles: parseProfiles(rawProfiles), status: st };
  }

  /** 近 30 天命中數快取(失敗時回 null,不讓清單掛掉) */
  async function loadHits30d(): Promise<Record<string, number> | null> {
    if (!deps.chReader) return null;
    if (hits30dCache && now() - hits30dCache.at < SIG_CACHE_MS) return hits30dCache.data;
    try {
      const to = now();
      const data = await deps.chReader.signatureHitCounts(to - 30 * DAY_MS, to);
      hits30dCache = { at: to, data };
      return data;
    } catch (err) {
      deps.log?.warn({ err: err instanceof ClickHouseError ? err.code : (err as Error).name }, 'ClickHouse 讀取近 30 天特徵碼命中數失敗');
      return null;
    }
  }

  /** 找單一特徵在歷史差異檔裡的異動紀錄(由新到舊;含 rebuilt 版本標記,P2) */
  function changesOf(
    id: string,
  ): {
    threatVersion: string;
    releaseDate: string | null;
    savedAt: string;
    kind: 'added' | 'changed' | 'removed' | 'rebuilt';
    rebuilt: boolean;
    fields?: SigDiffFieldChange[];
  }[] {
    const hist = deps.store.readHistoryIndex();
    const out: {
      threatVersion: string;
      releaseDate: string | null;
      savedAt: string;
      kind: 'added' | 'changed' | 'removed' | 'rebuilt';
      rebuilt: boolean;
      fields?: SigDiffFieldChange[];
    }[] = [];
    for (const v of hist.versions) {
      if (v.isBaseline) continue;
      if (v.rebuilt) {
        out.push({ threatVersion: v.threatVersion, releaseDate: v.releaseDate, savedAt: v.savedAt, kind: 'rebuilt', rebuilt: true });
        continue;
      }
      if (!v.added && !v.changed && !v.removed) continue;
      const d = deps.store.readVersionDiff(v.threatVersion);
      if (!d) continue;
      if (d.added.some((x) => x.id === id))
        out.push({ threatVersion: v.threatVersion, releaseDate: v.releaseDate, savedAt: v.savedAt, kind: 'added', rebuilt: false });
      const ch = d.changed.find((x) => x.id === id);
      if (ch)
        out.push({ threatVersion: v.threatVersion, releaseDate: v.releaseDate, savedAt: v.savedAt, kind: 'changed', rebuilt: false, fields: ch.fields });
      if (d.removed.some((x) => x.id === id))
        out.push({ threatVersion: v.threatVersion, releaseDate: v.releaseDate, savedAt: v.savedAt, kind: 'removed', rebuilt: false });
    }
    return out;
  }

  /** 執行一次 ClickHouse 命中查詢(供同步或工作執行共用) */
  async function executeHitQuery(
    input: { days: SigDays; scope: 'new' | 'ids'; ids: string[]; includeIps: boolean },
    signal?: AbortSignal,
  ): Promise<HitQueryResult> {
    if (!deps.chReader) throw new AppError(424, 'NETOPS_PA_SIGNATURE_CH_UNAVAILABLE', '未設定 ClickHouse,無法查詢威脅特徵碼命中比對');
    const win = computeNewWindow(input.days);
    const allTargetIds = input.scope === 'ids' ? [...new Set(input.ids)] : [...win.newIds];
    const truncatedIds = allTargetIds.length > 500;
    const queryIds = allTargetIds.slice(0, 500);
    const toMs = now();
    const fromMs = toMs - input.days * DAY_MS;

    if (!queryIds.length) {
      return {
        days: input.days,
        since: win.since,
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        scope: input.scope,
        includeIps: input.includeIps,
        queriedIds: 0,
        truncatedIds: false,
        items: [],
      };
    }

    let chRows: SignatureHitRow[];
    try {
      chRows = await deps.chReader.signatureHits(queryIds, fromMs, toMs, { includeIps: input.includeIps, signal });
    } catch (err) {
      if (err instanceof ClickHouseError) {
        deps.log?.warn({ code: err.code, status: err.status }, 'ClickHouse 威脅特徵碼命中比對失敗');
        throw new AppError(424, 'NETOPS_PA_SIGNATURE_CH_UNAVAILABLE', 'ClickHouse 暫時無法查詢,請稍後再試');
      }
      throw err;
    }

    // 補特徵名稱 / 嚴重度與規則覆蓋缺口標註(§5.2:沒有防護的規則標 unprotected)
    const latestIdx = win.latest;
    let unprotected = new Set<string>();
    try {
      const [pol, rawProfiles] = await Promise.all([
        deps.policy?.currentSnapshot().catch(() => null) ?? Promise.resolve(null),
        deps.redis?.profiles().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (pol) unprotected = computeCoverage(pol.snap, pol.hits, parseProfiles(rawProfiles)).unprotectedRules;
    } catch {
      // 規則覆蓋讀取失敗不影響命中統計本身
    }

    const items: HitQueryItem[] = chRows.map((r) => {
      const meta = latestIdx?.items[r.id];
      return {
        ...r,
        name: meta?.name ?? '',
        kind: meta?.kind ?? null,
        severity: meta?.severity ?? null,
        ruleDetails: r.rules.map((name) => ({ name, unprotected: unprotected.has(name) })),
      };
    });

    return {
      days: input.days,
      since: win.since,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      scope: input.scope,
      includeIps: input.includeIps,
      queriedIds: queryIds.length,
      truncatedIds,
      items,
    };
  }

  /**
   * 送出命中比對(D6):
   *   - days <= 30:先送工作並同步等待最多 syncWaitMs(預設 8 秒),完成直接回 200;逾時回 202 { jobId, ...job }
   *   - days > 30(90 天):直接回 202 走工作模式
   */
  async function startHitQuery(
    owner: string,
    input: HitQueryInput,
    includeIps: boolean,
  ): Promise<{ status: 200; body: HitQueryResult } | { status: 202; body: JobView<HitQueryResult> & { jobId: string } }> {
    const days = (input.days ?? 30) as SigDays;
    if (!SIG_DAYS.includes(days)) throw new AppError(400, 'NETOPS_PA_SIGNATURE_QUERY_INVALID', 'days 只接受 7、30 或 90');
    const scope = input.scope ?? (input.ids?.length ? 'ids' : 'new');
    const ids = input.ids ?? [];
    if (scope === 'ids') {
      if (!ids.length || ids.length > 500 || !ids.every((x) => /^\d{1,10}$/.test(x))) {
        throw new AppError(400, 'NETOPS_PA_SIGNATURE_QUERY_INVALID', 'ids 必須是 1–500 個純數字特徵 ID');
      }
    }
    if (!deps.chReader) throw new AppError(424, 'NETOPS_PA_SIGNATURE_CH_UNAVAILABLE', '未設定 ClickHouse,無法查詢威脅特徵碼命中比對');

    const kind = includeIps ? HIT_IP_JOB_KIND : HIT_JOB_KIND;
    let doneResolve!: (r: { ok: true; value: HitQueryResult } | { ok: false; err: unknown }) => void;
    const settled = new Promise<{ ok: true; value: HitQueryResult } | { ok: false; err: unknown }>((resolve) => {
      doneResolve = resolve;
    });

    const job = deps.jobs.submit<HitQueryResult>(
      kind,
      owner,
      async ({ signal }) => {
        try {
          const res = await executeHitQuery({ days, scope, ids, includeIps }, signal);
          doneResolve({ ok: true, value: res });
          return res;
        } catch (err) {
          doneResolve({ ok: false, err });
          throw err;
        }
      },
      { timeoutMs: HIT_QUERY_JOB_TIMEOUT_MS },
    );

    // 超過 30 天(90 天)一律直接轉工作模式(計畫 §5.1、D6)
    if (days > 30 || syncWaitMs <= 0) {
      return { status: 202, body: { ...job, jobId: job.id } };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      settled,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), syncWaitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (waited === 'timeout') {
      const current = deps.jobs.get<HitQueryResult>(job.id, owner, kind);
      return { status: 202, body: { ...current, jobId: current.id } };
    }
    if (!waited.ok) {
      if (waited.err instanceof AppError) throw waited.err;
      throw new AppError(424, 'NETOPS_PA_SIGNATURE_CH_UNAVAILABLE', '查詢命中比對失敗,請稍後再試');
    }
    return { status: 200, body: waited.value };
  }

  return {
    sync,

    /** 戰情室用(§5.4):近 30 天新增特徵碼 ID → 摘要,快取 5 分鐘(不碰 Redis,只讀 infra/store) */
    newSignatureMap(): Map<string, NewSignatureEntry> {
      if (newSigCache && now() - newSigCache.at < SIG_CACHE_MS) return newSigCache.data;
      const win = computeNewWindow(30);
      const latest = win.latest;
      const map = new Map<string, NewSignatureEntry>();
      for (const id of win.newIds) {
        const entry = latest?.items[id];
        const fs = win.firstSeen[id];
        if (!entry || !fs) continue;
        map.set(id, { id, name: entry.name, severity: entry.severity, firstVersion: fs.version });
      }
      newSigCache = { at: now(), data: map };
      return map;
    },

    async list(filter: SigListFilter, days: SigDays, page: number, pageSize: number) {
      const l = await loadSnapshot();
      const win = computeNewWindow(days);
      if (!('meta' in l)) {
        return {
          ...l,
          items: [],
          total: 0,
          page,
          pageSize,
          days,
          baselineAt: win.baselineAt,
          since: win.since,
          hitsAvailable: false,
        };
      }
      const hits30d = await loadHits30d();
      const curVer = win.versions.find((v) => v.threatVersion === l.meta.threatVersion);
      const rows: SigListRow[] = l.items.map((item) => {
        const fs = win.firstSeen[item.id];
        return {
          ...item,
          firstVersion: fs && !fs.rebuilt ? fs.version : null,
          isNew: win.newIds.has(item.id),
          ...(hits30d ? { hits30d: hits30d[item.id] ?? 0 } : {}),
        };
      });
      const filtered = filterSignatures(rows, filter);
      const checkedMs = Date.parse(l.meta.checkedAt);
      return {
        available: true as const,
        threatVersion: l.meta.threatVersion,
        threatReleaseDate: l.meta.threatReleaseDate,
        fetchedAt: l.meta.fetchedAt,
        checkedAt: l.meta.checkedAt,
        stale: Number.isNaN(checkedMs) || now() - checkedMs > SIG_STALE_MS,
        baselineAt: win.baselineAt,
        since: win.since,
        rebuilt: Boolean(curVer?.rebuilt),
        days,
        counts: l.meta.counts,
        versions: {
          appVersion: l.meta.appVersion,
          appReleaseDate: l.meta.appReleaseDate,
          avVersion: l.meta.avVersion,
          avReleaseDate: l.meta.avReleaseDate,
          wildfireVersion: l.meta.wildfireVersion,
          wildfireReleaseDate: l.meta.wildfireReleaseDate,
          urlFilteringVersion: l.meta.urlFilteringVersion,
        },
        hitsAvailable: hits30d !== null,
        status: l.status,
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        total: filtered.length,
        page,
        pageSize,
      };
    },

    /** 單筆特徵碼(抽屜用):先找快照 → 再找 1 天按需快取 → 若收集器啟用則送 202 { lookupId } 給收集器查 show threat id */
    async get(id: string, owner: string) {
      const l = await loadSnapshot();
      const win = computeNewWindow(30);
      const hits30d = await loadHits30d();

      if ('meta' in l) {
        const found = l.byId.get(id);
        if (found) {
          const curVer = win.versions.find((v) => v.threatVersion === l.meta.threatVersion);
          const fs = win.firstSeen[id];
          return {
            status: 200 as const,
            body: {
              found: true as const,
              source: 'snapshot' as const,
              threatVersion: l.meta.threatVersion,
              fetchedAt: l.meta.fetchedAt,
              baselineAt: win.baselineAt,
              rebuilt: Boolean(curVer?.rebuilt),
              item: {
                ...found,
                firstVersion: fs && !fs.rebuilt ? fs.version : null,
                isNew: win.newIds.has(id),
                changes: changesOf(id),
                hits30d: hits30d ? (hits30d[id] ?? 0) : null,
                vault: null,
              },
            },
          };
        }
      } else if (l.reason === 'no-redis' || l.reason === 'redis-down') {
        throw new AppError(424, 'NETOPS_PA_SIGNATURE_UNAVAILABLE', l.message);
      }

      // 快照沒有:先看收集器 1 天快取
      let cached: Record<string, unknown> | null;
      let enabled: boolean;
      try {
        [cached, enabled] = await Promise.all([deps.redis!.lookupCache(id), deps.redis!.collectorEnabled()]);
      } catch (err) {
        throw Object.assign(new AppError(424, 'NETOPS_PA_SIGNATURE_UNAVAILABLE', 'netops-redis 暫時無法連線,稍後再試'), { cause: err });
      }
      if (cached && typeof cached.found === 'boolean') {
        if (cached.found && cached.item && typeof cached.item === 'object') {
          const item = cached.item as LookupThreatResult;
          return {
            status: 200 as const,
            body: {
              found: true as const,
              source: 'lookup' as const,
              checkedAt: typeof cached.checkedAt === 'string' ? cached.checkedAt : null,
              item: {
                ...item,
                firstVersion: null,
                isNew: false,
                changes: [],
                hits30d: hits30d ? (hits30d[id] ?? 0) : null,
                vault: null,
              },
            },
          };
        }
        return {
          status: 200 as const,
          body: {
            found: false as const,
            source: 'lookup' as const,
            checkedAt: typeof cached.checkedAt === 'string' ? cached.checkedAt : null,
            message: '本機特徵庫查無(可能是病毒 / WildFire / 自訂特徵)',
          },
        };
      }

      if (!enabled) {
        return {
          status: 200 as const,
          body: {
            found: false as const,
            source: 'snapshot' as const,
            message: '本機特徵庫查無(收集器未啟用按需查詢)',
          },
        };
      }

      const lookupId = randomUUID();
      try {
        const sub = await deps.redis!.submitLookup(owner, lookupId, id, new Date(now()));
        if (!sub.ok) {
          throw Object.assign(
            new AppError(429, 'NETOPS_PA_SIGNATURE_COOLDOWN', `單筆特徵按需查詢限流中,請 ${sub.retryAfter} 秒後再試`, { retryAfter: sub.retryAfter }),
            { retryAfter: sub.retryAfter },
          );
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw Object.assign(new AppError(424, 'NETOPS_PA_SIGNATURE_UNAVAILABLE', 'netops-redis 暫時無法連線,稍後再試'), { cause: err });
      }
      return { status: 202 as const, body: { lookupId, id, status: 'queued' as const } };
    },

    async getLookup(lookupId: string, owner: string) {
      if (!deps.redis) throw new AppError(424, 'NETOPS_PA_SIGNATURE_UNAVAILABLE', '沒有設定 netops-redis,無法查詢按需結果');
      let h: Record<string, string> | null;
      try {
        h = await deps.redis.lookupJob(lookupId);
      } catch (err) {
        throw Object.assign(new AppError(424, 'NETOPS_PA_SIGNATURE_UNAVAILABLE', 'netops-redis 暫時無法連線,稍後再試'), { cause: err });
      }
      if (!h || h.emp !== owner) throw new AppError(404, 'NETOPS_PA_SIGNATURE_LOOKUP_NOT_FOUND', '找不到這個查詢工作(可能已過期)');
      let result: LookupThreatResult | null = null;
      if (h.result) {
        try {
          result = JSON.parse(h.result) as LookupThreatResult;
        } catch {
          result = null;
        }
      }
      return {
        lookupId,
        threatId: h.threatId ?? '',
        status: h.status ?? 'queued',
        createdAt: h.createdAt || null,
        startedAt: h.startedAt || null,
        finishedAt: h.finishedAt || null,
        cached: h.cached === '1',
        mgmtCpu: num(h.mgmtCpu),
        result,
        error: h.error || null,
        message: h.message || null,
      };
    },

    async versions() {
      await sync();
      const hist = deps.store.readHistoryIndex();
      return {
        baselineAt: hist.baselineAt,
        baselineVersion: hist.baselineVersion,
        items: hist.versions,
        total: hist.versions.length,
      };
    },

    versionDiffs(
      threatVersion: string,
      opts: { kind?: 'added' | 'changed' | 'removed'; sigKind?: SigKind; severity?: string; q?: string; page: number; pageSize: number },
    ) {
      const d = deps.store.readVersionDiff(threatVersion);
      if (!d) throw new AppError(404, 'NETOPS_PA_SIGNATURE_VERSION_NOT_FOUND', '找不到這個內容版本(只保留最近 90 份)');
      type UnifiedDiffRow =
        | { diffKind: 'added' | 'removed'; id: string; kind: SigKind; name: string; severity: string; category: string; defaultAction: string | null; disabled: boolean; cves: string[] }
        | { diffKind: 'changed'; id: string; kind: SigKind; name: string; severity: string; category: string; fields: SigDiffFieldChange[] };

      const all: UnifiedDiffRow[] = [
        ...d.added.map((x) => ({ diffKind: 'added' as const, ...x })),
        ...d.changed.map((x) => ({ diffKind: 'changed' as const, ...x })),
        ...d.removed.map((x) => ({ diffKind: 'removed' as const, ...x })),
      ];
      const q = opts.q?.trim().toLowerCase();
      const sev = opts.severity?.trim().toLowerCase();
      const filtered = all.filter((x) => {
        if (opts.kind && x.diffKind !== opts.kind) return false;
        if (opts.sigKind && x.kind !== opts.sigKind) return false;
        if (sev && x.severity.toLowerCase() !== sev) return false;
        if (q) {
          const cves = 'cves' in x ? x.cves : [];
          if (!x.id.includes(q) && !x.name.toLowerCase().includes(q) && !cves.some((c) => c.toLowerCase().includes(q))) return false;
        }
        return true;
      });
      return {
        threatVersion: d.threatVersion,
        baseVersion: d.baseVersion,
        releaseDate: d.releaseDate,
        fetchedAt: d.fetchedAt,
        savedAt: d.savedAt,
        isBaseline: d.isBaseline,
        rebuilt: Boolean(d.rebuilt),
        counts: d.counts,
        summary: { added: d.added.length, changed: d.changed.length, removed: d.removed.length },
        items: filtered.slice((opts.page - 1) * opts.pageSize, opts.page * opts.pageSize),
        total: filtered.length,
        page: opts.page,
        pageSize: opts.pageSize,
      };
    },

    startHitQuery,
    getHitJob: (id: string, owner: string, includeIps: boolean) => deps.jobs.get<HitQueryResult>(id, owner, includeIps ? HIT_IP_JOB_KIND : HIT_JOB_KIND),
    cancelHitJob: (id: string, owner: string, includeIps: boolean) => {
      try {
        deps.jobs.cancel(id, owner, includeIps ? HIT_IP_JOB_KIND : HIT_JOB_KIND, { discard: true });
      } catch (err) {
        if (!(err instanceof AppError && err.status === 404)) throw err;
      }
    },

    /** 規則覆蓋(§5.2;TS-Q5 第一版只看有沒有掛 VP / AS profile) */
    async coverage() {
      if (!deps.policy) {
        return { available: false as const, reason: 'no-policy' as const, message: '沒有安全規則服務,無法評估規則覆蓋', summary: null, items: [] };
      }
      const pol = await deps.policy.currentSnapshot().catch(() => null);
      if (!pol) {
        return { available: false as const, reason: 'no-policy-snapshot' as const, message: '尚未取得 PA 安全規則快照,無法評估規則覆蓋', summary: null, items: [] };
      }
      let sigProfiles: SigProfiles | null = null;
      let profilesWarning: string | null = null;
      if (deps.redis) {
        try {
          sigProfiles = parseProfiles(await deps.redis.profiles());
          if (!sigProfiles) profilesWarning = '尚未取得 vsys1 Profile Group 快照,使用群組的規則暫標「無法判定」';
        } catch {
          profilesWarning = 'netops-redis 暫時無法讀取 Profile Group 快照,使用群組的規則暫標「無法判定」';
        }
      } else {
        profilesWarning = '未設定 netops-redis,使用群組的規則暫標「無法判定」';
      }
      const cov = computeCoverage(pol.snap, pol.hits, sigProfiles);
      return {
        available: true as const,
        policyFetchedAt: pol.fetchedAt,
        profilesFetchedAt: sigProfiles?.fetchedAt ?? null,
        profilesAvailable: sigProfiles !== null,
        ...(profilesWarning ? { message: profilesWarning } : {}),
        summary: cov.summary,
        items: cov.items,
      };
    },

    async refresh(by: string) {
      if (!deps.redis) throw new AppError(409, 'NETOPS_PA_SIGNATURE_DISABLED', '沒有設定 netops-redis,無法重新整理');
      try {
        if (!(await deps.redis.collectorEnabled()))
          throw new AppError(409, 'NETOPS_PA_SIGNATURE_DISABLED', '收集器未啟用威脅特徵碼收集(PA_SIGNATURE_ENABLED),無法重新整理');
        const r = await deps.redis.requestRefresh(by, new Date(now()));
        if (!r.ok) {
          throw Object.assign(
            new AppError(429, 'NETOPS_PA_SIGNATURE_COOLDOWN', `手動重新整理每 5 分鐘一次,請 ${r.retryAfter} 秒後再試`, { retryAfter: r.retryAfter }),
            { retryAfter: r.retryAfter },
          );
        }
        return { requestedAt: r.requestedAt, cooldownSec: PA_SIG_COOL_SEC };
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw Object.assign(new AppError(424, 'NETOPS_PA_SIGNATURE_UNAVAILABLE', 'netops-redis 暫時無法連線,稍後再試'), { cause: err });
      }
    },

    /** TS-3 AI 摘要的純統計資料(§5.3):只送統計與前 50 筆新增高危特徵,不送 IP / 姓名 / 規則名稱 / 原始 log;無快照回 404 / 424(不回 5xx) */
    async forAi(days: SigDays = 30): Promise<PaSignatureForAi> {
      if (!SIG_DAYS.includes(days)) {
        throw new AppError(400, 'NETOPS_PA_SIGNATURE_QUERY_INVALID', 'days 只接受 7、30 或 90');
      }
      const l = await loadSnapshot();
      if (!('meta' in l)) {
        const status = l.reason === 'no-snapshot' ? 404 : 424;
        throw new AppError(status, 'NETOPS_PA_SIGNATURE_UNAVAILABLE', l.message);
      }

      const toMs = now();
      const fromMs = toMs - days * DAY_MS;
      const win = computeNewWindow(days);
      const checkedMs = Date.parse(l.meta.checkedAt);
      const stale = Number.isNaN(checkedMs) || toMs - checkedMs > SIG_STALE_MS;
      const curVer = win.versions.find((v) => v.threatVersion === l.meta.threatVersion) ?? win.versions[0] ?? null;
      const rebuilt =
        Boolean(curVer?.rebuilt) ||
        win.versions.some((v) => v.rebuilt && !Number.isNaN(Date.parse(v.savedAt)) && Date.parse(v.savedAt) >= fromMs);
      const baselineOnly = win.versions.length > 0 && win.versions.every((v) => v.isBaseline);

      const newItems: SigItem[] = [];
      for (const id of win.newIds) {
        const item = l.byId.get(id);
        if (item) newItems.push(item);
      }

      // 並行讀取命中筆數、本環境近 30 天熱門 App 與安全規則覆蓋(各外部依賴失敗皆降級註明,不回 5xx)
      const [hitCounts, topApps, polSnap] = await Promise.all([
        (async (): Promise<Record<string, number> | null> => {
          if (!deps.chReader) return null;
          if (days === 30) return loadHits30d();
          try {
            return await deps.chReader.signatureHitCounts(fromMs, toMs);
          } catch (err) {
            deps.log?.warn({ err: err instanceof ClickHouseError ? err.code : (err as Error).name }, 'ClickHouse 讀取 AI 摘要特徵碼命中數失敗');
            return null;
          }
        })(),
        (async (): Promise<{ app: string; sessions: number }[] | null> => {
          if (!deps.chReader) return null;
          try {
            return await deps.chReader.topApps(toMs - 30 * DAY_MS, toMs, SIG_AI_TOP_APPS);
          } catch (err) {
            deps.log?.warn({ err: err instanceof ClickHouseError ? err.code : (err as Error).name }, 'ClickHouse 讀取 AI 摘要近 30 天 App 排行失敗');
            return null;
          }
        })(),
        deps.policy?.currentSnapshot().catch(() => null) ?? Promise.resolve(null),
      ]);

      let coverageSummary: SigAiCoverageSummary | null = null;
      let unprotectedRules = new Set<string>();
      if (polSnap) {
        const cov = computeCoverage(polSnap.snap, polSnap.hits, l.profiles);
        coverageSummary = toAiCoverageSummary(cov.summary, l.profiles !== null);
        unprotectedRules = cov.unprotectedRules;
      }

      const { picked } = pickHighRiskSignatures(newItems, hitCounts, SIG_AI_MAX_ITEMS);
      let hitStats: Record<string, SigAiHitStat> | null = null;
      if (hitCounts !== null && deps.chReader) {
        const hitIds = picked.filter((x) => (hitCounts[x.id] ?? 0) > 0).map((x) => x.id);
        if (!hitIds.length) {
          hitStats = {};
        } else {
          try {
            // 強制 includeIps: false,不查詢也不回傳任何來源 / 目的 IP
            const rows = await deps.chReader.signatureHits(hitIds, fromMs, toMs, { includeIps: false });
            hitStats = {};
            for (const r of rows) {
              hitStats[r.id] = {
                id: r.id,
                hits: r.hits,
                repeats: r.repeats,
                blocked: r.blocked,
                alerted: r.alerted,
                actions: r.actions,
                unprotectedRuleCount: r.rules.filter((rn) => unprotectedRules.has(rn)).length,
              };
            }
          } catch (err) {
            deps.log?.warn({ err: err instanceof ClickHouseError ? err.code : (err as Error).name }, 'ClickHouse 讀取 AI 摘要特徵碼動作分布失敗');
            hitStats = null;
          }
        }
      }

      return buildSignatureAiContext({
        meta: l.meta,
        stale,
        days,
        baselineAt: win.baselineAt,
        since: win.since,
        rebuilt,
        baselineOnly,
        latestVersion: curVer,
        newItems,
        hitCounts,
        hitStats,
        topApps,
        coverage: coverageSummary,
      });
    },

    async status() {
      const hist = deps.store.readHistoryIndex();
      if (!deps.redis) {
        return {
          available: false as const,
          reason: 'no-redis' as const,
          message: '沒有設定 netops-redis',
          baselineAt: hist.baselineAt,
          versionCount: hist.versions.length,
        };
      }
      try {
        const st = await readStatus();
        return {
          available: true as const,
          ...st,
          baselineAt: hist.baselineAt,
          versionCount: hist.versions.length,
        };
      } catch (err) {
        deps.log?.warn({ err: (err as Error).name }, 'netops-redis 讀取 PA 威脅特徵碼狀態失敗');
        return {
          available: false as const,
          reason: 'redis-down' as const,
          message: 'netops-redis 暫時無法連線',
          baselineAt: hist.baselineAt,
          versionCount: hist.versions.length,
        };
      }
    },
  };
}

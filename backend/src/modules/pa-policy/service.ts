/**
 * PA 安全規則服務(PR-2;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3):讀 Redis 快照 → 展開、篩選;雜湊變了存新版本(infra/store);手動重新整理冷卻。
 * Redis 連不上時清單回 200 + available false(外部依賴失敗不回 5xx,避免累積 BFF 斷路器);只有手動重新整理回 424。
 * 規則內容不寫日誌。
 */
import { AppError } from '../../errors.js';
import type { PaPolicyRedis } from '../../infra/redis/pa-policy.js';
import type { PaPolicyStore, PaPolicyVersionMeta } from '../../infra/store/pa-policy.js';
import {
  buildViews,
  defaultRules,
  diffObjects,
  diffRules,
  filterRules,
  ipMatch,
  parseHits,
  parseSnapshot,
  toObjects,
  toRule,
  type HitInfo,
  type RuleFilter,
  type RuleView,
  type Snapshot,
} from './core.js';
import { checkContext, checkRules } from './check.js';

/** 快照超過這個時間沒更新就標 stale(收集週期 30 分鐘;失敗會 5 分鐘重試) */
export const STALE_MS = 2 * 3600_000;

export interface PolicyStatus {
  /** 收集器有沒有開安全規則收集(PA_POLICY_ENABLED;心跳) */
  collectorEnabled: boolean;
  state: string | null;
  message: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  trigger: string | null;
  mgmtCpu: number | null;
  durationMs: number | null;
  /** 手動重新整理冷卻剩餘秒數 */
  refreshCooldownSec: number;
}

interface Loaded {
  snap: Snapshot;
  views: RuleView[];
  hits: Record<string, HitInfo>;
  hitsFetchedAt: string | null;
  status: PolicyStatus;
  versionId: string | null;
}

type Unavailable = { available: false; reason: 'no-redis' | 'redis-down' | 'no-snapshot'; message: string; status: PolicyStatus | null };

const num = (s: string | undefined) => (s && Number.isFinite(Number(s)) ? Number(s) : null);

export type PaPolicyService = ReturnType<typeof createPaPolicyService>;

export function createPaPolicyService(deps: {
  redis: PaPolicyRedis | null;
  store: PaPolicyStore;
  log?: { warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let cache: { key: string; views: RuleView[] } | null = null;
  /** 排序檢查結果快取(同一份快照 + 命中數 + 門檻;O(n²),資安審查 L3) */
  let checkCache: { key: string; result: ReturnType<typeof checkRules> } | null = null;
  const checksOf = (l: Loaded, unusedDays: number) => {
    // 「長期未命中」和現在時間有關:以小時為單位重算
    const key = `${l.snap.hash}|${l.hitsFetchedAt ?? ''}|${unusedDays}|${Math.floor(now() / 3600_000)}`;
    if (!checkCache || checkCache.key !== key) checkCache = { key, result: checkRules(l.views, { unusedDays, now: now() }) };
    return checkCache.result;
  };

  async function status(): Promise<PolicyStatus> {
    const r = deps.redis!;
    const [h, enabled, cool] = await Promise.all([r.status(), r.collectorEnabled(), r.coolSec()]);
    return {
      collectorEnabled: enabled,
      state: h.state || null,
      message: h.message || null,
      lastRunAt: h.lastRunAt || null,
      lastOkAt: h.lastOkAt || null,
      trigger: h.trigger || null,
      mgmtCpu: num(h.mgmtCpu),
      durationMs: num(h.durationMs),
      refreshCooldownSec: cool,
    };
  }

  /** 雜湊和最新版本不同就存一份(第一次也存) */
  function recordVersion(snap: Snapshot): string | null {
    try {
      const latest = deps.store.listVersions()[0];
      if (latest?.hash === snap.hash) return latest.id;
      return deps.store.saveVersion({ hash: snap.hash, fetchedAt: snap.fetchedAt, rules: snap.rules, objects: snap.objects as unknown as Record<string, unknown> }, new Date(now())).id;
    } catch (err) {
      // 版本存不進去不影響清單(資料目錄問題由 /readyz 反映)
      deps.log?.error({ err: (err as Error).name }, 'PA 安全規則版本儲存失敗');
      return null;
    }
  }

  async function load(): Promise<Loaded | Unavailable> {
    if (!deps.redis) return { available: false, reason: 'no-redis', message: '沒有設定 netops-redis,無法讀取 PA 安全規則', status: null };
    let raw: Record<string, unknown> | null;
    let rawHits: Record<string, unknown> | null;
    let st: PolicyStatus;
    try {
      [raw, rawHits, st] = await Promise.all([deps.redis.snapshot(), deps.redis.hits(), status()]);
    } catch (err) {
      deps.log?.warn({ err: (err as Error).name }, 'netops-redis 讀取 PA 安全規則失敗');
      return { available: false, reason: 'redis-down', message: 'netops-redis 暫時無法連線,稍後再試', status: null };
    }
    const snap = parseSnapshot(raw);
    if (!snap)
      return {
        available: false,
        reason: 'no-snapshot',
        message: st.collectorEnabled ? '收集器尚未讀到 PA 安全規則(或快照已超過 7 天過期)' : '收集器未啟用安全規則收集(PA_POLICY_ENABLED)',
        status: st,
      };
    const h = parseHits(rawHits);
    const key = `${snap.hash}|${h.fetchedAt ?? ''}`;
    if (!cache || cache.key !== key) cache = { key, views: buildViews(snap, h.items) };
    return { snap, views: cache.views, hits: h.items, hitsFetchedAt: h.fetchedAt, status: st, versionId: recordVersion(snap) };
  }

  const meta = (l: Loaded) => {
    const t = Date.parse(l.snap.fetchedAt);
    return {
      available: true as const,
      fetchedAt: l.snap.fetchedAt,
      hash: l.snap.hash,
      versionId: l.versionId,
      stale: Number.isNaN(t) || now() - t > STALE_MS,
      hitsFetchedAt: l.hitsFetchedAt,
      ruleCount: l.snap.rules.length,
      status: l.status,
    };
  };

  return {
    /** 定期呼叫:沒有人開頁面時也記下版本 */
    async sync(): Promise<void> {
      await load();
    },

    async list(filter: RuleFilter, page: number, pageSize: number) {
      const l = await load();
      if (!('snap' in l)) return { ...l, items: [], total: 0, page, pageSize, defaults: [] };
      const all = filterRules(l.views, filter, now());
      return {
        ...meta(l),
        // IP 篩選時每條附 ipMatch(yes / maybe:含無法展開的物件或 negate,需人工確認)
        items: all.slice((page - 1) * pageSize, page * pageSize).map((v) => (filter.ips?.length ? { ...v.rule, ipMatch: ipMatch(v, filter.ips, filter.includeAny === true) } : v.rule)),
        total: all.length,
        page,
        pageSize,
        defaults: defaultRules(l.snap, l.hits),
      };
    },

    async get(name: string) {
      const l = await load();
      if (!('snap' in l)) throw new AppError(404, 'NETOPS_PA_POLICY_UNAVAILABLE', l.message);
      const v = l.views.find((x) => x.rule.name === name);
      if (!v) throw new AppError(404, 'NETOPS_PA_POLICY_NOT_FOUND', '找不到這條安全規則(可能已刪除或改名)');
      return { ...meta(l), rule: v.rule };
    },

    async refresh(by: string) {
      if (!deps.redis) throw new AppError(409, 'NETOPS_PA_POLICY_DISABLED', '沒有設定 netops-redis,無法重新整理');
      try {
        if (!(await deps.redis.collectorEnabled())) throw new AppError(409, 'NETOPS_PA_POLICY_DISABLED', '收集器未啟用安全規則收集(PA_POLICY_ENABLED),無法重新整理');
        const r = await deps.redis.requestRefresh(by, new Date(now()));
        if (!r.ok)
          throw Object.assign(new AppError(429, 'NETOPS_PA_POLICY_REFRESH_COOLDOWN', `手動重新整理每 5 分鐘一次,請 ${r.retryAfter} 秒後再試`, { retryAfter: r.retryAfter }), { retryAfter: r.retryAfter });
        return { requestedAt: r.requestedAt, cooldownSec: 300 };
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw Object.assign(new AppError(424, 'NETOPS_REDIS_UNAVAILABLE', 'netops-redis 暫時無法連線,稍後再試'), { cause: err });
      }
    },

    /** 排序檢查(PR-5):目前快照的確定性檢查結果;沒有快照回 available false(同清單) */
    async checks(unusedDays: number) {
      const l = await load();
      if (!('snap' in l)) return { ...l, items: [], summary: null, imprecise: 0, unusedDays };
      const r = checksOf(l, unusedDays);
      return { ...meta(l), unusedDays, ...r };
    },

    /** AI 判讀的資料(PR-5 第 2 層):檢查結果 + 相關規則;沒有快照回 404(串流開始前) */
    async forAi(unusedDays: number) {
      const l = await load();
      if (!('snap' in l)) throw new AppError(404, 'NETOPS_PA_POLICY_UNAVAILABLE', l.message);
      const r = checksOf(l, unusedDays);
      const ctx = checkContext(l.views, r, { fetchedAt: l.snap.fetchedAt, unusedDays });
      return { ...ctx, fetchedAt: l.snap.fetchedAt, hash: l.snap.hash, stale: meta(l).stale, ruleCount: l.snap.rules.length, summary: r.summary, imprecise: r.imprecise };
    },

    async versions(): Promise<{ items: PaPolicyVersionMeta[]; total: number }> {
      await load(); // 有新版本先記下(Redis 不可用時仍回已存的版本)
      const items = deps.store.listVersions();
      return { items, total: items.length };
    },

    /** id 對 baseId(省略時為 id 的前一個版本)的差異;沒有前一版時 baseId null、清單為空 */
    diff(id: string, baseId?: string) {
      const list = deps.store.listVersions();
      const cur = deps.store.readVersion(id);
      if (!cur) throw new AppError(404, 'NETOPS_PA_POLICY_VERSION_NOT_FOUND', '找不到這個版本(只保留最近 50 份)');
      const bid = baseId ?? list[list.findIndex((m) => m.id === id) + 1]?.id;
      const base = bid ? deps.store.readVersion(bid) : null;
      if (baseId && !base) throw new AppError(404, 'NETOPS_PA_POLICY_VERSION_NOT_FOUND', '找不到比較的版本(只保留最近 50 份)');
      const rules = (raw: unknown[]) => raw.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object').map(toRule);
      return {
        id,
        baseId: base ? base.meta.id : null,
        version: cur.meta,
        base: base?.meta ?? null,
        rules: base ? diffRules(rules(base.rules), rules(cur.rules)) : [],
        objects: base ? diffObjects(toObjects(base.objects), toObjects(cur.objects)) : [],
      };
    },
  };
}

/**
 * PA 精準查詢的 Redis 存取(C5;docs/PA-LOG-CLICKHOUSE-GUIDE.md §9.3–§9.5、ARCHITECTURE D31)。鍵格式同 pa-collector/netops_pa/keys.py(兩邊一起改):
 *   netops:paq:jobs          List   待執行的工作 id(這裡 LPUSH,netops-pa BRPOP)
 *   netops:paq:job:{id}      Hash   kind、params(JSON)、emp、status、時間、結果(TTL 10 分鐘;這裡建立,netops-pa 更新)
 *   netops:paq:active        String 全系統唯一的查詢名額(值 = 工作 id,SET NX EX 90;netops-pa 結束時比對後刪除)
 *   netops:paq:cool:global   String 全域最小間隔 10 秒(netops-pa 每個工作結束時設)
 *   netops:paq:cool:{emp}    String 每人冷卻 60 秒(這裡送出時設)
 * 也讀 netops-pa 的心跳(queryEnabled、updatedAt)與管理平面 CPU 快照(netops:pa:snap:cpu,輪詢寫入,60 秒過期)。
 * 鍵只在這裡組(AGENT.md §7.2);工號只允許英數與 -_(鍵不吃外部字串)。
 */
import { Redis } from 'ioredis';

export const PAQ_KEYS = {
  jobs: 'netops:paq:jobs',
  job: (id: string) => `netops:paq:job:${id}`,
  active: 'netops:paq:active',
  coolGlobal: 'netops:paq:cool:global',
  coolUser: (emp: string) => `netops:paq:cool:${emp}`,
  heartbeat: 'netops:pa:heartbeat',
  cpu: 'netops:pa:snap:cpu',
};
/** 名額 TTL:工作 60 秒 + 排隊與收尾;netops-pa 當機時自動收回 */
export const PAQ_ACTIVE_TTL_SEC = 90;
export const PAQ_USER_COOL_SEC = 60;
export const PAQ_JOB_TTL_SEC = 600;

export interface PaQueryClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', sec: number, nx: 'NX'): Promise<'OK' | null>;
  ttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  multi(commands: (string | number)[][]): { exec(): Promise<[Error | null, unknown][] | null> };
  quit(): Promise<unknown>;
}

export interface PaQueryState {
  /** netops-pa 有開查詢執行者(PA_QUERY_ENABLED)且心跳 60 秒內 */
  enabled: boolean;
  /** 心跳的 queryEnabled(收集器停止時可能仍為 1,看 heartbeatAgeSec) */
  executor: boolean;
  heartbeatAgeSec: number | null;
  /** 名額被佔用的剩餘秒數(0 = 空) */
  activeSec: number;
  globalCoolSec: number;
  userCoolSec: number;
  /** 最新管理平面 CPU(%;輪詢關閉或快照過期為 null) */
  mgmtCpu: number | null;
}

export type SubmitResult = { ok: true } | { ok: false; reason: 'user-cooldown' | 'global-cooldown' | 'busy'; retryAfter: number };

export interface PaQueryStore {
  state(owner: string, now?: number): Promise<PaQueryState>;
  /** 取名額、設每人冷卻、建立工作;任一步沒拿到就回 busy(不建立工作) */
  submit(owner: string, id: string, kind: string, params: Record<string, unknown>): Promise<SubmitResult>;
  job(id: string): Promise<Record<string, string> | null>;
  close(): Promise<void>;
}

/** ownerOf 的格式(emp:S112009 / sub:…);只允許這些字元才組鍵 */
const EMP = /^[\w:.-]{1,80}$/;
const ttlSec = (n: number) => (n > 0 ? n : 0);

export function createPaQueryStore(client: PaQueryClient): PaQueryStore {
  return {
    async state(owner, now = Date.now()) {
      const [hb, active, gc, uc, cpu] = await Promise.all([
        client.hgetall(PAQ_KEYS.heartbeat),
        client.ttl(PAQ_KEYS.active),
        client.ttl(PAQ_KEYS.coolGlobal),
        EMP.test(owner) ? client.ttl(PAQ_KEYS.coolUser(owner)) : Promise.resolve(-2),
        client.get(PAQ_KEYS.cpu),
      ]);
      const at = Date.parse(hb.updatedAt ?? '');
      const age = Number.isNaN(at) ? null : Math.max(0, Math.round((now - at) / 1000));
      let mgmt: number | null = null;
      try {
        const v = cpu ? (JSON.parse(cpu) as { mgmt?: unknown }).mgmt : null;
        mgmt = typeof v === 'number' && Number.isFinite(v) ? v : null;
      } catch {
        mgmt = null;
      }
      const executor = hb.queryEnabled === '1';
      return { enabled: executor && age !== null && age <= 60, executor, heartbeatAgeSec: age, activeSec: ttlSec(active), globalCoolSec: ttlSec(gc), userCoolSec: ttlSec(uc), mgmtCpu: mgmt };
    },
    async submit(owner, id, kind, params) {
      if (!EMP.test(owner)) throw new Error('工號格式不符,不能組鍵');
      const uc = await client.ttl(PAQ_KEYS.coolUser(owner));
      if (uc > 0) return { ok: false, reason: 'user-cooldown', retryAfter: uc };
      const gc = await client.ttl(PAQ_KEYS.coolGlobal);
      if (gc > 0) return { ok: false, reason: 'global-cooldown', retryAfter: gc };
      if ((await client.set(PAQ_KEYS.active, id, 'EX', PAQ_ACTIVE_TTL_SEC, 'NX')) !== 'OK')
        return { ok: false, reason: 'busy', retryAfter: Math.max(1, await client.ttl(PAQ_KEYS.active)) };
      const release = async () => {
        if ((await client.get(PAQ_KEYS.active)) === id) await client.del(PAQ_KEYS.active);
      };
      try {
        if ((await client.set(PAQ_KEYS.coolUser(owner), '1', 'EX', PAQ_USER_COOL_SEC, 'NX')) !== 'OK') {
          await release();
          return { ok: false, reason: 'user-cooldown', retryAfter: Math.max(1, await client.ttl(PAQ_KEYS.coolUser(owner))) };
        }
        const jk = PAQ_KEYS.job(id);
        const res = await client
          .multi([
            ['hset', jk, 'status', 'queued', 'kind', kind, 'emp', owner, 'params', JSON.stringify(params), 'createdAt', new Date().toISOString()],
            ['expire', jk, PAQ_JOB_TTL_SEC],
            ['lpush', PAQ_KEYS.jobs, id],
          ])
          .exec();
        // exec() 不會因單一指令失敗而丟例外,要逐一檢查
        if (!res || res.some(([err]) => err)) throw new Error('建立 PA 查詢工作失敗');
        return { ok: true };
      } catch (err) {
        // 沒送出就把名額與冷卻還回去
        await release().catch(() => undefined);
        await client.del(PAQ_KEYS.coolUser(owner)).catch(() => undefined);
        throw err;
      }
    },
    async job(id) {
      const h = await client.hgetall(PAQ_KEYS.job(id));
      return Object.keys(h).length ? h : null;
    },
    close: async () => {
      await client.quit().catch(() => undefined);
    },
  };
}

/** 連線 netops-redis(同 connectDashboardCache:不排隊、逾時短;Redis 停止時呼叫端回 424) */
export function connectPaQueryStore(url: string): PaQueryStore {
  const client = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, connectTimeout: 3000, commandTimeout: 2000, retryStrategy: (t) => Math.min(t * 500, 5000) });
  client.on('error', () => undefined);
  return createPaQueryStore(client as unknown as PaQueryClient);
}

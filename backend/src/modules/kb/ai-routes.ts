/**
 * 知識庫的 AI 功能(docs/API.md §10.2;舊版 server/routes/kb.js 的 semantic、vector-sync、learn-ips;IMPL-PLAN A1)
 *   語意搜尋:Qdrant 向量庫(沿用舊版 NetOpsKb);向量同步:VECTOR_SYNC=1 才會寫入(預設關閉,與舊版共用 collection)
 *   外部 IP 自動學習:背景執行(查 RDAP、請模型整理成筆記),畫面輪詢狀態(同舊版)
 * 讀取用 netops.kb.read、執行用 netops.kb.write(同舊版:狀態所有人可看,執行限管理者)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { IPLEARN_MAX_DAYS } from '../../config.js';
import { AppError } from '../../errors.js';
import { ACCEPTED, looseObject } from '../../shared/schemas.js';
import { logTimeOut } from '../../shared/time.js';
import type { KbService, Note } from './service.js';

export interface VectorIndex {
  vectorEnabled(): boolean;
  vectorStatus(): { enabled: boolean; sync: boolean; collection: string; ok: boolean | null; points: number; lastSync: string | null; error: string; syncing: boolean; upserted: number; deleted: number };
  syncVectors(): Promise<{ skipped?: boolean; busy?: boolean; upserted?: number; deleted?: number; points?: number }>;
  searchVectors(text: string, opts?: { limit?: number; minScore?: number }): Promise<{ id: string; title: string; score: number }[]>;
}

export interface IpLearner {
  learnIps(opts: { days?: number; max?: number; by?: string; rewrite?: boolean }): Promise<unknown>;
  learnStatus(): { busy: boolean; startedAt: string | null; finishedAt: string | null; [k: string]: unknown };
}

const noteOut = (n: Note) => ({ ...n, created: logTimeOut(n.created), updated: logTimeOut(n.updated) });

const kbAiRoutes: FastifyPluginAsync<{ kb: KbService; vector: VectorIndex; learner: IpLearner | null; learnHour: number; learnDefaults: { days: number; max: number }; log: { error(o: object, m: string): void } }> = async (
  app,
  { kb, vector, learner, learnHour, learnDefaults, log },
) => {
  const vectorOut = () => {
    const s = vector.vectorStatus();
    return { ...s, lastSync: s.lastSync ? logTimeOut(s.lastSync) : null };
  };

  app.get<{ Querystring: { q: string; limit?: number } }>(
    '/v1/kb/semantic-search',
    {
      schema: {
        operationId: 'netops.kb.semantic-search',
        summary: '知識庫語意搜尋',
        description:
          '以向量庫(Qdrant)找意思相近的筆記,依相近度排序,每筆附 score(0–1);只回相近度 0.6 以上、目前仍存在的筆記。問題中的 IP 數字不參與比對(IP 由關鍵字查詢處理);只有 IP 沒有文字時回空清單。' +
          '向量庫或 embedding 連不到時回空清單,vector.error 說明原因(不是查無相關筆記)。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.read',
        // embedding 30 秒 + Qdrant 15 秒的逾時上限(非串流 API 最長 60 秒,AGENT.md §7.3)
        'x-timeout-ms': 60000,
        'x-gherkin': [
          '場景: 語意搜尋',
          '  假如 使用者擁有 netops.kb.read',
          '  而且 向量庫已同步',
          '  當 呼叫 GET /api/netops/kb/semantic-search?q=備份主機',
          '  那麼 回應 200',
          '  而且 items 依 score 由高到低排序',
          '',
          '場景: 向量庫連不到',
          '  假如 Qdrant 無法連線',
          '  當 呼叫 GET /api/netops/kb/semantic-search?q=備份主機',
          '  那麼 回應 200 且 items 為空',
          '  而且 vector.error 不是空字串',
        ].join('\n'),
        querystring: {
          type: 'object',
          required: ['q'],
          additionalProperties: false,
          properties: { q: { type: 'string', minLength: 1, maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
        },
        response: { 200: looseObject('{ items: [筆記 + score], vector: 向量庫狀態 }') },
      },
    },
    async (req) => {
      const byId = new Map(kb.listNotes().map((n) => [n.id, n]));
      const hits = await vector.searchVectors(req.query.q, { limit: req.query.limit ?? 20, minScore: 0.6 });
      return { items: hits.filter((h) => byId.has(h.id)).map((h) => ({ ...noteOut(byId.get(h.id)!), score: h.score })), vector: vectorOut() };
    },
  );

  app.get(
    '/v1/kb/vector-status',
    {
      schema: {
        operationId: 'netops.kb.vector-status',
        summary: '向量庫狀態',
        description: '是否啟用向量庫、是否同步寫入(VECTOR_SYNC)、筆數、上次同步時間與結果、錯誤訊息(只有分類,不含主機位址)。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.read',
        'x-gherkin': ['場景: 查詢向量庫狀態', '  當 呼叫 GET /api/netops/kb/vector-status', '  那麼 回應 200', '  而且 回應有 enabled、sync、points、lastSync'].join('\n'),
        response: { 200: looseObject('{ enabled, sync, collection, ok, points, lastSync, error, syncing, upserted, deleted }') },
      },
    },
    async () => vectorOut(),
  );

  app.post(
    '/v1/kb/vector-syncs',
    {
      schema: {
        operationId: 'netops.kb.vector-sync',
        summary: '立即同步向量庫',
        description:
          '在背景比對知識庫與向量庫:新增 / 內容變了的筆記重算向量寫入,已刪除的移除;回 202 與狀態,畫面查 vector-status。' +
          '沒有啟用同步(VECTOR_SYNC=0,與舊版共用 collection 時)回 409 NETOPS_VECTOR_SYNC_DISABLED;同步中回 409 NETOPS_VECTOR_SYNC_BUSY。一次要刪除太多筆時停止(安全閥),原因寫在 error。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.write',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 沒有啟用同步',
          '  假如 VECTOR_SYNC 為 0',
          '  當 呼叫 POST /api/netops/kb/vector-syncs',
          '  那麼 回應 409 NETOPS_VECTOR_SYNC_DISABLED',
          '',
          '場景: 立即同步',
          '  假如 VECTOR_SYNC 為 1',
          '  當 呼叫 POST /api/netops/kb/vector-syncs',
          '  那麼 回應 202',
          '  而且 之後 vector-status 的 lastSync 更新',
        ].join('\n'),
        response: ACCEPTED,
      },
    },
    async (_req, reply) => {
      const s = vector.vectorStatus();
      if (!s.enabled || !s.sync) throw new AppError(409, 'NETOPS_VECTOR_SYNC_DISABLED', '沒有啟用向量庫同步(VECTOR_SYNC);目前只做語意搜尋');
      if (s.syncing) throw new AppError(409, 'NETOPS_VECTOR_SYNC_BUSY', '向量庫正在同步中');
      // 失敗記在狀態(error)並寫日誌(kb/core/vector.js)
      void vector.syncVectors().catch(() => {});
      return reply.status(202).send({ ...vectorOut(), syncing: true });
    },
  );

  const learnOut = () => {
    if (!learner) return { enabled: false, busy: false, hour: learnHour };
    const s = learner.learnStatus();
    return { enabled: true, ...s, hour: learnHour, startedAt: s.startedAt ? logTimeOut(s.startedAt) : null, finishedAt: s.finishedAt ? logTimeOut(s.finishedAt) : null };
  };

  app.get(
    '/v1/kb/ip-learning',
    {
      schema: {
        operationId: 'netops.kb.ip-learning',
        summary: '外部 IP 自動學習狀態',
        description: '執行中與否、目前階段與最近 30 行紀錄、已學過的 IP / 分組 / 筆記數、上一次結果、每天自動執行的時間(hour,-1 = 不自動)。沒有設定 AI 服務時 enabled 為 false。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.read',
        'x-gherkin': ['場景: 查詢外部 IP 自動學習狀態', '  當 呼叫 GET /api/netops/kb/ip-learning', '  那麼 回應 200', '  而且 回應有 enabled、busy、hour'].join('\n'),
        response: { 200: looseObject('{ enabled, busy, phase, done, total, log, startedAt, finishedAt, result, error, learnedIps, groups, notes, lastRun, hour }') },
      },
    },
    async () => learnOut(),
  );

  app.post<{ Body: { days?: number; max?: number; rewrite?: boolean } }>(
    '/v1/kb/ip-learnings',
    {
      schema: {
        operationId: 'netops.kb.ip-learn',
        summary: '立即學習外部 IP',
        description:
          '在背景從最近幾天(最多 30 天)的 PA TRAFFIC 排行挑出外部 IP(NETOPS_AI_SOURCE=clickhouse 時取 ClickHouse 原始 TRAFFIC 建的每小時摘要,ftp 時取 FTP 摘要),查 RDAP 與 DNS 反查後請模型整理成知識庫筆記(作者「AI 自動學習」、標籤「自動學習」);回 202 與狀態,畫面輪詢 ip-learning。' +
          'rewrite 為 true 時已學過的組織筆記全部重寫(管理者改過的筆記不覆寫)。執行中回 409 NETOPS_IPLEARN_BUSY;沒有設定 AI 回 409 NETOPS_AI_DISABLED。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.write',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 開始學習',
          '  假如 使用者擁有 netops.kb.write',
          '  當 呼叫 POST /api/netops/kb/ip-learnings 帶 days 7',
          '  那麼 回應 202 且 busy 為 true',
          '',
          '場景: 執行中再送出',
          '  假如 外部 IP 自動學習正在執行',
          '  當 呼叫 POST /api/netops/kb/ip-learnings',
          '  那麼 回應 409 NETOPS_IPLEARN_BUSY',
          '',
          '場景: 天數超過 30 天',
          '  當 呼叫 POST /api/netops/kb/ip-learnings 帶 days 31',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { days: { type: 'integer', minimum: 1, maximum: IPLEARN_MAX_DAYS, description: '看最近幾天(1–30;AC2 起上限 30)' }, max: { type: 'integer', minimum: 1, maximum: 500 }, rewrite: { type: 'boolean', default: false } },
        },
        response: ACCEPTED,
      },
    },
    async (req, reply) => {
      if (!learner) throw new AppError(409, 'NETOPS_AI_DISABLED', '尚未設定 AI 服務(LLM_URL),無法使用 AI 功能');
      if (learner.learnStatus().busy) throw new AppError(409, 'NETOPS_IPLEARN_BUSY', '外部 IP 自動學習正在執行中');
      const by = [req.identity?.emp, req.identity?.name].filter(Boolean).join(' ');
      const { days = learnDefaults.days, max = learnDefaults.max, rewrite = false } = req.body ?? {};
      void learner.learnIps({ days, max, rewrite, by }).catch((err: unknown) => log.error({ err }, '[外部 IP 學習] 執行失敗'));
      return reply.status(202).send(learnOut());
    },
  );
};

export default kbAiRoutes;

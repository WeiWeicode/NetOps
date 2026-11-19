/**
 * PA 威脅特徵碼 API(TS-2;docs/THREAT-SIGNATURE-PLAN.md §7):
 *   GET    /v1/pa-signatures                        netops.pa-signature.read
 *   GET    /v1/pa-signatures/:id                    netops.pa-signature.read
 *   GET    /v1/pa-signature-lookups/:lookupId       netops.pa-signature.read
 *   GET    /v1/pa-signature-versions                netops.pa-signature.read
 *   GET    /v1/pa-signature-versions/:version/diffs netops.pa-signature.read
 *   POST   /v1/pa-signature-hit-queries             netops.pa-signature.read(無 IP 欄位,TS-Q8)
 *   GET    /v1/pa-signature-hit-queries/:id         netops.pa-signature.read
 *   DELETE /v1/pa-signature-hit-queries/:id         netops.pa-signature.read
 *   POST   /v1/pa-signature-hit-ip-queries          netops.pa-log.read(含前 10 來源 / 目的 IP,稽核 meta,TS-Q8)
 *   GET    /v1/pa-signature-hit-ip-queries/:id      netops.pa-log.read(稽核 meta)
 *   DELETE /v1/pa-signature-hit-ip-queries/:id      netops.pa-log.read
 *   GET    /v1/pa-signature-coverage                netops.pa-policy.read(保護安全規則資料)
 *   POST   /v1/pa-signature-refreshes               netops.pa-signature.refresh(稽核 meta)
 *   GET    /v1/pa-signature-status                  netops.pa-signature.read
 *
 * 只做驗證、權限宣告與格式轉換;核心邏輯在 core.ts / service.ts。
 * TS-Q8 說明:Gateway X-Internal-Token 不含個別權限清單且每條路由只綁一個 x-permission,
 * 因此將「含 IP 的命中比對」拆到 x-permission: netops.pa-log.read 的專用路由,由 BFF 直接強制控管,不只靠前端隱藏。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { AppError } from '../../errors.js';
import { ownerOf } from '../../infra/jobs/index.js';
import { looseObject, NO_CONTENT } from '../../shared/schemas.js';
import { SIG_DAYS, SIG_SEVERITIES, type SigDays } from './core.js';
import type { HitQueryInput, PaSignatureService } from './service.js';

const SIG_ID = { type: 'string', pattern: '^\\d{1,10}$' } as const;
const VERSION = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' } as const;
const UUID_ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const HIT_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days: { type: 'integer', enum: [...SIG_DAYS], default: 30 },
    scope: { type: 'string', enum: ['new', 'ids'] },
    ids: { type: 'array', minItems: 1, maxItems: 500, items: SIG_ID },
  },
} as const;

async function withRetry<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const retry = (err as { retryAfter?: number }).retryAfter;
    if (retry) reply.header('retry-after', String(retry));
    throw err;
  }
}

interface ListQuery {
  kind?: 'vulnerability' | 'spyware';
  severity?: string;
  q?: string;
  isNew?: boolean;
  hasHits?: boolean;
  days?: SigDays;
  page?: number;
  pageSize?: number;
}

interface DiffQuery {
  kind?: 'added' | 'changed' | 'removed';
  sigKind?: 'vulnerability' | 'spyware';
  severity?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

const paSignatureRoutes: FastifyPluginAsync<{ svc: PaSignatureService }> = async (app, { svc }) => {
  app.get<{ Querystring: ListQuery }>(
    '/v1/pa-signatures',
    {
      schema: {
        operationId: 'netops.pa-signature.list',
        summary: 'PA 威脅特徵碼清單',
        description:
          'PA-560 本機弱點與間諜軟體特徵清單(收集器定期更新於 Redis);支援 kind、severity、q(名稱 / ID / CVE / Vendor)、isNew、hasHits 篩選與分頁(pageSize ≤ 100)。' +
          'days 只接受 7 / 30 / 90(預設 30),決定 isNew 範圍;歷史不足時回傳 since(基準日 YYYY-MM-DD)。AV / WildFire 只回版本與發布時間(TS-Q4)。' +
          'Redis 不可用或尚無快照時回 200 且 available false(不回 5xx)。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-gherkin': [
          '場景: 分頁查詢威脅特徵碼清單',
          '  假如 收集器已寫入 PA 威脅特徵碼快照',
          '  當 呼叫 GET /api/netops/pa-signatures?kind=vulnerability&days=30&pageSize=50',
          '  那麼 回應 200 且 available 為 true',
          '  而且 items 每筆含 id、kind、name、severity、cves、defaultAction、firstVersion、isNew',
          '',
          '場景: 不支援的天數',
          '  當 呼叫 GET /api/netops/pa-signatures?days=14',
          '  那麼 回應 400 VALIDATION_FAILED',
          '',
          '場景: Redis 尚無快照',
          '  假如 收集器尚未寫入快照',
          '  當 呼叫 GET /api/netops/pa-signatures',
          '  那麼 回應 200 且 available 為 false',
        ].join('\n'),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['vulnerability', 'spyware'] },
            severity: { type: 'string', enum: [...SIG_SEVERITIES] },
            q: { type: 'string', maxLength: 100 },
            isNew: { type: 'boolean' },
            hasHits: { type: 'boolean' },
            days: { type: 'integer', enum: [...SIG_DAYS], default: 30 },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        },
        response: { 200: looseObject('{ available, items, total, page, pageSize, threatVersion, fetchedAt, baselineAt, since, rebuilt, days, versions, counts, hitsAvailable, status, reason?, message? }') },
      },
    },
    async (req) => {
      const { days = 30, page = 1, pageSize = 50, ...filter } = req.query;
      return svc.list(filter, days, page, pageSize);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/pa-signatures/:id',
    {
      schema: {
        operationId: 'netops.pa-signature.get',
        summary: '單筆 PA 威脅特徵碼(含按需查詢)',
        description:
          '依純數字 ID 取得單筆特徵碼(抽屜用):含 firstVersion、版本異動紀錄 changes[]、近 30 天命中數與 vault(TS-5 預留)。' +
          '快照找不到時先讀 1 天按需快取;未命中且收集器已啟用時回 202 { lookupId } 交由 netops-pa 執行 show threat id <ID>(限流中回 429 NETOPS_PA_SIGNATURE_COOLDOWN)。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-gherkin': [
          '場景: 查詢快照內的特徵碼',
          '  假如 快照內有特徵碼 547000',
          '  當 呼叫 GET /api/netops/pa-signatures/547000',
          '  那麼 回應 200 且 found 為 true、source 為 "snapshot"',
          '',
          '場景: 快照沒有時送收集器按需查詢',
          '  假如 快照沒有特徵碼 999999 且收集器已啟用',
          '  當 呼叫 GET /api/netops/pa-signatures/999999',
          '  那麼 回應 202 且含 lookupId',
        ].join('\n'),
        params: { type: 'object', required: ['id'], properties: { id: SIG_ID } },
        response: {
          200: looseObject('{ found, source, item?, message?, threatVersion?, fetchedAt?, baselineAt?, rebuilt? }'),
          202: looseObject('{ lookupId, id, status }'),
        },
      },
    },
    async (req, reply) =>
      withRetry(reply, async () => {
        const owner = ownerOf(req.identity);
        if (!owner) throw new AppError(403, 'NETOPS_JOB_OWNER_UNKNOWN', '無法識別使用者');
        const r = await svc.get(req.params.id, owner);
        return reply.status(r.status).send(r.body);
      }),
  );

  app.get<{ Params: { lookupId: string } }>(
    '/v1/pa-signature-lookups/:lookupId',
    {
      schema: {
        operationId: 'netops.pa-signature-lookup.get',
        summary: '查詢按需單筆特徵碼結果',
        description: '輪詢 GET /pa-signatures/{id} 回傳 202 的按需查詢(show threat id)工作結果;只有建立者本人可查,別人或逾期回 404 NETOPS_PA_SIGNATURE_LOOKUP_NOT_FOUND。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-gherkin': [
          '場景: 取得按需查詢結果',
          '  假如 收集器已完成 lookupId 的 show threat id 查詢',
          '  當 呼叫 GET /api/netops/pa-signature-lookups/{lookupId}',
          '  那麼 回應 200 且 status 為 "done"、result 含 description / subtype / severity',
          '',
          '場景: 查詢別人的工作',
          '  當 另一位使用者呼叫 GET /api/netops/pa-signature-lookups/{lookupId}',
          '  那麼 回應 404 NETOPS_PA_SIGNATURE_LOOKUP_NOT_FOUND',
        ].join('\n'),
        params: { type: 'object', required: ['lookupId'], properties: { lookupId: { type: 'string', format: 'uuid' } } },
        response: { 200: looseObject('{ lookupId, threatId, status, createdAt, startedAt, finishedAt, cached, mgmtCpu, result, error, message }') },
      },
    },
    async (req) => {
      const owner = ownerOf(req.identity);
      if (!owner) throw new AppError(403, 'NETOPS_JOB_OWNER_UNKNOWN', '無法識別使用者');
      return svc.getLookup(req.params.lookupId, owner);
    },
  );

  app.get(
    '/v1/pa-signature-versions',
    {
      schema: {
        operationId: 'netops.pa-signature-version.list',
        summary: 'PA 威脅特徵碼內容版本清單',
        description:
          '列出 infra/store 保存的內容版本歷史(新到舊,保留最近 90 份,只存差異與摘要不存全量);含持久基準日 baselineAt(第一份基準版本不算新增,D2)。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-gherkin': [
          '場景: 列出內容版本歷史',
          '  假如 已有基準版與一次內容版本更新',
          '  當 呼叫 GET /api/netops/pa-signature-versions',
          '  那麼 回應 200 且 total 為 2、baselineAt 為基準版時間',
        ].join('\n'),
        response: { 200: looseObject('{ baselineAt, baselineVersion, items, total }') },
      },
    },
    async () => svc.versions(),
  );

  app.get<{ Params: { version: string }; Querystring: DiffQuery }>(
    '/v1/pa-signature-versions/:version/diffs',
    {
      schema: {
        operationId: 'netops.pa-signature-version.diff',
        summary: 'PA 威脅特徵碼版本差異',
        description:
          '分頁列出指定內容版本相對於前一版的新增(added)、變更(changed,含異動欄位前後值)、停用/移除(removed)特徵。版本不存在回 404 NETOPS_PA_SIGNATURE_VERSION_NOT_FOUND。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-gherkin': [
          '場景: 查看單版差異',
          '  假如 內容版本 9174-10355 有新增與變更特徵',
          '  當 呼叫 GET /api/netops/pa-signature-versions/9174-10355/diffs?kind=added',
          '  那麼 回應 200 且 items 列出新增特徵、summary 含 added / changed / removed 筆數',
          '',
          '場景: 版本不存在',
          '  當 呼叫 GET /api/netops/pa-signature-versions/0000-0000/diffs',
          '  那麼 回應 404 NETOPS_PA_SIGNATURE_VERSION_NOT_FOUND',
        ].join('\n'),
        params: { type: 'object', required: ['version'], properties: { version: VERSION } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['added', 'changed', 'removed'] },
            sigKind: { type: 'string', enum: ['vulnerability', 'spyware'] },
            severity: { type: 'string', enum: [...SIG_SEVERITIES] },
            q: { type: 'string', maxLength: 100 },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        },
        response: { 200: looseObject('{ threatVersion, baseVersion, releaseDate, fetchedAt, savedAt, isBaseline, rebuilt, counts, summary, items, total, page, pageSize }') },
      },
    },
    async (req) => {
      const { page = 1, pageSize = 50, ...rest } = req.query;
      return svc.versionDiffs(req.params.version, { ...rest, page, pageSize });
    },
  );

  // 命中比對(無 IP 欄位,只需 netops.pa-signature.read,TS-Q8)
  app.post<{ Body: HitQueryInput }>(
    '/v1/pa-signature-hit-queries',
    {
      schema: {
        operationId: 'netops.pa-signature-hit-query.create',
        summary: 'PA 威脅特徵碼命中比對(統計與動作分布,不含 IP)',
        description:
          '依 ClickHouse pa_threat_logs(log_type=threat)比對指定特徵 ID(上限 500)或近 N 天新特徵碼(days 限 7 / 30 / 90,預設 30)的命中數、時間、動作分布與規則覆蓋標註;本路由不含來源 / 目的 IP(TS-Q8)。' +
          '30 天內在 8 秒內完成回 200,超過或 90 天回 202 工作狀態(GET /pa-signature-hit-queries/{id} 輪詢,D6)。ClickHouse 不可用回 424 NETOPS_PA_SIGNATURE_CH_UNAVAILABLE。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-timeout-ms': 15000,
        'x-gherkin': [
          '場景: 查詢近 30 天新特徵碼命中統計(無 IP)',
          '  假如 ClickHouse 有新特徵碼命中紀錄',
          '  當 呼叫 POST /api/netops/pa-signature-hit-queries 帶 days 30',
          '  那麼 回應 200 且 includeIps 為 false',
          '  而且 items 不含 topSrc 與 topDst 欄位',
        ].join('\n'),
        body: HIT_BODY,
        response: {
          200: looseObject('{ days, since, from, to, scope, includeIps, queriedIds, truncatedIds, items }'),
          202: looseObject('{ id, jobId, kind, status, createdAt }'),
        },
      },
    },
    async (req, reply) => {
      const owner = ownerOf(req.identity);
      const r = await svc.startHitQuery(owner, req.body ?? {}, false);
      return reply.status(r.status).send(r.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/pa-signature-hit-queries/:id',
    {
      schema: {
        operationId: 'netops.pa-signature-hit-query.get',
        summary: '查詢特徵碼命中比對工作(無 IP)',
        description: '輪詢 POST /pa-signature-hit-queries 回傳 202 的工作狀態與結果(不含 IP);只有建立者本人可查。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-gherkin': [
          '場景: 查詢命中比對工作結果',
          '  假如 使用者已建立命中比對工作',
          '  當 呼叫 GET /api/netops/pa-signature-hit-queries/{id}',
          '  那麼 回應 200 且含 status 與 result(不含 IP)',
        ].join('\n'),
        params: UUID_ID,
        response: { 200: looseObject('工作狀態(docs/API.md §1.1)') },
      },
    },
    async (req) => svc.getHitJob(req.params.id, ownerOf(req.identity), false),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/pa-signature-hit-queries/:id',
    {
      schema: {
        operationId: 'netops.pa-signature-hit-query.cancel',
        summary: '取消特徵碼命中比對工作(無 IP)',
        description: '取消或移除自己建立的命中比對工作(冪等,一律回 204)。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-gherkin': ['場景: 取消命中比對工作', '  當 呼叫 DELETE /api/netops/pa-signature-hit-queries/{id}', '  那麼 回應 204'].join('\n'),
        params: UUID_ID,
        response: { 204: NO_CONTENT },
      },
    },
    async (req, reply) => {
      svc.cancelHitJob(req.params.id, ownerOf(req.identity), false);
      return reply.status(204).send();
    },
  );

  // 命中比對含 IP(需 netops.pa-log.read,BFF 強制檢查,稽核 meta,TS-Q8)
  app.post<{ Body: HitQueryInput }>(
    '/v1/pa-signature-hit-ip-queries',
    {
      schema: {
        operationId: 'netops.pa-signature-hit-ip-query.create',
        summary: 'PA 威脅特徵碼命中比對(含前 10 來源 / 目的 IP)',
        description:
          '同 POST /pa-signature-hit-queries,另附每個特徵碼前 10 來源 / 目的 IP(topSrc、topDst);須具 Log 明細權限 netops.pa-log.read 並記錄 meta 稽核(TS-Q8)。' +
          'IP 名稱對照由前端另呼叫 POST /ip-name-lookups(需 netops.ip-name.read),不附於本回應。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-log.read',
        'x-audit-level': 'meta',
        'x-timeout-ms': 15000,
        'x-gherkin': [
          '場景: 具 Log 明細權限查詢命中比對含 IP',
          '  假如 使用者擁有 netops.pa-log.read',
          '  當 呼叫 POST /api/netops/pa-signature-hit-ip-queries 帶 days 30',
          '  那麼 回應 200 且 includeIps 為 true',
          '  而且 items 含 topSrc 與 topDst(各前 10 個 IP)',
        ].join('\n'),
        body: HIT_BODY,
        response: {
          200: looseObject('{ days, since, from, to, scope, includeIps, queriedIds, truncatedIds, items }'),
          202: looseObject('{ id, jobId, kind, status, createdAt }'),
        },
      },
    },
    async (req, reply) => {
      const owner = ownerOf(req.identity);
      const r = await svc.startHitQuery(owner, req.body ?? {}, true);
      return reply.status(r.status).send(r.body);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/pa-signature-hit-ip-queries/:id',
    {
      schema: {
        operationId: 'netops.pa-signature-hit-ip-query.get',
        summary: '查詢特徵碼命中比對工作(含 IP)',
        description: '輪詢 POST /pa-signature-hit-ip-queries 回傳 202 的工作狀態與結果(含前 10 來源 / 目的 IP);只有建立者本人可查。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-log.read',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 查詢含 IP 的命中比對工作結果',
          '  假如 使用者已建立含 IP 命中比對工作',
          '  當 呼叫 GET /api/netops/pa-signature-hit-ip-queries/{id}',
          '  那麼 回應 200 且含 status 與 result',
        ].join('\n'),
        params: UUID_ID,
        response: { 200: looseObject('工作狀態(docs/API.md §1.1)') },
      },
    },
    async (req) => svc.getHitJob(req.params.id, ownerOf(req.identity), true),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/pa-signature-hit-ip-queries/:id',
    {
      schema: {
        operationId: 'netops.pa-signature-hit-ip-query.cancel',
        summary: '取消特徵碼命中比對工作(含 IP)',
        description: '取消或移除自己建立的含 IP 命中比對工作(冪等,一律回 204)。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-log.read',
        'x-gherkin': ['場景: 取消含 IP 命中比對工作', '  當 呼叫 DELETE /api/netops/pa-signature-hit-ip-queries/{id}', '  那麼 回應 204'].join('\n'),
        params: UUID_ID,
        response: { 204: NO_CONTENT },
      },
    },
    async (req, reply) => {
      svc.cancelHitJob(req.params.id, ownerOf(req.identity), true);
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/pa-signature-coverage',
    {
      schema: {
        operationId: 'netops.pa-signature-coverage.list',
        summary: 'PA 安全規則威脅防護覆蓋缺口',
        description:
          '比對 PA 安全規則快照與 vsys1 Profile Group,找出 action=allow、啟用中且缺少弱點防護或間諜軟體 profile 的規則(TS-Q5 第一版只看有沒有掛,不判斷 profile 內容);' +
          '群組不存在或讀不到 profile 時標為 unknown(無法判定,不當成有防護)。需 netops.pa-policy.read 保護安全規則資料。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-policy.read',
        'x-gherkin': [
          '場景: 列出缺少威脅防護 profile 的 allow 規則',
          '  假如 規則 Allow-Web 為 allow 且未掛弱點防護 profile',
          '  當 呼叫 GET /api/netops/pa-signature-coverage',
          '  那麼 回應 200 且 items 含 Allow-Web、missing 含 "vulnerability"',
          '',
          '場景: Profile Group 不存在時標為無法判定',
          '  假如 規則掛了 vsys1 查不到的群組',
          '  當 呼叫 GET /api/netops/pa-signature-coverage',
          '  那麼 該規則 status 為 "unknown"',
        ].join('\n'),
        response: { 200: looseObject('{ available, policyFetchedAt?, profilesFetchedAt?, profilesAvailable?, summary, items, reason?, message? }') },
      },
    },
    async () => svc.coverage(),
  );

  app.post(
    '/v1/pa-signature-refreshes',
    {
      schema: {
        operationId: 'netops.pa-signature.refresh',
        summary: '手動重新整理 PA 威脅特徵碼',
        description:
          '請收集器(netops-pa)重新讀取 PA 威脅特徵碼與 vsys1 profile(全系統冷卻 5 分鐘;收集器端另有 60 秒最短間隔與 CPU 50% 保護)。' +
          '回 202 { requestedAt, cooldownSec }。冷卻中回 429 NETOPS_PA_SIGNATURE_COOLDOWN(Retry-After);未啟用回 409 NETOPS_PA_SIGNATURE_DISABLED;Redis 不可用回 424 NETOPS_PA_SIGNATURE_UNAVAILABLE。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.refresh',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 手動重新整理威脅特徵碼',
          '  假如 使用者擁有 netops.pa-signature.refresh 且未在冷卻期',
          '  當 呼叫 POST /api/netops/pa-signature-refreshes',
          '  那麼 回應 202',
          '',
          '場景: 冷卻中',
          '  假如 5 分鐘內剛觸發過手動更新',
          '  當 呼叫 POST /api/netops/pa-signature-refreshes',
          '  那麼 回應 429 NETOPS_PA_SIGNATURE_COOLDOWN',
        ].join('\n'),
        response: { 202: looseObject('{ requestedAt, cooldownSec }') },
      },
    },
    async (req, reply) =>
      withRetry(reply, async () => {
        const by = ownerOf(req.identity);
        if (!by) throw new AppError(403, 'NETOPS_JOB_OWNER_UNKNOWN', '無法識別使用者,不能重新整理');
        return reply.status(202).send(await svc.refresh(by));
      }),
  );

  app.get(
    '/v1/pa-signature-status',
    {
      schema: {
        operationId: 'netops.pa-signature-status.get',
        summary: 'PA 威脅特徵碼收集狀態',
        description: '收集器狀態(collectorEnabled、state、lastRunAt、lastOkAt、mgmtCpu、threatVersion、冷卻剩餘秒數)與歷史版本數 / 基準日。Redis 不可用時回 200 且 available false(不回 5xx)。',
        tags: ['PA 威脅特徵碼'],
        'x-permission': 'netops.pa-signature.read',
        'x-gherkin': [
          '場景: 查詢威脅特徵碼收集狀態',
          '  當 呼叫 GET /api/netops/pa-signature-status',
          '  那麼 回應 200 且含 available、baselineAt、versionCount',
        ].join('\n'),
        response: { 200: looseObject('{ available, collectorEnabled?, state?, message?, lastRunAt?, lastOkAt?, mgmtCpu?, threatVersion?, refreshCooldownSec?, lookupCooldownSec?, baselineAt, versionCount, reason? }') },
      },
    },
    async () => svc.status(),
  );
};

export default paSignatureRoutes;

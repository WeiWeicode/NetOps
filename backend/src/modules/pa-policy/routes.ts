/**
 * PA 安全規則 API(PR-2;docs/WARROOM-DIRECTION-POLICY-PLAN.md §3.3):
 *   GET  /v1/pa-policies、/v1/pa-policies/{name}、/v1/pa-policy-versions、/v1/pa-policy-versions/{id}/diffs  netops.pa-policy.read
 *   POST /v1/pa-policy-refreshes                                                                       netops.pa-policy.refresh
 * 只做驗證、權限宣告與格式轉換;netops-api 不連 PA(§3.2 ④),重新整理只放請求給 netops-pa。
 * 回應不含姓名等個資(IP 對照由前端另外查,§3.6)。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { AppError } from '../../errors.js';
import { ownerOf } from '../../infra/jobs/index.js';
import { looseObject } from '../../shared/schemas.js';
import { parseIpFilter, type RuleFilter } from './core.js';
import type { PaPolicyService } from './service.js';

const VERSION_ID = { type: 'string', pattern: '^\\d{8}T\\d{9}Z-[0-9a-f]{12}$' } as const;

interface ListQuery {
  q?: string;
  zone?: string;
  ip?: string;
  includeAny?: boolean;
  application?: string;
  action?: string;
  unusedDays?: number;
  disabled?: boolean;
  page?: number;
  pageSize?: number;
}

async function withRetry<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const retry = (err as { retryAfter?: number }).retryAfter;
    if (retry) reply.header('retry-after', String(retry));
    throw err;
  }
}

const paPolicyRoutes: FastifyPluginAsync<{ svc: PaPolicyService }> = async (app, { svc }) => {
  app.get<{ Querystring: ListQuery }>(
    '/v1/pa-policies',
    {
      schema: {
        operationId: 'netops.pa-policy.list',
        summary: 'PA 安全規則清單',
        description:
          'PA-560 安全規則(收集器每 30 分鐘讀一次的快照),依 PA 比對順序 position(1 起算,同 PA GUI 編號)排序;篩選後仍回原編號。' +
          '每條含快照欄位、hits(命中數、最後命中;沒有資料為 null)與 expanded(來源 / 目的位址、服務、應用的物件展開;FQDN、動態群組、地區等 unresolved)。' +
          '篩選:q(名稱 / 說明 / 標籤)、zone、ip(逗號分隔 IPv4 / CIDR / a-b,最多 50 個,比對展開後的位址;includeAny=true 才含 any)、application、action、unusedDays(長期未命中 N 天)、disabled。' +
          '回應另含 fetchedAt、hash、versionId、stale(超過 2 小時沒更新)、hitsFetchedAt、status(收集狀態與手動重新整理冷卻秒數)、defaults(intrazone-default / interzone-default 的命中數)。' +
          'netops-redis 不可用或還沒有快照時回 200、available false 與 reason / message(不回假資料)。',
        tags: ['PA 安全規則'],
        'x-permission': 'netops.pa-policy.read',
        'x-gherkin': [
          '場景: 依 PA 順序列出規則',
          '  假如 收集器已讀到 166 條規則',
          '  當 呼叫 GET /api/netops/pa-policies?pageSize=100',
          '  那麼 回應 200 且 total 為 166',
          '  而且 items 依 position 由小到大',
          '',
          '場景: 依 IP 篩選展開後的位址',
          '  假如 規則 A 的來源是位址群組,群組內有 10.10.48.0/24',
          '  當 呼叫 GET /api/netops/pa-policies?ip=10.10.48.5',
          '  那麼 items 含規則 A 且 position 為原編號',
          '',
          '場景: 還沒有快照',
          '  假如 收集器未啟用安全規則收集',
          '  當 呼叫 GET /api/netops/pa-policies',
          '  那麼 回應 200 且 available 為 false',
        ].join('\n'),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 100 },
            zone: { type: 'string', maxLength: 64 },
            ip: { type: 'string', maxLength: 2000 },
            includeAny: { type: 'boolean' },
            application: { type: 'string', maxLength: 100 },
            action: { type: 'string', enum: ['allow', 'deny', 'drop', 'reset-client', 'reset-server', 'reset-both'] },
            unusedDays: { type: 'integer', minimum: 1, maximum: 3650 },
            disabled: { type: 'boolean' },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 100 },
          },
        },
        response: { 200: looseObject('{ available, items, total, page, pageSize, defaults, fetchedAt, hash, versionId, stale, hitsFetchedAt, ruleCount, status, reason?, message? }') },
      },
    },
    async (req) => {
      const { ip, page = 1, pageSize = 100, ...rest } = req.query;
      const filter: RuleFilter = { ...rest };
      if (ip !== undefined) {
        const ips = parseIpFilter(ip);
        if (!ips) throw new AppError(400, 'VALIDATION_FAILED', '參數驗證失敗', [{ field: 'ip', message: 'IPv4、CIDR 或 a-b 範圍,逗號分隔,最多 50 個(第一版只支援 IPv4)' }]);
        filter.ips = ips;
      }
      return svc.list(filter, page, pageSize);
    },
  );

  app.get<{ Params: { name: string } }>(
    '/v1/pa-policies/:name',
    {
      schema: {
        operationId: 'netops.pa-policy.get',
        summary: '單條 PA 安全規則',
        description: '一條規則的完整內容(同清單 items 的一筆,含物件展開與命中數),外加 fetchedAt、hash、versionId、stale、status。名稱完全比對(要 URL 編碼)。找不到回 404 NETOPS_PA_POLICY_NOT_FOUND;沒有快照回 404 NETOPS_PA_POLICY_UNAVAILABLE。',
        tags: ['PA 安全規則'],
        'x-permission': 'netops.pa-policy.read',
        'x-gherkin': [
          '場景: 查看規則內容',
          '  假如 有規則 "Allow-Web"',
          '  當 呼叫 GET /api/netops/pa-policies/Allow-Web',
          '  那麼 回應 200 且 rule.expanded.sources 列出展開後的網段',
          '',
          '場景: 規則已刪除',
          '  當 呼叫 GET /api/netops/pa-policies/不存在的規則',
          '  那麼 回應 404 NETOPS_PA_POLICY_NOT_FOUND',
        ].join('\n'),
        params: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 128 } } },
        response: { 200: looseObject('{ available, rule, fetchedAt, hash, versionId, stale, status }') },
      },
    },
    async (req) => svc.get(req.params.name),
  );

  app.post(
    '/v1/pa-policy-refreshes',
    {
      schema: {
        operationId: 'netops.pa-policy.refresh',
        summary: '手動重新整理 PA 安全規則',
        description:
          '請收集器(netops-pa)盡快重新讀取規則與命中數(全系統每 5 分鐘一次;收集器端另有 60 秒最短間隔;管理平面 CPU 超過門檻時收集器不讀,結果看清單的 status)。' +
          '回 202 { requestedAt, cooldownSec }。冷卻中回 429 NETOPS_PA_POLICY_REFRESH_COOLDOWN(details.retryAfter、Retry-After);收集器未啟用回 409 NETOPS_PA_POLICY_DISABLED;netops-redis 不可用回 424 NETOPS_REDIS_UNAVAILABLE。',
        tags: ['PA 安全規則'],
        'x-permission': 'netops.pa-policy.refresh',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 手動重新整理',
          '  假如 使用者擁有 netops.pa-policy.refresh 且 5 分鐘內沒有人重新整理',
          '  當 呼叫 POST /api/netops/pa-policy-refreshes',
          '  那麼 回應 202',
          '',
          '場景: 冷卻中',
          '  假如 2 分鐘前有人重新整理',
          '  當 呼叫 POST /api/netops/pa-policy-refreshes',
          '  那麼 回應 429 NETOPS_PA_POLICY_REFRESH_COOLDOWN',
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
    '/v1/pa-policy-versions',
    {
      schema: {
        operationId: 'netops.pa-policy-version.list',
        summary: 'PA 安全規則版本清單',
        description: '規則或物件內容變了才存一版(雜湊比對;命中數不算),保留最近 50 份,新到舊:{ items: [{ id, hash, fetchedAt, savedAt, ruleCount }], total }。fetchedAt 是收集器讀到這版的時間,不是 PA 的 Commit 時間。',
        tags: ['PA 安全規則'],
        'x-permission': 'netops.pa-policy.read',
        'x-gherkin': ['場景: 列出版本', '  假如 規則改過 2 次', '  當 呼叫 GET /api/netops/pa-policy-versions', '  那麼 回應 200 且 total 為 3'].join('\n'),
        response: { 200: looseObject('{ items, total }') },
      },
    },
    async () => svc.versions(),
  );

  app.get<{ Params: { id: string }; Querystring: { base?: string } }>(
    '/v1/pa-policy-versions/:id/diffs',
    {
      schema: {
        operationId: 'netops.pa-policy-version.diff',
        summary: 'PA 安全規則版本差異',
        description:
          '版本 id 相對於 base(省略時為前一個版本)的差異:rules 逐條列出 added / removed / moved(相對順序改變;單純因插入而位移的不算)/ changed,含 position、basePosition 與 fields [{ field, before, after }];' +
          'objects 依種類列出新增 / 刪除 / 修改的物件名稱。第一個版本沒有前一版時 baseId 為 null、清單為空。版本不存在回 404 NETOPS_PA_POLICY_VERSION_NOT_FOUND。',
        tags: ['PA 安全規則'],
        'x-permission': 'netops.pa-policy.read',
        'x-gherkin': [
          '場景: 看這次改了什麼',
          '  假如 新版本把規則 B 移到規則 A 前面並新增規則 C',
          '  當 呼叫 GET /api/netops/pa-policy-versions/{id}/diffs',
          '  那麼 rules 含 B 的 moved 與 C 的 added',
          '',
          '場景: 版本已被清除',
          '  當 呼叫 GET /api/netops/pa-policy-versions/20200101T000000000Z-000000000000/diffs',
          '  那麼 回應 404 NETOPS_PA_POLICY_VERSION_NOT_FOUND',
        ].join('\n'),
        params: { type: 'object', required: ['id'], properties: { id: VERSION_ID } },
        querystring: { type: 'object', additionalProperties: false, properties: { base: VERSION_ID } },
        response: { 200: looseObject('{ id, baseId, version, base, rules, objects }') },
      },
    },
    async (req) => svc.diff(req.params.id, req.query.base),
  );
};

export default paPolicyRoutes;

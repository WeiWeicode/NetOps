/**
 * AD FTP 對帳與補漏(AD-3;docs/AD-AGENT-PLAN.md §5、§6.1;路徑與 PA 一致,需求方 2026-11-24 D4):
 *   GET  /v1/ad/reconciliations      對帳結果(期間內每天,即時計算;netops.ftp.read)
 *   POST /v1/ad/reconciliations      立即對帳一天(netops.ftp.write)
 *   POST /v1/ad/backfills            把一天的缺口交給 netops-ingest 從 FTP 補寫(netops.ftp.write)
 *   GET  /v1/ad/backfills/{id}       補漏工作狀態(netops.ftp.read)
 * 路由只做驗證與格式轉換;對帳在 reconcile.ts,補漏在 netops-ingest(ingest/ad-backfill.ts)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import { ownerOf } from '../../infra/jobs/index.js';
import type { AdBackfillJob, AdBackfillQueue } from '../../infra/redis/ad-backfill.js';
import { DAY, dayRangeQuery, looseObject } from '../../shared/schemas.js';
import { dayIn, dayOut, dayRange, validation } from '../../shared/time.js';
import type { AdReconDay, AdReconciler } from './reconcile.js';
import { adChUnavailable } from './source.js';

const out = (r: AdReconDay) => ({ ...r, day: dayOut(r.day) });
/** 工作輸出:檔案只回檔名(不回 FTP 目錄) */
const jobOut = (j: AdBackfillJob) => ({ ...j, day: dayOut(j.day), files: j.files.map((f) => f.slice(f.lastIndexOf('/') + 1)) });
const redisDown = () => new AppError(424, 'NETOPS_REDIS_UNAVAILABLE', 'netops-redis 暫時無法使用');
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const CHANNEL = { type: 'string', enum: ['Security', 'System', 'Directory_Service', 'DNS_Server'] } as const;

const adReconRoutes: FastifyPluginAsync<{ recon: AdReconciler | null; queue: AdBackfillQueue | null }> = async (app, { recon, queue }) => {
  const need = () => {
    if (!recon) throw adChUnavailable();
    return recon;
  };
  const via = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ClickHouseError) throw adChUnavailable({ code: err.code, status: err.status });
      throw err;
    }
  };
  /** 只能對帳 ad_events 與 FTP 保留期內、昨天以前的日子 */
  const inWindow = (day: string, field: string) => {
    if (!need().window().includes(day)) throw validation(field, '只能對帳 AD 事件與 FTP 保留期間內、昨天以前的日子');
  };

  app.get<{ Querystring: { from: string; to?: string } }>(
    '/v1/ad/reconciliations',
    {
      schema: {
        operationId: 'netops.ad-recon.list',
        summary: 'AD 對帳結果',
        description:
          '期間內每天 AD 的 FTP CSV 筆數與 ClickHouse ad_events 筆數比對(即時計算,新的在前)。items 每個 (DC, 記錄) 一列:ftp、ch(chAgent Agent 寫入、chFtp FTP 補寫)、diff = ftp − ch、status(ok / gap 有缺口 / excess 多出)。Security 只比 FTP 匯出的 23 種事件。日子的 status:ok、gap、excess、pending(FTP 這天還沒匯入)、ftp-error(匯入時有檔案讀取失敗)。只列 AD 事件與 FTP 保留期間內、昨天以前的日子(期間外的日子不回)。backfills 為本次程序啟動後從這一天建立的補漏工作 id。ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': ['場景: 查詢 AD 對帳結果', '  當 呼叫 GET /api/netops/ad/reconciliations?from=2026-11-20&to=2026-11-23', '  那麼 回應 200', '  而且 items 為每天的對帳結果'].join('\n'),
        querystring: dayRangeQuery(),
        response: { 200: looseObject('{ items, window }') },
      },
    },
    async (req) => {
      const { from, to } = dayRange(req.query);
      const r = need();
      const days = r.window().filter((d) => d >= from && d <= to);
      const items = await via(() => Promise.all(days.map((d) => r.reconcile(d))));
      const w = r.window();
      return { items: items.map(out), window: w.length ? { from: dayOut(w[w.length - 1]!), to: dayOut(w[0]!) } : null };
    },
  );

  app.post<{ Body: { day: string } }>(
    '/v1/ad/reconciliations',
    {
      schema: {
        operationId: 'netops.ad-recon.run',
        summary: 'AD 立即對帳一天',
        description: '比對這一天每個 (DC, 記錄) 的 FTP CSV 筆數(已匯入的 AD 資料,不讀 FTP)與 ClickHouse ad_events 筆數,回傳結果。日子不在保留期間內回 400;ClickHouse 無法使用回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-audit-level': 'meta',
        'x-gherkin': ['場景: 立即對帳', '  當 呼叫 POST /api/netops/ad/reconciliations 帶 day "2026-11-23"', '  那麼 回應 200', '  而且 status 為 ok、gap、excess、pending 或 ftp-error'].join('\n'),
        body: { type: 'object', required: ['day'], additionalProperties: false, properties: { day: DAY } },
        response: { 200: looseObject('AdReconDay') },
      },
    },
    async (req) => {
      const day = dayIn(req.body.day, 'day');
      inWindow(day, 'day');
      return out(await via(() => need().reconcile(day)));
    },
  );

  app.post<{ Body: { day: string; scope?: { computer: string; channel: string }[] } }>(
    '/v1/ad/backfills',
    {
      schema: {
        operationId: 'netops.ad-backfill.create',
        summary: 'AD FTP 補漏(送出工作)',
        description:
          '先重新對帳這一天,再把有缺口(gap)的 (DC, 記錄) 交給 netops-ingest:從 FTP 讀這一天的 CSV,只補寫 (computer, channel, log_epoch, record_id) 不在 ClickHouse 的列(source = ftp,不刪除既有資料)。scope 可只補其中幾個 (DC, 記錄)。Event Log 世代依「CSV 分段錨定 + 水位保護」判定:RecordID 大於 Agent 水位的列 Agent 之後還會送,不補(waitingAgent);判斷不出世代的列不寫(ambiguous)。回 202 與工作;FTP 還沒匯入回 409 NETOPS_RECON_PENDING;沒有缺口回 409 NETOPS_BACKFILL_NOTHING;佇列已滿回 409 NETOPS_BACKFILL_BUSY;日子不在保留期間內回 400。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-audit-level': 'body',
        'x-gherkin': [
          '場景: 送出 AD 補漏',
          '  假如 2026-11-23 GSMC-DC1 的 Security 有缺口',
          '  當 呼叫 POST /api/netops/ad/backfills 帶 day "2026-11-23"',
          '  那麼 回應 202',
          '  而且 之後 GET /api/netops/ad/backfills/{id} 的 state 會變成 "done",inserted 為補寫的筆數',
          '',
          '場景: 沒有缺口',
          '  當 呼叫 POST /api/netops/ad/backfills 的那天沒有缺口',
          '  那麼 回應 409 NETOPS_BACKFILL_NOTHING',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['day'],
          additionalProperties: false,
          properties: {
            day: DAY,
            scope: {
              type: 'array',
              maxItems: 100,
              items: { type: 'object', required: ['computer', 'channel'], additionalProperties: false, properties: { computer: { type: 'string', pattern: '^[\\w.-]{1,64}$' }, channel: CHANNEL } },
            },
          },
        },
        response: { 202: looseObject('AdBackfillJob') },
      },
    },
    async (req, reply) => {
      const day = dayIn(req.body.day, 'day');
      inWindow(day, 'day');
      const r = await via(() =>
        need()
          .backfill(day, ownerOf(req.identity), req.body.scope)
          .catch((e) => {
            if (e instanceof ClickHouseError || e instanceof AppError) throw e;
            throw redisDown();
          }),
      );
      if (r === 'no-queue') throw redisDown();
      if (r === 'pending') throw new AppError(409, 'NETOPS_RECON_PENDING', '這一天的 AD FTP 檔案還沒匯入,請先到「AD › FTP Log 檔案」同步後再補漏');
      if (r === 'nothing') throw new AppError(409, 'NETOPS_BACKFILL_NOTHING', '這一天沒有需要補漏的 DC 與記錄');
      if (r === 'busy') throw new AppError(409, 'NETOPS_BACKFILL_BUSY', '補漏佇列已滿,請等前面的工作完成');
      return reply.status(202).send(jobOut(r));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/ad/backfills/:id',
    {
      schema: {
        operationId: 'netops.ad-backfill.get',
        summary: 'AD FTP 補漏(查詢工作)',
        description:
          '補漏工作的狀態(queued、running、done、failed)與筆數:read(CSV 讀到屬於這一天與範圍的列)、skipped(已在 ClickHouse)、inserted(補寫)、waitingAgent(RecordID 大於 Agent 水位,等 Agent 送,隔天對帳再看)、ambiguous(判斷不出世代,未寫入,需人工確認)、invalid(沒有 RecordID 或時間不正確)。保留 7 天;不存在回 404 NETOPS_BACKFILL_NOT_FOUND。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': ['場景: 查詢 AD 補漏工作', '  當 呼叫 GET /api/netops/ad/backfills/{id}', '  那麼 回應 200', '  而且 回應含 state、read、skipped、inserted、waitingAgent、ambiguous'].join('\n'),
        params: ID,
        response: { 200: looseObject('AdBackfillJob') },
      },
    },
    async (req) => {
      if (!queue) throw redisDown();
      const job = await queue.get(req.params.id).catch(() => {
        throw redisDown();
      });
      if (!job) throw new AppError(404, 'NETOPS_BACKFILL_NOT_FOUND', '找不到補漏工作(已超過 7 天或不存在)');
      return jobOut(job);
    },
  );
};

export default adReconRoutes;

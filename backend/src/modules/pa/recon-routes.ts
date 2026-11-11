/**
 * FTP 對帳與補漏(C3;docs/API.md §5.3、ARCHITECTURE D33、手冊 §11):
 *   GET  /v1/pa/reconciliations       每日對帳結果(netops.ftp.read)
 *   POST /v1/pa/reconciliations       立即對帳一天(netops.ftp.write)
 *   POST /v1/pa/backfills             把一天的缺口交給 netops-ingest 從 FTP 補寫(netops.ftp.write)
 *   GET  /v1/pa/backfills/{id}        補漏工作狀態(netops.ftp.read)
 * 路由只做驗證與格式轉換;對帳在 reconcile.ts,補漏在 netops-ingest(ingest/backfill.ts)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import type { BackfillJob, BackfillQueue } from '../../infra/redis/backfill.js';
import { DAY, dayRangeQuery, looseObject } from '../../shared/schemas.js';
import { dayIn, dayOut, dayRange, logTimeOut, taipeiDayStartMs, taipeiHourKey, validation } from '../../shared/time.js';
import { ClickHouseError } from '../../infra/clickhouse/index.js';
import { ownerOf } from '../../infra/jobs/index.js';
import { unavailable } from './ch-overview.js';
import { RECON_THRESHOLD, type ReconDay, type Reconciler } from './reconcile.js';

const out = (r: ReconDay) => ({ ...r, day: dayOut(r.day), hours: r.hours.map((h) => ({ ...h, hour: logTimeOut(h.hour) })) });
const jobOut = (j: BackfillJob) => ({ ...j, day: dayOut(j.day), hours: j.hours.map((h) => ({ hour: logTimeOut(taipeiHourKey(h.hour)), files: h.files.length })) });
/** netops-redis 讀寫失敗:同即時監控用 424(不用 5xx,避免累積 BFF 斷路器失敗;API.md §8) */
const redisDown = () => new AppError(424, 'NETOPS_REDIS_UNAVAILABLE', 'netops-redis 暫時無法使用');
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

const reconRoutes: FastifyPluginAsync<{ recon: Reconciler | null; queue: BackfillQueue | null }> = async (app, { recon, queue }) => {
  const need = () => {
    if (!recon) throw unavailable();
    return recon;
  };
  /** 對帳要查 ClickHouse:失敗回 503(原文只記代碼) */
  const run = async (day: string) => {
    try {
      return await need().reconcile(day);
    } catch (err) {
      if (err instanceof ClickHouseError) throw unavailable({ code: err.code, status: err.status });
      throw err;
    }
  };

  app.get<{ Querystring: { from: string; to?: string } }>(
    '/v1/pa/reconciliations',
    {
      schema: {
        operationId: 'netops.pa-recon.list',
        summary: 'FTP 與 ClickHouse 每日對帳結果',
        description: `已存的每日對帳結果(新的在前):每小時 FTP 筆數、ClickHouse 筆數、差異與狀態(差異大於 ${RECON_THRESHOLD * 100}% 為缺口 gap、少於 −${RECON_THRESHOLD * 100}% 為 excess、FTP 沒有該小時為 ftp-missing)。每天自動對帳前 3 天;FTP 前一天的檔案還沒同步分析完時整天為 pending。`,
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': ['場景: 查詢對帳結果', '  假如 2026-11-12 已對帳', '  當 呼叫 GET /api/netops/pa/reconciliations?from=2026-11-12', '  那麼 回應 200', '  而且 days 第一筆的 day 為 "2026-11-12",hours 每筆有 ftp、ch、diff、status'].join('\n'),
        querystring: dayRangeQuery(),
        response: { 200: looseObject('{ days: [ReconDay], threshold }') },
      },
    },
    async (req) => {
      const { from, to } = dayRange(req.query);
      return { days: need().list(from, to).map(out), threshold: RECON_THRESHOLD };
    },
  );

  app.post<{ Body: { day: string } }>(
    '/v1/pa/reconciliations',
    {
      schema: {
        operationId: 'netops.pa-recon.run',
        summary: '立即對帳一天',
        description: '比對這一天每小時的 FTP 摘要筆數與 ClickHouse 每小時彙總筆數並存檔,回傳結果(不讀 FTP,只用已分析的摘要)。ClickHouse 無法使用時回 503 NETOPS_CLICKHOUSE_UNAVAILABLE。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': ['場景: 立即對帳', '  當 呼叫 POST /api/netops/pa/reconciliations 帶 day "2026-11-12"', '  那麼 回應 200', '  而且 status 為 ok、gap、pending 或 not-covered'].join('\n'),
        body: { type: 'object', required: ['day'], additionalProperties: false, properties: { day: DAY } },
        response: { 200: looseObject('ReconDay') },
      },
    },
    async (req) => {
      return out(await run(dayIn(req.body.day, 'day')));
    },
  );

  app.post<{ Body: { day: string; hours?: string[] } }>(
    '/v1/pa/backfills',
    {
      schema: {
        operationId: 'netops.pa-backfill.create',
        summary: 'FTP 補漏(送出工作)',
        description:
          '先重新對帳這一天,再把缺口(gap)的小時交給 netops-ingest:從 FTP 讀涵蓋這些小時的 TRAFFIC 檔,只補寫 seqno 不在 ClickHouse 的列(不刪除既有資料)。hours 可指定其中幾個缺口小時(ISO 8601)。回 202 與工作;FTP 還沒同步分析完回 409 NETOPS_RECON_PENDING;沒有缺口回 409 NETOPS_BACKFILL_NOTHING;佇列已滿回 409 NETOPS_BACKFILL_BUSY。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': [
          '場景: 送出補漏',
          '  假如 2026-11-12 對帳有缺口',
          '  當 呼叫 POST /api/netops/pa/backfills 帶 day "2026-11-12"',
          '  那麼 回應 202',
          '  而且 之後 GET /api/netops/pa/backfills/{id} 的 state 會變成 "done",inserted 為補寫的筆數',
          '',
          '場景: 沒有缺口',
          '  當 呼叫 POST /api/netops/pa/backfills 的那天沒有缺口',
          '  那麼 回應 409 NETOPS_BACKFILL_NOTHING',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['day'],
          additionalProperties: false,
          properties: { day: DAY, hours: { type: 'array', maxItems: 24, items: { type: 'string', maxLength: 40 } } },
        },
        response: { 202: looseObject('BackfillJob') },
      },
    },
    async (req, reply) => {
      const day = dayIn(req.body.day, 'day');
      const r = need();
      if (!queue) throw unavailable();
      const rec = await run(day);
      if (rec.status === 'pending') throw new AppError(409, 'NETOPS_RECON_PENDING', '這一天的 FTP 檔案還沒同步分析完,請先到「FTP Log 檔案」同步後再補漏');
      let gaps = rec.hours.filter((h) => h.status === 'gap');
      if (req.body.hours?.length) {
        const want = new Set(
          req.body.hours.map((h) => {
            const ms = Date.parse(h);
            if (Number.isNaN(ms) || !/[Zz]|[+-]\d{2}:\d{2}$/.test(h)) throw validation('hours', '時間格式必須是 ISO 8601 且含時區');
            return taipeiHourKey(ms);
          }),
        );
        gaps = gaps.filter((h) => want.has(h.hour));
      }
      if (!gaps.length) throw new AppError(409, 'NETOPS_BACKFILL_NOTHING', '這一天沒有需要補漏的小時');
      const hours = gaps.map((h) => {
        const ms = taipeiDayStartMs(h.hour.slice(0, 10)) + Number(h.hour.slice(11, 13)) * 3600_000;
        return { hour: ms, files: r.filesForHour(ms) };
      });
      // 找不到涵蓋的 FTP 檔就不建工作(否則會「完成」但什麼都沒補)
      const noFiles = hours.filter((h) => !h.files.length);
      if (noFiles.length) throw new AppError(409, 'NETOPS_RECON_PENDING', '有缺口的小時找不到已分析的 FTP 檔,請先到「FTP Log 檔案」同步後再補漏');
      const job = await queue.enqueue(day, hours, ownerOf(req.identity)).catch(() => {
        throw redisDown();
      });
      if (!job) throw new AppError(409, 'NETOPS_BACKFILL_BUSY', '補漏佇列已滿,請等前面的工作完成');
      r.addBackfill(day, job.id);
      return reply.status(202).send(jobOut(job));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/pa/backfills/:id',
    {
      schema: {
        operationId: 'netops.pa-backfill.get',
        summary: 'FTP 補漏(查詢工作)',
        description: '補漏工作的狀態(queued、running、done、failed)與筆數:read(FTP 讀到屬於這些小時的列)、skipped(已在 ClickHouse)、inserted(補寫)、noSeqno(沒有 seqno 無法去重而略過)。保留 7 天;不存在回 404 NETOPS_BACKFILL_NOT_FOUND。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': ['場景: 查詢補漏工作', '  當 呼叫 GET /api/netops/pa/backfills/{id}', '  那麼 回應 200', '  而且 回應含 state、read、skipped、inserted'].join('\n'),
        params: ID,
        response: { 200: looseObject('BackfillJob') },
      },
    },
    async (req) => {
      if (!queue) throw unavailable();
      const job = await queue.get(req.params.id).catch(() => {
        throw redisDown();
      });
      if (!job) throw new AppError(404, 'NETOPS_BACKFILL_NOT_FOUND', '找不到補漏工作(已超過 7 天或不存在)');
      return jobOut(job);
    },
  );
};

export default reconRoutes;

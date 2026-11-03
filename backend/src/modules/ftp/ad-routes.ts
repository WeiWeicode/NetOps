/**
 * FTP Log 檔案 — AD(docs/API.md §5.2;舊版 server/routes/ad.js 的 browse、sync、import、forget)
 *   清單要逐一列出每個日期資料夾(舊版最長 120 秒),改成工作模式(D6);同步、匯入在背景執行,回 202。
 * FTP 唯讀:「刪除匯入結果」只刪本系統的資料(AGENT.md §7.4)。
 */
import type { FastifyPluginAsync } from 'fastify';
import { AppError } from '../../errors.js';
import { ownerOf } from '../../infra/jobs/index.js';
import type { AdImporter } from '../ad/importer.js';
import { ACCEPTED, DAY, looseObject } from '../../shared/schemas.js';
import { dayIn, dayOut } from '../../shared/time.js';

const KIND = 'ad-ftp-listing';
const LISTING_TIMEOUT_MS = 3 * 60_000;
const DAYS = { type: 'array', minItems: 1, maxItems: 60, items: DAY } as const;
const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

type Listing = Awaited<ReturnType<AdImporter['listRemote']>>;
const listingOut = (r: Listing) => ({ ...r, days: r.days.map((d) => ({ ...d, day: dayOut(d.day) })) });

const adFtpRoutes: FastifyPluginAsync<{ ad: AdImporter }> = async (app, { ad }) => {
  const busy = () => new AppError(409, 'NETOPS_AD_SYNC_BUSY', 'AD 正在同步中,請稍後再試');
  /** 背景執行同步;錯誤記在 lastSyncError */
  const runSync = (opts?: { days: string[]; force: boolean }) => {
    if (!ad.configured()) throw new AppError(503, 'NETOPS_FTP_NOT_CONFIGURED', '尚未設定 FTP(FTP_HOST)');
    if (ad.status().running) throw busy();
    // 錯誤記在 lastSyncError(畫面看得到),同時寫日誌
    void ad.sync(opts).catch((err) => app.log.error({ err }, '[AD 同步] 失敗'));
  };

  app.post(
    '/v1/ftp/ad/listings',
    {
      schema: {
        operationId: 'netops.ftp.ad-listing-create',
        summary: '列出 AD 的 FTP 日期資料夾(送出工作)',
        description: '在背景列出 FTP 上 AD 匯出目錄的每個日期資料夾、檔案與匯入狀態(new / changed / done / orphan);回 202 與工作狀態,完成後以 GET 查詢結果。工作只有本人可查。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': [
          '場景: 送出清單工作',
          '  當 呼叫 POST /api/netops/ftp/ad/listings',
          '  那麼 回應 202',
          '  而且 status 為 "queued" 或 "running"',
        ].join('\n'),
        response: ACCEPTED,
      },
    },
    async (req, reply) => {
      // 同時有多個清單工作時共用同一次 FTP 列表(importer.listRemote),不會多佔 FTP 連線
      const job = app.jobs.submit(KIND, ownerOf(req.identity), async () => listingOut(await ad.listRemote()), { timeoutMs: LISTING_TIMEOUT_MS });
      return reply.status(202).send(job);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/ftp/ad/listings/:id',
    {
      schema: {
        operationId: 'netops.ftp.ad-listing-get',
        summary: 'AD 的 FTP 日期資料夾清單(查詢工作)',
        description: '查詢清單工作的狀態;完成時 result 為 { dir, days }。別人的工作、已逾期或服務重新啟動後回 404 NETOPS_JOB_NOT_FOUND。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': [
          '場景: 查詢自己的工作',
          '  假如 使用者已送出清單工作',
          '  當 呼叫 GET /api/netops/ftp/ad/listings/{id}',
          '  那麼 回應 200',
          '',
          '場景: 別人的工作',
          '  當 另一位使用者呼叫 GET /api/netops/ftp/ad/listings/{id}',
          '  那麼 回應 404 NETOPS_JOB_NOT_FOUND',
        ].join('\n'),
        params: ID,
        response: { 200: looseObject('工作狀態(docs/API.md §1.1)') },
      },
    },
    async (req) => app.jobs.get(req.params.id, ownerOf(req.identity), KIND),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/ftp/ad/listings/:id',
    {
      schema: {
        operationId: 'netops.ftp.ad-listing-cancel',
        summary: '取消 AD 的 FTP 清單工作',
        description: '取消自己的清單工作;已結束、已逾期或不存在也回 204(冪等)。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': ['場景: 取消工作', '  當 呼叫 DELETE /api/netops/ftp/ad/listings/{id}', '  那麼 回應 204', '  而且 再呼叫一次也回 204'].join('\n'),
        params: ID,
      },
    },
    async (req, reply) => {
      cancelQuietly(() => app.jobs.cancel(req.params.id, ownerOf(req.identity), KIND));
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/ftp/ad/status',
    {
      schema: {
        operationId: 'netops.ftp.ad-status',
        summary: 'AD 同步狀態',
        description: '是否正在同步、最近一次同步的時間、錯誤與結果(匯入的日期與筆數)。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': ['場景: 查詢同步狀態', '  當 呼叫 GET /api/netops/ftp/ad/status', '  那麼 回應 200', '  而且 回應含 running 與 lastSyncAt'].join('\n'),
        response: { 200: looseObject('{ running, dir, autoSyncMinutes, lastSyncAt, lastSyncError, lastResult }') },
      },
    },
    async () => statusOut(ad.status()),
  );

  app.post(
    '/v1/ftp/ad/syncs',
    {
      schema: {
        operationId: 'netops.ftp.ad-sync',
        summary: '同步 AD 事件',
        description: '在背景比對 FTP 上每個日期資料夾,有變更才重新匯入;回 202,結果看 AD 同步狀態。正在同步時回 409 NETOPS_AD_SYNC_BUSY。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': [
          '場景: 送出同步',
          '  當 呼叫 POST /api/netops/ftp/ad/syncs',
          '  那麼 回應 202',
          '',
          '場景: 正在同步',
          '  假如 AD 正在同步',
          '  當 呼叫 POST /api/netops/ftp/ad/syncs',
          '  那麼 回應 409 NETOPS_AD_SYNC_BUSY',
        ].join('\n'),
        response: ACCEPTED,
      },
    },
    async (_req, reply) => {
      runSync();
      return reply.status(202).send(statusOut(ad.status()));
    },
  );

  app.post<{ Body: { days: string[] } }>(
    '/v1/ftp/ad/imports',
    {
      schema: {
        operationId: 'netops.ftp.ad-import',
        summary: '重新匯入選取的 AD 日期',
        description: '不比對檔案,一律重新匯入選取的日期(1–60 天);背景執行,回 202。正在同步時回 409 NETOPS_AD_SYNC_BUSY。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': ['場景: 重新匯入一天', '  當 呼叫 POST /api/netops/ftp/ad/imports 帶 days ["2026-11-02"]', '  那麼 回應 202'].join('\n'),
        body: { type: 'object', required: ['days'], additionalProperties: false, properties: { days: DAYS } },
        response: ACCEPTED,
      },
    },
    async (req, reply) => {
      runSync({ days: req.body.days.map((d) => dayIn(d, 'days')), force: true });
      return reply.status(202).send(statusOut(ad.status()));
    },
  );

  app.post<{ Body: { days: string[] } }>(
    '/v1/ftp/ad/result-deletions',
    {
      schema: {
        operationId: 'netops.ftp.ad-forget',
        summary: '刪除 AD 匯入結果',
        description: '刪除選取日期在本系統的匯入結果(FTP 上的檔案不動);之後同步會重新匯入。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': ['場景: 刪除一天', '  假如 2026-11-02 已匯入', '  當 呼叫 POST /api/netops/ftp/ad/result-deletions 帶 days ["2026-11-02"]', '  那麼 回應 200', '  而且 deleted 為 1'].join('\n'),
        body: { type: 'object', required: ['days'], additionalProperties: false, properties: { days: DAYS } },
        response: { 200: { type: 'object', properties: { deleted: { type: 'integer' } } } },
      },
    },
    async (req) => ({ deleted: ad.forget(req.body.days.map((d) => dayIn(d, 'days'))) }),
  );
};

/** 狀態裡的日期轉 ISO */
function statusOut(s: ReturnType<AdImporter['status']>) {
  return { ...s, lastResult: s.lastResult && { ...s.lastResult, imported: s.lastResult.imported.map((x) => ({ ...x, day: dayOut(x.day) })) } };
}

/** 取消是冪等的:工作不存在(已逾期、別人的)也當成功 */
export function cancelQuietly(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'NETOPS_JOB_NOT_FOUND')) throw err;
  }
}

export default adFtpRoutes;

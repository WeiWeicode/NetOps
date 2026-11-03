/**
 * FTP Log 檔案 — PA(docs/API.md §5.1;舊版 server/routes/ftp.js)
 * TRAFFIC(FTP_LOG_DIR)與其他類型 log(各自的目錄)共用這組 API,依路徑判斷交給哪個匯入程式。
 * FTP 唯讀:「刪除分析結果」只刪本系統的摘要(AGENT.md §7.4)。
 */
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { Ftp } from '../../infra/ftp/index.js';
import type { EventImporter } from '../pa-events/importer.js';
import type { RemoteFile, TrafficImporter } from '../pa/importer.js';
import { ACCEPTED, looseObject } from '../../shared/schemas.js';
import { dayOut, logTimeOut } from '../../shared/time.js';

/** 檔案清單的時間轉 ISO(docs/API.md §1) */
export const fileOut = <T extends Pick<RemoteFile, 'day' | 'timeMin' | 'timeMax'>>(f: T): T => ({ ...f, day: dayOut(f.day), timeMin: logTimeOut(f.timeMin), timeMax: logTimeOut(f.timeMax) });

const PATHS = { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', minLength: 1, maxLength: 1024 } } as const;

const ftpRoutes: FastifyPluginAsync<{ ftp: Ftp; traffic: TrafficImporter; events: EventImporter; logDir: string; root: string; pattern: string }> = async (
  app,
  { ftp, traffic, events, logDir, root, pattern },
) => {
  const status = () => ({ traffic: traffic.status(), events: events.status() });

  app.get<{ Querystring: { path?: string } }>(
    '/v1/ftp/pa/files',
    {
      schema: {
        operationId: 'netops.ftp.pa-files',
        summary: '瀏覽 PA 的 FTP 目錄',
        description: '列出 FTP 目錄(預設 TRAFFIC 目錄)的資料夾與檔案,以及每個檔案的分析狀態(new / changed / done / error / queued / running)。不可超出 FTP 根目錄;FTP 只讀取。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-timeout-ms': 45000,
        'x-gherkin': [
          '場景: 瀏覽 TRAFFIC 目錄',
          '  當 呼叫 GET /api/netops/ftp/pa/files',
          '  那麼 回應 200',
          '  而且 items 每筆有 state',
          '',
          '場景: 超出根目錄',
          '  假如 FTP_ROOT 為 /my-data',
          '  當 呼叫 GET /api/netops/ftp/pa/files?path=/etc',
          '  那麼 回應 403 NETOPS_FTP_PATH_FORBIDDEN',
        ].join('\n'),
        querystring: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', maxLength: 1024 } } },
        response: { 200: looseObject('{ path, type, root, logDir, pattern, eventDirs, items }') },
      },
    },
    async (req) => {
      const dir = ftp.safePath(req.query.path || logDir);
      const type = events.typeOfDir(dir);
      const items = type ? await events.listRemote(type) : await traffic.listRemote(dir);
      return { path: dir, type, root, logDir, pattern, eventDirs: events.eventTypes(), items: items.map(fileOut) };
    },
  );

  app.get(
    '/v1/ftp/pa/status',
    {
      schema: {
        operationId: 'netops.ftp.pa-status',
        summary: 'PA 匯入進度',
        description: 'TRAFFIC 與其他類型 log 的匯入佇列、分析中的檔案與最近一次同步結果;同步與分析在背景執行,畫面輪詢此 API。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.read',
        'x-gherkin': ['場景: 查詢匯入進度', '  當 呼叫 GET /api/netops/ftp/pa/status', '  那麼 回應 200', '  而且 回應含 traffic 與 events'].join('\n'),
        response: { 200: looseObject('{ traffic: ImportStatus, events: ImportStatus }') },
      },
    },
    async () => status(),
  );

  app.post(
    '/v1/ftp/pa/syncs',
    {
      schema: {
        operationId: 'netops.ftp.pa-sync',
        summary: '同步 PA 的 FTP 檔案',
        description: '在背景列出 TRAFFIC 與各類型目錄,把新的、已變更與上次失敗的檔案加入分析佇列;立即回 202,結果看匯入進度的 lastSyncAt 與 lastSyncError。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': [
          '場景: 送出同步',
          '  假如 使用者擁有 netops.ftp.write',
          '  當 呼叫 POST /api/netops/ftp/pa/syncs',
          '  那麼 回應 202',
          '  而且 之後 GET /api/netops/ftp/pa/status 的 lastSyncAt 會更新',
        ].join('\n'),
        response: ACCEPTED,
      },
    },
    async (_req, reply) => {
      // 錯誤記在 lastSyncError,這裡不再拋出
      void traffic.sync().catch(() => undefined);
      void events.sync().catch(() => undefined);
      return reply.status(202).send(status());
    },
  );

  app.post<{ Body: { items: { path: string; size?: number; modified?: string | null }[] } }>(
    '/v1/ftp/pa/analyses',
    {
      schema: {
        operationId: 'netops.ftp.pa-analyze',
        summary: '分析選取的 PA log 檔',
        description: '把選取的 FTP 檔案加入分析佇列(重新分析也用這個);已在佇列或分析中的會略過。依路徑交給 TRAFFIC 或其他類型的匯入程式。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': [
          '場景: 分析選取的檔案',
          '  當 呼叫 POST /api/netops/ftp/pa/analyses 帶 1 個檔案',
          '  那麼 回應 200',
          '  而且 added 為 1',
          '',
          '場景: 沒有選擇檔案',
          '  當 呼叫 POST /api/netops/ftp/pa/analyses 帶空的 items',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['items'],
          additionalProperties: false,
          properties: {
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              items: {
                type: 'object',
                required: ['path'],
                additionalProperties: false,
                properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, size: { type: 'number', minimum: 0 }, modified: { type: ['string', 'null'], maxLength: 40 } },
              },
            },
          },
        },
        response: { 200: { type: 'object', properties: { added: { type: 'integer' } } } },
      },
    },
    async (req) => {
      const list = req.body.items.map((it) => {
        const p = ftp.safePath(it.path);
        return { path: p, name: path.posix.basename(p), size: Number(it.size) || 0, modified: it.modified || null };
      });
      const ev = list.filter((f) => events.isEventPath(f.path)).map((f) => ({ ...f, type: events.eventTypeOfPath(f.path) }));
      return { added: traffic.enqueue(list.filter((f) => !events.isEventPath(f.path))) + events.enqueue(ev) };
    },
  );

  app.delete(
    '/v1/ftp/pa/analyses',
    {
      schema: {
        operationId: 'netops.ftp.pa-cancel',
        summary: '取消 PA 分析',
        description: '清空分析佇列並中斷分析中的檔案;被取消的檔案維持原本狀態,下次同步再分析。重複呼叫回 cancelled 0。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': ['場景: 取消分析', '  假如 佇列中有 3 個檔案', '  當 呼叫 DELETE /api/netops/ftp/pa/analyses', '  那麼 回應 200', '  而且 cancelled 為 3'].join('\n'),
        response: { 200: { type: 'object', properties: { cancelled: { type: 'integer' } } } },
      },
    },
    async () => ({ cancelled: traffic.cancel() + events.cancel() }),
  );

  app.post<{ Body: { paths: string[] } }>(
    '/v1/ftp/pa/result-deletions',
    {
      schema: {
        operationId: 'netops.ftp.pa-forget',
        summary: '刪除 PA 分析結果',
        description: '刪除選取檔案在本系統的摘要與統計(FTP 上的檔案不動);之後同步會重新分析。',
        tags: ['FTP Log 檔案'],
        'x-permission': 'netops.ftp.write',
        'x-gherkin': ['場景: 刪除分析結果', '  假如 檔案已分析', '  當 呼叫 POST /api/netops/ftp/pa/result-deletions 帶該檔案路徑', '  那麼 回應 200', '  而且 deleted 為 1', '  而且 FTP 上的檔案不變'].join('\n'),
        body: { type: 'object', required: ['paths'], additionalProperties: false, properties: { paths: PATHS } },
        response: { 200: { type: 'object', properties: { deleted: { type: 'integer' } } } },
      },
    },
    async (req) => {
      const paths = req.body.paths.map((p) => ftp.safePath(p));
      return { deleted: traffic.forget(paths.filter((p) => !events.isEventPath(p))) + events.forget(paths.filter((p) => events.isEventPath(p))) };
    },
  );
};

export default ftpRoutes;

/**
 * IP 對照表(docs/API.md §11;IMPL-PLAN AC3,ARCHITECTURE D45)
 *   讀取 / 匯出 / 範本:netops.ip-name.read;單筆新增 / 修改 / 刪除、匯入:netops.ip-name.write(兩個都只給 netops-admin,例外同 D31)
 *   內容含姓名、部門(個資):稽核一律 x-audit-level meta(不記內容);這裡不寫含內容的日誌
 *   PA 各 API 的 names 不需要這兩個權限(沿用各 API 原本的權限,見 attachNames)
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { AppError } from '../../errors.js';
import { ownerOf } from '../../infra/jobs/index.js';
import { toCsv } from '../../shared/csv.js';
import { looseObject, NO_CONTENT } from '../../shared/schemas.js';
import { parseCsv, readXlsx, writeXlsx, XlsxError } from '../../shared/xlsx.js';
import { COLUMNS, DEVICE_TYPES, LIMITS, TEMPLATE_SAMPLES, type IpNameEntry, type IpNameInput } from './core.js';
import type { IpNameService } from './service.js';

/** 上傳檔大小上限(原始檔;base64 後約 1.34 倍) */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const ENTRY_BODY = {
  type: 'object',
  required: ['ip'],
  additionalProperties: false,
  properties: {
    ip: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', maxLength: LIMITS.name },
    department: { type: 'string', maxLength: LIMITS.department },
    device: { type: 'string', maxLength: LIMITS.device },
    deviceType: { type: 'string', enum: ['', ...DEVICE_TYPES] },
    note: { type: 'string', maxLength: LIMITS.note },
  },
} as const;
const ENTRY = looseObject('對照 { id, ip, name, department, device, deviceType, note, updatedAt, updatedBy }');
const FORMAT = { type: 'string', enum: ['json', 'csv', 'xlsx'], default: 'json' } as const;
const FILE_FORMAT = { type: 'string', enum: ['csv', 'xlsx'], default: 'xlsx' } as const;
const WIDTHS = [20, 14, 14, 20, 10, 30];
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const toRow = (e: IpNameEntry) => [e.ip, e.name, e.department, e.device, e.deviceType, e.note];

function sendFile(reply: FastifyReply, format: 'csv' | 'xlsx', base: string, rows: string[][], withLists: boolean) {
  const name = `${base}.${format}`;
  reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`).header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
  if (format === 'csv') return reply.header('content-type', 'text/csv; charset=utf-8').send(toCsv([...COLUMNS], rows));
  const lists = withLists ? [{ col: 4, options: DEVICE_TYPES }] : [];
  return reply.header('content-type', XLSX_TYPE).send(writeXlsx([[...COLUMNS], ...rows], { name: 'IP對照表', widths: WIDTHS, lists }));
}

const ipNameRoutes: FastifyPluginAsync<{ svc: IpNameService }> = async (app, { svc }) => {
  const author = (identity: { emp?: string; name?: string } | null) => {
    const who = [identity?.emp, identity?.name].filter(Boolean).join(' ');
    if (!who) throw new AppError(403, 'NETOPS_IP_NAME_AUTHOR_UNKNOWN', '無法識別修改人(沒有工號與姓名),不能修改對照表');
    return who;
  };

  app.get<{ Querystring: { q?: string; page?: number; pageSize?: number; format?: 'json' | 'csv' | 'xlsx' } }>(
    '/v1/ip-names',
    {
      schema: {
        operationId: 'netops.ip-name.list',
        summary: '查詢 / 匯出 IP 對照表',
        description:
          'IP / 網段 → 使用者姓名、部門、設備名稱、設備類型、備註。q 比對全部欄位(包含、不分大小寫),依 IP 排序、分頁回傳 { items, total, page, pageSize, version }。format = csv / xlsx 時下載全部(不分頁,欄位同匯入範本,可直接改完再匯入)。內容含個資,只給網管(netops-admin)。',
        tags: ['IP 對照表'],
        'x-permission': 'netops.ip-name.read',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 查詢對照表',
          '  假如 使用者擁有 netops.ip-name.read',
          '  當 呼叫 GET /api/netops/ip-names?q=資訊處',
          '  那麼 回應 200',
          '  而且 items 只有姓名、部門或設備含「資訊處」的對照',
          '',
          '場景: 匯出 Excel',
          '  當 呼叫 GET /api/netops/ip-names?format=xlsx',
          '  那麼 回應 200',
          '  而且 檔案第一列是 IP或網段、使用者姓名、部門、設備名稱、設備類型、備註',
          '',
          '場景: 檢視者不能看對照表',
          '  假如 使用者只有 netops-viewer 角色',
          '  當 呼叫 GET /api/netops/ip-names',
          '  那麼 回應 403',
        ].join('\n'),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 100 },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            format: FORMAT,
          },
        },
        produces: ['application/json', 'text/csv', XLSX_TYPE],
      },
    },
    async (req, reply) => {
      const { format = 'json', q = '', page = 1, pageSize = 50 } = req.query;
      if (format !== 'json') return sendFile(reply, format, `IP對照表_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`, svc.all().map(toRow), true);
      return svc.list(q, page, pageSize);
    },
  );

  app.get<{ Querystring: { format?: 'csv' | 'xlsx' } }>(
    '/v1/ip-name-template',
    {
      schema: {
        operationId: 'netops.ip-name.template',
        summary: '下載 IP 對照表匯入範本',
        description: `匯入範本(Excel 或 CSV):第一列欄名 ${COLUMNS.join('、')};附 2 列填寫範例(匯入時略過);Excel 的設備類型欄是下拉清單(${DEVICE_TYPES.join('、')})。`,
        tags: ['IP 對照表'],
        'x-permission': 'netops.ip-name.read',
        'x-gherkin': ['場景: 下載範本', '  當 呼叫 GET /api/netops/ip-name-template?format=xlsx', '  那麼 回應 200', '  而且 檔案含欄名列與 2 列範例'].join('\n'),
        querystring: { type: 'object', additionalProperties: false, properties: { format: FILE_FORMAT } },
        produces: ['text/csv', XLSX_TYPE],
      },
    },
    async (req, reply) => sendFile(reply, req.query.format ?? 'xlsx', 'IP對照表_範本', TEMPLATE_SAMPLES, true),
  );

  app.post<{ Body: IpNameInput }>(
    '/v1/ip-names',
    {
      schema: {
        operationId: 'netops.ip-name.create',
        summary: '新增 IP 對照',
        description: 'IP 為 IPv4 或網段(10.10.1.5、10.10.1.0/24;主機位元會改成網路位址);姓名、部門、設備名稱至少填一項。已有同一個 IP / 網段回 409 NETOPS_IP_NAME_DUPLICATE。回 201 與該筆。',
        tags: ['IP 對照表'],
        'x-permission': 'netops.ip-name.write',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 新增對照',
          '  假如 使用者擁有 netops.ip-name.write',
          '  當 呼叫 POST /api/netops/ip-names 帶 ip "10.10.1.5" 與 name',
          '  那麼 回應 201',
          '',
          '場景: IP 不合法',
          '  當 呼叫 POST /api/netops/ip-names 帶 ip "10.10.1"',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        body: ENTRY_BODY,
        response: { 201: ENTRY },
      },
    },
    async (req, reply) => reply.status(201).send(svc.create(req.body, author(req.identity))),
  );

  app.put<{ Params: { id: string }; Body: IpNameInput }>(
    '/v1/ip-names/:id',
    {
      schema: {
        operationId: 'netops.ip-name.update',
        summary: '修改 IP 對照',
        description: '以請求內容取代該筆(含 IP);改成已存在的 IP 回 409 NETOPS_IP_NAME_DUPLICATE,不存在回 404 NETOPS_IP_NAME_NOT_FOUND。以最新為準,不記歷史。',
        tags: ['IP 對照表'],
        'x-permission': 'netops.ip-name.write',
        'x-audit-level': 'meta',
        'x-gherkin': ['場景: 修改對照', '  當 呼叫 PUT /api/netops/ip-names/{id}', '  那麼 回應 200', '  而且 updatedBy 為登入者'].join('\n'),
        params: ID,
        body: ENTRY_BODY,
        response: { 200: ENTRY },
      },
    },
    async (req) => svc.update(req.params.id, req.body, author(req.identity)),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/ip-names/:id',
    {
      schema: {
        operationId: 'netops.ip-name.delete',
        summary: '刪除 IP 對照',
        description: '刪除一筆;已不存在也回 204(冪等)。',
        tags: ['IP 對照表'],
        'x-permission': 'netops.ip-name.write',
        'x-audit-level': 'meta',
        'x-gherkin': ['場景: 刪除對照', '  當 呼叫 DELETE /api/netops/ip-names/{id}', '  那麼 回應 204', '  而且 再呼叫一次也回 204'].join('\n'),
        params: ID,
        response: NO_CONTENT,
      },
    },
    async (req, reply) => {
      svc.remove(req.params.id);
      return reply.status(204).send();
    },
  );

  app.post<{ Body: { fileName: string; format: 'csv' | 'xlsx'; data: string } }>(
    '/v1/ip-name-imports',
    {
      bodyLimit: Math.ceil((IMPORT_MAX_BYTES * 4) / 3) + 64 * 1024,
      schema: {
        operationId: 'netops.ip-name.import-preview',
        summary: '匯入 IP 對照表(預覽)',
        description: `上傳填好的範本(data = 檔案內容 base64,上限 ${IMPORT_MAX_BYTES / 1024 / 1024} MB),回預覽:新增 / 修改 / 刪除(檔案沒有的視為刪除,整份取代)、略過的範例列與有問題的列。不寫入;15 分鐘內呼叫 confirm 才寫入。欄名列不符回 400 NETOPS_IP_NAME_IMPORT_INVALID。`,
        tags: ['IP 對照表'],
        'x-permission': 'netops.ip-name.write',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 上傳後先預覽',
          '  假如 對照表已有 10.10.1.5',
          '  當 呼叫 POST /api/netops/ip-name-imports 上傳只有 10.10.1.6 的範本',
          '  那麼 回應 200',
          '  而且 diff 新增 10.10.1.6、刪除 10.10.1.5',
          '  而且 對照表還沒有改變',
          '',
          '場景: 不是範本格式',
          '  當 上傳第一列不是欄名的檔案',
          '  那麼 回應 400 NETOPS_IP_NAME_IMPORT_INVALID',
        ].join('\n'),
        body: {
          type: 'object',
          required: ['fileName', 'format', 'data'],
          additionalProperties: false,
          properties: {
            fileName: { type: 'string', maxLength: 200 },
            format: { type: 'string', enum: ['csv', 'xlsx'] },
            data: { type: 'string', maxLength: Math.ceil((IMPORT_MAX_BYTES * 4) / 3) + 4, pattern: '^[A-Za-z0-9+/=\\s]*$' },
          },
        },
        response: { 200: looseObject('預覽 { id, fileName, total, skipped, errors, counts, diff: { added, changed, removed, unchanged }, expiresAt }') },
      },
    },
    async (req) => {
      const buf = Buffer.from(req.body.data, 'base64');
      if (!buf.length) throw new AppError(400, 'NETOPS_IP_NAME_IMPORT_INVALID', '檔案是空的');
      if (buf.length > IMPORT_MAX_BYTES) throw new AppError(400, 'NETOPS_IP_NAME_IMPORT_INVALID', `檔案超過 ${IMPORT_MAX_BYTES / 1024 / 1024} MB`);
      let rows: string[][];
      try {
        rows = req.body.format === 'xlsx' ? readXlsx(buf) : parseCsv(buf.toString('utf8'));
      } catch (err) {
        if (err instanceof XlsxError) throw new AppError(400, 'NETOPS_IP_NAME_IMPORT_INVALID', err.message);
        throw err;
      }
      const fileName = req.body.fileName.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
      return svc.preview(rows, fileName, ownerOf(req.identity), author(req.identity));
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/ip-name-imports/:id/confirm',
    {
      schema: {
        operationId: 'netops.ip-name.import-confirm',
        summary: '確認匯入 IP 對照表',
        description: '把預覽的內容寫入(整份取代);只有上傳者本人可確認。預覽不存在或逾期回 404 NETOPS_IP_NAME_IMPORT_NOT_FOUND;預覽之後對照表被改過回 409 NETOPS_IP_NAME_IMPORT_STALE(請重新上傳)。',
        tags: ['IP 對照表'],
        'x-permission': 'netops.ip-name.write',
        'x-audit-level': 'meta',
        'x-gherkin': [
          '場景: 確認匯入',
          '  假如 已上傳預覽',
          '  當 呼叫 POST /api/netops/ip-name-imports/{id}/confirm',
          '  那麼 回應 200',
          '  而且 對照表改成檔案的內容',
          '',
          '場景: 預覽後對照表被改過',
          '  假如 預覽之後有人新增了一筆',
          '  當 呼叫 POST /api/netops/ip-name-imports/{id}/confirm',
          '  那麼 回應 409 NETOPS_IP_NAME_IMPORT_STALE',
        ].join('\n'),
        params: ID,
        response: { 200: looseObject('{ added, changed, removed, unchanged, total }') },
      },
    },
    async (req) => svc.confirm(req.params.id, ownerOf(req.identity)),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/ip-name-imports/:id',
    {
      schema: {
        operationId: 'netops.ip-name.import-discard',
        summary: '取消 IP 對照表匯入預覽',
        description: '丟棄自己的匯入預覽;不存在也回 204(冪等)。',
        tags: ['IP 對照表'],
        'x-permission': 'netops.ip-name.write',
        'x-gherkin': ['場景: 取消預覽', '  當 呼叫 DELETE /api/netops/ip-name-imports/{id}', '  那麼 回應 204'].join('\n'),
        params: ID,
        response: NO_CONTENT,
      },
    },
    async (req, reply) => {
      svc.discard(req.params.id, ownerOf(req.identity));
      return reply.status(204).send();
    },
  );
};

export default ipNameRoutes;

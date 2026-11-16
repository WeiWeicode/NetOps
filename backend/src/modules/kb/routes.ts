/**
 * 知識庫(docs/API.md §7;舊版 server/routes/kb.js,不含語意搜尋、向量同步、外部 IP 自動學習,D17)
 * 編輯權限由 BFF 依 netops.kb.write 檢查(舊版 KB_ADMINS 名單不再使用,AGENT.md §7.1);記錄人用 Gateway 身分「工號 姓名」。
 * 筆記內容是資料,前端顯示前一律經 DOMPurify(AGENT.md §7.4)。
 */
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { AppError } from '../../errors.js';
import { looseObject, NO_CONTENT } from '../../shared/schemas.js';
import { logTimeOut } from '../../shared/time.js';
import type { KbService, Note, NoteInput } from './service.js';

const noteOut = (n: Note) => ({ ...n, created: logTimeOut(n.created), updated: logTimeOut(n.updated) });

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^[\\w-]{6,64}$' } } } as const;
const LIST = (maxItems: number) => ({
  anyOf: [
    // 不可含換行(壓成一行仍保留這道檢查,直接回 400)
    { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 100, pattern: '^[^\\r\\n]*$' } },
    { type: 'string', maxLength: 3000, pattern: '^[^\\r\\n]*$' },
  ],
  description: `陣列,或以逗號 / 頓號分隔的文字;最多保留 ${maxItems} 個`,
});
const NOTE_BODY = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', maxLength: 300, pattern: '^[^\\r\\n]*$' },
    ips: LIST(30),
    tags: LIST(10),
    content: { type: 'string', minLength: 1, maxLength: 20000 },
    source: { type: 'string', maxLength: 1000 },
  },
} as const;
const NOTE = looseObject('筆記 { id, title, ips, tags, author, created, updated, updatedBy, source, content }');

/** Markdown 下載;檔名去掉不允許的字元 */
const sendMarkdown = (reply: FastifyReply, name: string, text: string) =>
  reply
    .header('content-type', 'text/markdown; charset=utf-8')
    .header('x-content-type-options', 'nosniff')
    .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
    .send(text);

const kbRoutes: FastifyPluginAsync<{ kb: KbService }> = async (app, { kb }) => {
  const author = (identity: { emp?: string; name?: string; sub: string } | null) => {
    const who = [identity?.emp, identity?.name].filter(Boolean).join(' ');
    if (!who) throw new AppError(403, 'NETOPS_KB_AUTHOR_UNKNOWN', '無法識別記錄人(沒有工號與姓名),不能編輯筆記');
    return who;
  };

  app.get<{ Querystring: { q?: string; page?: number; pageSize?: number } }>(
    '/v1/kb/notes',
    {
      schema: {
        operationId: 'netops.kb.list',
        summary: '查詢知識庫筆記',
        description: '關鍵字(以空白分隔,全部符合)比對標題、內容、IP、標籤與記錄人;依更新時間新的在前、分頁回傳,附匯整檔資訊(筆數、更新時間、字數)。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.read',
        'x-gherkin': [
          '場景: 查詢筆記',
          '  假如 知識庫有標題含「FTP」的筆記',
          '  當 呼叫 GET /api/netops/kb/notes?q=FTP',
          '  那麼 回應 200',
          '  而且 items 的筆記都含「FTP」',
        ].join('\n'),
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { q: { type: 'string', maxLength: 200 }, page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        },
        response: { 200: looseObject('{ items, total, page, pageSize, compilation: { count, updated, chars } }') },
      },
    },
    async (req) => {
      const page = req.query.page ?? 1;
      const pageSize = req.query.pageSize ?? 50;
      const notes = kb.search(req.query.q);
      const all = kb.compilation();
      return {
        items: notes.slice((page - 1) * pageSize, page * pageSize).map(noteOut),
        total: notes.length,
        page,
        pageSize,
        compilation: { count: all.count, updated: logTimeOut(all.updated), chars: all.text.length },
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/kb/notes/:id',
    {
      schema: {
        operationId: 'netops.kb.get',
        summary: '一則知識庫筆記',
        description: '依代號取得一則筆記;不存在回 404 NETOPS_KB_NOTE_NOT_FOUND。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.read',
        'x-gherkin': ['場景: 取得筆記', '  當 呼叫 GET /api/netops/kb/notes/{id}', '  那麼 回應 200', '', '場景: 不存在', '  當 呼叫 GET /api/netops/kb/notes/000000-none', '  那麼 回應 404'].join('\n'),
        params: ID,
        response: { 200: NOTE },
      },
    },
    async (req) => noteOut(kb.getNote(req.params.id)),
  );

  app.get<{ Params: { id: string } }>(
    '/v1/kb/notes/:id/markdown',
    {
      schema: {
        operationId: 'netops.kb.markdown',
        summary: '下載筆記 .md',
        description: '下載一則筆記的原始 Markdown 檔(含開頭的欄位),檔名為筆記標題。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.read',
        'x-audit-level': 'meta',
        'x-gherkin': ['場景: 下載筆記', '  當 呼叫 GET /api/netops/kb/notes/{id}/markdown', '  那麼 回應 200', '  而且 Content-Type 為 text/markdown'].join('\n'),
        params: ID,
        produces: ['text/markdown'],
      },
    },
    async (req, reply) => {
      const { title, text } = kb.markdown(req.params.id);
      return sendMarkdown(reply, `${title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 60)}.md`, text);
    },
  );

  app.get(
    '/v1/kb/compilation',
    {
      schema: {
        operationId: 'netops.kb.compilation',
        summary: '下載知識庫匯整檔',
        description: '全部筆記整理成一份 Markdown(目錄 + 各則內容;依 IP 排序),筆記有變動時自動重新產生。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.read',
        'x-audit-level': 'meta',
        'x-gherkin': ['場景: 下載匯整檔', '  當 呼叫 GET /api/netops/kb/compilation', '  那麼 回應 200', '  而且 內容以「# 網通知識庫匯整」開頭'].join('\n'),
        produces: ['text/markdown'],
      },
    },
    async (_req, reply) => sendMarkdown(reply, '網通知識庫匯整.md', kb.compilation().text),
  );

  app.post<{ Body: NoteInput }>(
    '/v1/kb/notes',
    {
      schema: {
        operationId: 'netops.kb.create',
        summary: '新增知識庫筆記',
        description: '新增一則筆記;內容必填(上限 20,000 字),IP 最多 30 個、標籤最多 10 個,標題與標籤不可含換行;記錄人為登入者的工號與姓名。回 201 與筆記;總數上限 5,000 則(409 NETOPS_KB_LIMIT)。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.write',
        'x-gherkin': [
          '場景: 新增筆記',
          '  假如 使用者擁有 netops.kb.write',
          '  當 呼叫 POST /api/netops/kb/notes 帶 content',
          '  那麼 回應 201',
          '  而且 author 為登入者的「工號 姓名」',
          '',
          '場景: 內容空白',
          '  當 呼叫 POST /api/netops/kb/notes 帶空白 content',
          '  那麼 回應 400 VALIDATION_FAILED',
        ].join('\n'),
        body: NOTE_BODY,
        response: { 201: NOTE },
      },
    },
    async (req, reply) => reply.status(201).send(noteOut(kb.saveNote(req.body, author(req.identity)))),
  );

  app.put<{ Params: { id: string }; Body: NoteInput }>(
    '/v1/kb/notes/:id',
    {
      schema: {
        operationId: 'netops.kb.update',
        summary: '修改知識庫筆記',
        description: '以請求內容取代筆記的標題、IP、標籤與內容(source 省略時保留原值,同舊版);保留原記錄人與建立時間,更新修改人與時間。不存在回 404。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.write',
        'x-gherkin': ['場景: 修改筆記', '  當 呼叫 PUT /api/netops/kb/notes/{id}', '  那麼 回應 200', '  而且 updatedBy 為登入者'].join('\n'),
        params: ID,
        body: NOTE_BODY,
        response: { 200: NOTE },
      },
    },
    async (req) => noteOut(kb.saveNote(req.body, author(req.identity), req.params.id)),
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/kb/notes/:id',
    {
      schema: {
        operationId: 'netops.kb.delete',
        summary: '刪除知識庫筆記',
        description: '刪除一則筆記並重新產生匯整檔;已不存在也回 204(冪等)。知識庫不可重建,刪除前畫面要再次確認。',
        tags: ['知識庫'],
        'x-permission': 'netops.kb.write',
        'x-gherkin': ['場景: 刪除筆記', '  當 呼叫 DELETE /api/netops/kb/notes/{id}', '  那麼 回應 204', '  而且 再呼叫一次也回 204'].join('\n'),
        params: ID,
        response: NO_CONTENT,
      },
    },
    async (req, reply) => {
      const removed = kb.deleteNote(req.params.id);
      if (removed) req.log.info({ noteId: req.params.id, emp: req.identity?.emp }, '刪除知識庫筆記');
      return reply.status(204).send();
    },
  );
};

export default kbRoutes;

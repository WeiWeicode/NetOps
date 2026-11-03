/**
 * 路由共用的 JSON Schema(OpenAPI 文件與請求驗證;格式見 docs/API.md §1)
 */
export const DAY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' } as const;
export const TIME = { type: 'string', description: 'ISO 8601 含時區,例 2026-11-03T08:30:00+08:00' } as const;
export const TOP = { type: 'integer', minimum: 1, maximum: 100, default: 20, description: '排行筆數' } as const;

/** 期間查詢:to 省略時等於 from */
export const dayRangeQuery = (extra: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  required: ['from', ...required],
  additionalProperties: false,
  properties: { from: DAY, to: DAY, ...extra },
});

/** 回應格式較大、欄位依資料而定時用;詳細欄位見 docs/API.md */
export const looseObject = (description: string) => ({ type: 'object', additionalProperties: true, description });

/** 匯入狀態(docs/API.md §1.2) */
export const importStatus = looseObject('匯入狀態 ImportStatus(docs/API.md §1.2)');

export const ACCEPTED = { 202: looseObject('已送出,在背景執行') };

/** 成功、沒有內容(取消工作、刪除筆記;冪等 DELETE) */
export const NO_CONTENT = { 204: { type: 'null', description: '成功,沒有內容' } } as const;

/** 假 Gateway 各模組共用的請求內容(gateway.ts 組好後交給 handleXxx) */
export interface MockCtx {
  method: string;
  /** 不含查詢字串 */
  path: string;
  url: URL;
  /** JSON body(非 GET;解析失敗為 undefined) */
  body: unknown;
  /** 沒有權限時回 403 並傳回 false */
  need: (perm: string) => boolean;
  send: (status: number, body: unknown) => void;
  fail: (status: number, code: string, message: string) => void;
}

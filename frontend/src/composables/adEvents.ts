/** AD 事件總覽的純函式(畫面與測試共用;規則同舊版 src/views/AdEvents.vue) */

/**
 * 登入失敗原因 → 明細查詢的關鍵字:原因結尾括號內的代碼(0x25、0xC000006A),沒有代碼時用整段文字。
 * 括號接受全形與半形(舊版後端輸出全形)。
 */
export function reasonQuery(reason: string): string {
  return reason.match(/[(\uFF08](0x[0-9a-f]+)[)\uFF09]\s*$/i)?.[1] ?? reason;
}

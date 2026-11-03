/** 錯誤(Gateway BACKEND-GUIDE.md §5.3):自訂代碼以 NETOPS_ 開頭(AGENT.md §8);不可使用 Gateway 專用代碼 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * 全域提示:toast(右上角訊息)與 confirm(確認對話框,回傳 Promise<boolean>)。
 * 由 App.vue 內的 <GFeedbackHost /> 顯示;頁面只呼叫 toast.success(...) / await confirm({...})。
 */
import { reactive } from 'vue';
import { describeError } from '@/api/gateway';

export type ToastTone = 'success' | 'danger' | 'info' | 'warning';
export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  tone?: 'primary' | 'danger';
}

export const feedback = reactive<{ toasts: Toast[]; confirm: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null }>({ toasts: [], confirm: null });
let seq = 0;

function push(tone: ToastTone, title: string, message?: string, ms = 4200) {
  const id = ++seq;
  feedback.toasts.push({ id, tone, title, message });
  setTimeout(() => dismiss(id), ms);
}

export function dismiss(id: number): void {
  const i = feedback.toasts.findIndex((t) => t.id === id);
  if (i >= 0) feedback.toasts.splice(i, 1);
}

export const toast = {
  success: (title: string, message?: string) => push('success', title, message),
  info: (title: string, message?: string) => push('info', title, message),
  warning: (title: string, message?: string) => push('warning', title, message),
  error: (title: string, message?: string) => push('danger', title, message, 7000),
  /** API 錯誤:顯示後端 message 與 requestId */
  fromError: (e: unknown, title = '操作失敗') => push('danger', title, describeError(e), 7000),
};

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  feedback.confirm?.resolve(false);
  return new Promise((resolve) => (feedback.confirm = { ...opts, resolve }));
}

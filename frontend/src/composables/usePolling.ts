/**
 * 背景工作的狀態輪詢(FTP 同步、分析、匯入):
 *   const p = usePolling(() => api.status(), (r) => { 套用結果; return 還要繼續嗎 }, 2000)
 *   p.run() 立即查一次;apply 回 true 就排下一次。重複呼叫 run() 只留最新一輪(舊的回應直接丟棄),不會變成兩條輪詢。
 *   分頁在背景(document.hidden)時放慢 5 倍;離開頁面(scope 結束)自動停止。
 */
import { getCurrentScope, onScopeDispose } from 'vue';

export const HIDDEN_FACTOR = 5;

export function usePolling<T>(fetch: () => Promise<T>, apply: (r: T | Error) => boolean, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let stopped = false;

  async function run(): Promise<void> {
    clearTimeout(timer);
    const my = ++seq;
    let r: T | Error;
    try {
      r = await fetch();
    } catch (e) {
      r = e as Error;
    }
    if (my !== seq || stopped) return;
    if (apply(r)) {
      clearTimeout(timer);
      timer = setTimeout(run, typeof document !== 'undefined' && document.hidden ? ms * HIDDEN_FACTOR : ms);
    }
  }

  function stop() {
    stopped = true;
    seq++;
    clearTimeout(timer);
  }

  if (getCurrentScope()) onScopeDispose(stop);
  return { run, stop };
}

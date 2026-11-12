/**
 * 使用者是否開啟「減少動態效果」(prefers-reduced-motion;HANDOFF-GEMINI-VIZ §5)。
 * 所有 JS 動畫(count-up、ECharts 動畫)都要看 reduced;CSS 動畫用 @media (prefers-reduced-motion: reduce)。
 */
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue';

const QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion() {
  const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
  const reduced = ref(mq?.matches ?? false);
  if (mq) {
    const on = (e: MediaQueryListEvent) => (reduced.value = e.matches);
    mq.addEventListener('change', on);
    if (getCurrentScope()) onScopeDispose(() => mq.removeEventListener('change', on));
  }
  return { reduced: readonly(reduced) };
}

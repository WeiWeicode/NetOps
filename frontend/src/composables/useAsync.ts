/**
 * 頁面載入資料的共用寫法:const { data, loading, error, reload } = useAsync(() => api.xxx())
 * 錯誤以 ApiError 形式保留,頁面用 <GEmpty tone="danger"> 顯示並提供重試。
 */
import { onMounted, ref, shallowRef, type Ref } from 'vue';

export function useAsync<T>(fn: () => Promise<T>, opts: { immediate?: boolean } = {}) {
  const data = shallowRef<T | null>(null) as Ref<T | null>;
  const loading = ref(false);
  const error = ref<Error | null>(null);
  let seq = 0;

  async function reload(): Promise<void> {
    const my = ++seq;
    loading.value = true;
    error.value = null;
    try {
      const r = await fn();
      if (my === seq) data.value = r;
    } catch (e) {
      if (my === seq) error.value = e as Error;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  if (opts.immediate !== false) onMounted(reload);
  return { data, loading, error, reload };
}

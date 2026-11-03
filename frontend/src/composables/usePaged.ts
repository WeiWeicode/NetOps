/**
 * 後端分頁清單的共用寫法(懶加載:只取目前這一頁):
 *   const filters = reactive({ q: '', dept: '' });
 *   const list = usePaged((page, pageSize) => http.get('/users', { query: { ...filters, page, pageSize } }), { pageSize: 10, watch: () => ({ ...filters }) });
 *   <GTable :rows="list.items.value" :total="list.total.value" v-model:page="list.page.value" :page-size="10" />
 * 篩選條件變更時回到第 1 頁並重新查詢(300 ms 防抖,避免每打一個字就查一次);較慢的舊回應會被丟棄。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type WatchSource } from 'vue';

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function usePaged<T, R extends Paged<T> = Paged<T>>(
  load: (page: number, pageSize: number) => Promise<R>,
  opts: { pageSize?: number; watch?: WatchSource; immediate?: boolean } = {},
) {
  const pageSize = opts.pageSize ?? 20;
  const page = ref(1);
  const data = shallowRef<R | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function fetchPage(): Promise<void> {
    const my = ++seq;
    loading.value = true;
    error.value = null;
    try {
      const r = await load(page.value, pageSize);
      if (my === seq) data.value = r;
    } catch (e) {
      if (my === seq) error.value = e as Error;
    } finally {
      if (my === seq) loading.value = false;
    }
  }

  watch(page, fetchPage);
  if (opts.watch)
    watch(
      opts.watch,
      () => {
        clearTimeout(timer);
        timer = setTimeout(() => (page.value === 1 ? fetchPage() : (page.value = 1)), 300);
      },
      { deep: true },
    );
  if (opts.immediate !== false) onMounted(fetchPage);
  onBeforeUnmount(() => clearTimeout(timer));

  return {
    data,
    items: computed<T[]>(() => data.value?.items ?? []),
    total: computed<number>(() => data.value?.total ?? 0),
    page,
    pageSize,
    loading,
    error,
    reload: fetchPage,
  };
}

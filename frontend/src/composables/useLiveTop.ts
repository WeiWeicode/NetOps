/**
 * 戰情室「即時排行」收摺面板(需求方 2026-11-17:舊即時監控頁的排行卡加回,含 5 / 15 / 60 分鐘切換)。
 *   - 資料:既有 GET /pa-live/top(paLive.top);每 30 秒更新(分頁隱藏時放慢 5 倍),只在面板開啟時輪詢;關閉時清掉排程並作廢在途請求
 *   - 切換類型或分鐘數:清掉舊結果並立即重查
 *   - mock 模式(warroomMock):回固定假資料,不呼叫 API
 * 純函式 topListsOf、kpiListsOf 匯出給畫面與測試共用。
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { paLive, type LogType, type PaLiveTop } from '@/api/paLive';
import { resolveMock } from './warroomMock';

export const TOP_POLL_MS = 30_000;
export const TOP_MINUTES = [5, 15, 60] as const;
export type TopMinutes = (typeof TOP_MINUTES)[number];

export const DIM_TITLES: Record<string, string> = {
  src: '來源 IP', dst: '目的 IP', app: 'App', rule: '規則', port: 'Port',
  srcBytes: '來源 IP(流量)', dstBytes: '目的 IP(流量)', appBytes: 'App(流量)',
  name: '名稱', host: '網站', category: '類別', user: '使用者', filetype: '檔案類型', error: '錯誤',
  sni: '網站(SNI)', publicIp: '外部 IP', region: '地區', ip: 'IP', action: 'Action', proto: '協定',
  severity: '嚴重度', subtype: '類型', direction: '方向', verdict: '判定', status: '狀態',
  errIndex: '錯誤階段', tls: 'TLS 版本', eventId: '事件',
};

/** 阻擋、高嚴重度等要標紅的值 */
export const BAD_VALUE = /^(deny|drop|reset|block|critical|high|failure|malware|phishing)/i;

export interface TopListView {
  dim: string;
  title: string;
  byBytes: boolean;
  items: { key: string; n: number; bytes?: number }[];
}

export function topListsOf(top: PaLiveTop | null): TopListView[] {
  return Object.entries(top?.tops ?? {})
    .filter(([, items]) => items.length)
    .map(([dim, items]) => {
      const byBytes = dim.endsWith('Bytes');
      return { dim, title: DIM_TITLES[dim] ?? dim, byBytes, items: items.map((x) => (byBytes ? { key: x.key, n: 0, bytes: x.value } : { key: x.key, n: x.value })) };
    });
}

export function kpiListsOf(top: PaLiveTop | null, limit = 6): { key: string; title: string; items: [string, number][] }[] {
  return Object.entries(top?.kpis ?? {}).map(([k, v]) => ({
    key: k,
    title: DIM_TITLES[k] ?? k,
    items: Object.entries(v).sort((a, b) => b[1] - a[1]).slice(0, limit),
  }));
}

function mockTop(type: LogType, minutes: number): PaLiveTop {
  return {
    type,
    minutes,
    totals: { count: 1234 * minutes, bytes: 5_600_000 * minutes },
    kpis: { action: { allow: 1100 * minutes, deny: 134 * minutes } },
    tops: {
      src: [{ key: '10.10.30.21', value: 320 }, { key: '45.155.205.12', value: 210 }],
      app: [{ key: 'ssl', value: 540 }, { key: 'ssh', value: 120 }],
      dstBytes: [{ key: '10.10.130.124', value: 9_800_000 }],
    },
    perMinute: [],
    retentionSec: 86_400,
  };
}

export function useLiveTop(options: { active: Ref<boolean>; mock?: boolean }) {
  const mock = resolveMock(options.mock);
  const type = ref<LogType>('traffic');
  const minutes = ref<TopMinutes>(15);
  const top = shallowRef<PaLiveTop | null>(null);
  const error = ref<Error | null>(null);
  const loading = ref(false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  let lastOkAt = 0;

  /** 作廢在途請求並清掉排程(關閉面板、切換條件、卸載) */
  function halt() {
    seq++;
    clearTimeout(timer);
    timer = undefined;
    loading.value = false;
  }

  async function run(): Promise<void> {
    halt();
    const my = seq;
    loading.value = true;
    let r: PaLiveTop | Error;
    try {
      r = await (mock ? Promise.resolve(mockTop(type.value, minutes.value)) : paLive.top(type.value, minutes.value, 10));
    } catch (e) {
      r = e as Error;
    }
    if (my !== seq) return;
    loading.value = false;
    if (r instanceof Error) error.value = r;
    else {
      top.value = r;
      error.value = null;
      lastOkAt = Date.now();
    }
    if (options.active.value) timer = setTimeout(run, typeof document !== 'undefined' && document.hidden ? TOP_POLL_MS * 5 : TOP_POLL_MS);
  }

  watch([type, minutes], () => {
    top.value = null;
    error.value = null;
    if (options.active.value) void run();
  });
  watch(
    options.active,
    (on) => {
      if (!on) return halt();
      // 重新開啟:結果已超過一輪就清掉,先顯示載入中而不是過期排行
      if (Date.now() - lastOkAt > TOP_POLL_MS) top.value = null;
      void run();
    },
    { immediate: true },
  );
  if (getCurrentScope()) onScopeDispose(halt);

  return {
    mock,
    type,
    minutes,
    top,
    error,
    loading,
    lists: computed(() => topListsOf(top.value)),
    kpis: computed(() => kpiListsOf(top.value)),
    reload: run,
  };
}

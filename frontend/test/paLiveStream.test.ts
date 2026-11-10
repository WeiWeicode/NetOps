/**
 * 即時串流的重連(驗收 2026-11-10 §4.4-3):EventSource 不經 web-kit,登入逾時(401)時不會自己 Refresh。
 * 串流收到 401 → 先呼叫 web-kit refreshSession;成功立即重連,失敗導向登入;換發後仍 401 才照一般錯誤退避。
 * 另含介面流量顯示(§4.4-1)。
 */
import { effectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollectorStatus } from '@/api/paLive';
import { interfaceView, useLiveStream } from '@/composables/paLive';

const kit = vi.hoisted(() => ({ refreshSession: vi.fn(), redirectToLogin: vi.fn() }));
const api = vi.hoisted(() => ({ probeStream: vi.fn(), snapshot: vi.fn() }));

vi.mock('@/api/gateway', async (orig) => ({ ...(await orig<typeof import('@/api/gateway')>()), ...kit }));
vi.mock('@/api/paLive', async (orig) => {
  const real = await orig<typeof import('@/api/paLive')>();
  return { ...real, paLive: { ...real.paLive, ...api } };
});

class FakeEventSource {
  static readonly CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = 0;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  /** 伺服器回非 200:瀏覽器關閉連線並觸發 error */
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

/** 讓 probeStream、refreshSession 的 await 鏈跑完(假計時器,不依賴真實計時器排序) */
const flush = () => vi.advanceTimersByTimeAsync(0);

function start() {
  const scope = effectScope();
  const s = scope.run(() => useLiveStream(() => undefined))!;
  s.connect(['threat'], {});
  return { s, scope };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.all = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  api.snapshot.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('useLiveStream 遇 401', () => {
  it('先換發 Token,成功後立即重連(不等退避)', async () => {
    api.probeStream.mockResolvedValue({ status: 401, code: 'UNAUTHENTICATED' });
    kit.refreshSession.mockResolvedValue(true);
    const { scope } = start();
    FakeEventSource.all[0]!.fail();
    await flush();
    expect(kit.refreshSession).toHaveBeenCalledTimes(1);
    expect(kit.redirectToLogin).not.toHaveBeenCalled();
    expect(FakeEventSource.all).toHaveLength(2);
    scope.stop();
  });

  it('換發失敗:導向登入,不再重連', async () => {
    api.probeStream.mockResolvedValue({ status: 401, code: 'UNAUTHENTICATED' });
    kit.refreshSession.mockResolvedValue(false);
    const { scope } = start();
    FakeEventSource.all[0]!.fail();
    await flush();
    expect(kit.redirectToLogin).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.all).toHaveLength(1);
    scope.stop();
  });

  it('換發成功但重連仍 401:不再換發,改照一般錯誤退避(避免無限重連)', async () => {
    api.probeStream.mockResolvedValue({ status: 401, code: 'UNAUTHENTICATED' });
    kit.refreshSession.mockResolvedValue(true);
    const { s, scope } = start();
    FakeEventSource.all[0]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeEventSource.all).toHaveLength(2);
    FakeEventSource.all[1]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(kit.refreshSession).toHaveBeenCalledTimes(1);
    expect(s.streamError.value).toContain('10 秒後重新連線');
    expect(FakeEventSource.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeEventSource.all).toHaveLength(3);
    scope.stop();
  });

  it('換發等待中使用者換類型或離開頁面:舊連線的換發結果不再重連、不導向登入', async () => {
    api.probeStream.mockResolvedValue({ status: 401, code: 'UNAUTHENTICATED' });
    let done!: (ok: boolean) => void;
    kit.refreshSession.mockReturnValue(new Promise<boolean>((r) => (done = r)));
    const { s, scope } = start();
    FakeEventSource.all[0]!.fail();
    await flush();
    expect(kit.refreshSession).toHaveBeenCalledTimes(1);
    s.connect(['url'], {});
    expect(FakeEventSource.all).toHaveLength(2);
    done(false);
    await flush();
    expect(kit.redirectToLogin).not.toHaveBeenCalled();
    expect(FakeEventSource.all).toHaveLength(2);
    scope.stop();
  });

  it('其他錯誤(429)不換發 Token,照原本的退避', async () => {
    api.probeStream.mockResolvedValue({ status: 429, code: 'NETOPS_STREAM_BUSY' });
    const { s, scope } = start();
    FakeEventSource.all[0]!.fail();
    await flush();
    expect(kit.refreshSession).not.toHaveBeenCalled();
    expect(s.streamError.value).toContain('串流連線數已達上限');
    scope.stop();
  });
});

describe('interfaceView(驗收 2026-11-10 §4.4-1)', () => {
  const col = (poll: Partial<CollectorStatus['poll']>) => ({ poll: { enabled: true, paused: false, ...poll } }) as CollectorStatus;
  const ifs = { time: '2026-11-10T01:00:00Z', items: [{ name: 'ae1', rxBps: 1, txBps: 2 }] };

  it('輪詢中照常顯示', () => {
    expect(interfaceView(col({}), ifs)).toEqual({ visible: true, items: ifs.items, stale: '' });
  });
  it('輪詢暫停:不顯示最後一輪的值', () => {
    expect(interfaceView(col({ paused: true }), ifs)).toEqual({ visible: true, items: [], stale: '輪詢暫停,介面計數已清除' });
  });
  it('快照過期(null):顯示停止更新', () => {
    expect(interfaceView(col({}), null)).toMatchObject({ visible: true, items: [], stale: '沒有 60 秒內的資料' });
  });
  it('輪詢沒開也沒有資料:不顯示卡片', () => {
    expect(interfaceView(col({ enabled: false }), null).visible).toBe(false);
    expect(interfaceView(null, null).visible).toBe(false);
  });
});

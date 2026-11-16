// @vitest-environment happy-dom
/**
 * AI 分析對話框(AC2):ClickHouse 來源的 meta 顯示、超過 30 天的期間註明「資料較粗」;FTP 來源(正式區 C6 前)沿用舊文字
 */
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

let meta: Record<string, unknown> = {};
vi.mock('@/api/ai', () => ({
  AiStreamError: class extends Error {},
  ai: {
    status: async () => ({ enabled: true, ok: true, model: 'm', message: '' }),
    analyze: async (_b: unknown, on: (e: { event: string; data: unknown }) => void) => {
      on({ event: 'meta', data: meta });
      on({ event: 'content', data: { text: '## 整體結論\n正常' } });
      on({ event: 'done', data: { finish: 'stop', truncated: false } });
    },
  },
}));

const { default: ui } = await import('@/ui');
const { default: AiAnalysis } = await import('@/components/AiAnalysis.vue');

const base = { model: 'm', files: 0, missing: 0, rows: 1234, notes: [], vectorError: false };

async function run(m: Record<string, unknown>) {
  meta = m;
  const w = mount(AiAnalysis, { props: { from: '2026-08-14', to: '2026-11-13', modelValue: true }, global: { plugins: [ui] }, attachTo: document.body });
  await flushPromises();
  const start = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('開始分析'));
  start!.click();
  await flushPromises();
  const text = document.body.textContent ?? '';
  w.unmount();
  return text;
}

describe('AiAnalysis(AC2)', () => {
  it('ClickHouse 來源有較粗的期間:顯示小時 / 天數與「超過 30 天的資料較粗」', async () => {
    const t = await run({
      ...base,
      source: 'clickhouse',
      hours: 720,
      days: 62,
      missing: 2,
      grain: { detail: { from: '2026-10-15', to: '2026-11-13' }, coarse: { from: '2026-08-14', to: '2026-10-14' }, rawDays: 30 },
      coverage: { from: '2026-08-01', to: '2026-11-13' },
      partial: false,
      summaryState: 'ok',
    });
    expect(t).toContain('ClickHouse 每小時摘要 720 小時、每天彙總 62 天、1,234 筆連線紀錄');
    expect(t).toContain('2 小時的摘要還沒建好');
    expect(t).toContain('超過 30 天的資料較粗');
    expect(t).toContain('2026-08-14 ~ 2026-10-14 只有每天 / 每小時彙總');
    expect(t).not.toContain('個 log 檔');
  });

  it('ClickHouse 來源都在 30 天內:沒有較粗提示;期間早於最早資料時註明', async () => {
    const t = await run({ ...base, source: 'clickhouse', hours: 24, days: 0, grain: { detail: { from: '2026-11-12', to: '2026-11-12' }, coarse: null, rawDays: 30 }, coverage: { from: '2026-11-12', to: '2026-11-13' }, partial: true, summaryState: 'stale' });
    expect(t).not.toContain('資料較粗');
    expect(t).toContain('2026-11-12 之前沒有資料');
    expect(t).toContain('每小時摘要尚未更新完成');
  });

  it('FTP 來源:沿用「N 個 log 檔」', async () => {
    const t = await run({ ...base, source: 'ftp', files: 6, missing: 1 });
    expect(t).toContain('6 個 log 檔、1,234 筆連線紀錄');
    expect(t).toContain('1 個檔案的摘要讀不到');
    expect(t).not.toContain('ClickHouse 每小時摘要');
  });
});

/**
 * AC4 AI 解讀(時段明細「AI 解讀這個時段」、分析儀表板「AI 摘要本期異常」)的狀態與串流(docs/API.md §10.3)。
 *   POST /api/netops/ai/explanations(SSE);後端依參數自己取資料,畫面只送條件(不送統計)
 *   phase:idle → preparing(取資料 / 等時段明細工作)→ thinking → writing → done;error 保留已收到的內容並標示不完整
 *   換了條件(key 改變)時清掉舊的回答;元件卸載時中斷串流
 */
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue';
import { ai, AiStreamError, type ExplainInput, type ExplainMeta } from '@/api/ai';
import { describeError } from '@/api/gateway';

export type ExplainPhase = 'idle' | 'preparing' | 'thinking' | 'writing' | 'done' | 'error';

/** 條件的比對鍵(同條件才沿用回答) */
export const explainKey = (input: ExplainInput | null) => (input ? JSON.stringify([input.kind, input.params]) : '');

/** meta → 要提示使用者的資料限制(資料不完整要明確標示,AGENT.md §5) */
export function explainNotices(m: ExplainMeta | null): { tone: 'warning' | 'info'; text: string }[] {
  if (!m) return [];
  const out: { tone: 'warning' | 'info'; text: string }[] = [];
  if (m.partial) out.push({ tone: 'warning', text: '資料落在已知缺口內(FTP 對帳發現少資料),AI 看到的數量可能少於實際' });
  else if (!m.gapsKnown) out.push({ tone: 'info', text: '這段資料尚未完成每日 FTP 對帳檢查' });
  if (m.kind === 'insight' && m.prev === false) out.push({ tone: 'info', text: '前一期資料不足,這次不和前一期比較' });
  if (m.clipped) out.push({ tone: 'info', text: '排行較多,只送前面的部分給 AI' });
  if (m.vectorError) out.push({ tone: 'info', text: '知識庫語意搜尋失敗,筆記改用關鍵字比對' });
  return out;
}

export function useAiExplain() {
  const phase = ref<ExplainPhase>('idle');
  const text = ref('');
  const error = ref('');
  const meta = shallowRef<ExplainMeta | null>(null);
  const thinkingChars = ref(0);
  const truncated = ref(false);
  /** 正在等時段明細查完(scan waiting) */
  const waiting = ref(false);
  const elapsed = ref(0);
  /** 目前回答對應的條件 */
  const answeredKey = ref('');
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** 每次 start / reset 加一:被 reset 中斷的舊回答不再改狀態 */
  let runId = 0;

  const running = computed(() => phase.value === 'preparing' || phase.value === 'thinking' || phase.value === 'writing');
  const statusText = computed(() => {
    if (phase.value === 'preparing') return waiting.value ? '時段明細還在查詢,查完後交給 AI...' : '整理統計、等待 AI 回應...';
    if (phase.value === 'thinking') return `AI 思考中...(已思考 ${thinkingChars.value.toLocaleString()} 字)`;
    if (phase.value === 'writing') return 'AI 撰寫中...';
    return '';
  });
  const notices = computed(() => explainNotices(meta.value));

  /** 清掉回答;進行中的回答一併中斷(換了條件時用) */
  function reset() {
    runId++;
    controller?.abort();
    controller = null;
    clearInterval(timer);
    timer = undefined;
    phase.value = 'idle';
    text.value = '';
    error.value = '';
    meta.value = null;
    thinkingChars.value = 0;
    truncated.value = false;
    waiting.value = false;
    elapsed.value = 0;
    answeredKey.value = '';
  }

  async function start(input: ExplainInput, opts: { think?: boolean } = {}) {
    if (running.value) return;
    reset();
    const id = ++runId;
    const live = () => id === runId;
    answeredKey.value = explainKey(input);
    phase.value = 'preparing';
    const ctl = new AbortController();
    controller = ctl;
    const t0 = Date.now();
    timer = setInterval(() => (elapsed.value = Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      await ai.explain(
        { ...input, think: opts.think === true },
        (e) => {
          if (!live()) return;
          const p = (e.data ?? {}) as Record<string, unknown>;
          if (e.event === 'meta') {
            meta.value = p as unknown as ExplainMeta;
            waiting.value = false;
          } else if (e.event === 'scan') waiting.value = p.waiting === true;
          else if (e.event === 'thinking') {
            phase.value = 'thinking';
            thinkingChars.value = Number(p.chars) || 0;
          } else if (e.event === 'content') {
            phase.value = 'writing';
            text.value += String(p.text ?? '');
          } else if (e.event === 'done') truncated.value = p.truncated === true;
        },
        ctl.signal,
      );
      if (!live()) return;
      phase.value = text.value ? 'done' : 'error';
      if (!text.value) error.value = 'AI 沒有產生內容,請再試一次';
    } catch (err) {
      if (!live()) return;
      if ((err as Error).name === 'AbortError') {
        phase.value = text.value ? 'done' : 'idle';
        if (text.value) error.value = '已停止,回答不完整';
      } else {
        // 連線中斷(沒有收到 done)時保留已收到的內容,並標示不完整
        if (text.value) truncated.value = true;
        phase.value = 'error';
        error.value = err instanceof AiStreamError ? err.message : describeError(err);
      }
    } finally {
      if (live()) {
        clearInterval(timer);
        timer = undefined;
        controller = null;
        waiting.value = false;
      }
    }
  }

  const stop = () => controller?.abort();
  if (getCurrentScope())
    onScopeDispose(() => {
      runId++;
      stop();
      clearInterval(timer);
    });

  return { phase, text, error, meta, thinkingChars, truncated, waiting, elapsed, running, statusText, notices, answeredKey, start, stop, reset };
}

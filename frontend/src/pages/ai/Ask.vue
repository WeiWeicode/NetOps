<script setup lang="ts">
/**
 * AI 問答(由舊版 src/views/PaAsk.vue 搬移;docs/API.md §10.1;IMPL-PLAN A1)。PA 防火牆與 AD 網域共用(source = 'pa' | 'ad')
 *   PA:問題有 IP / Port → 後端查連線組合統計或從 FTP 掃 log,彙整後送給公司內部 AI;問到 AD 時一併附上 AD 事件
 *   AD:只看已匯入的 AD 事件記錄,不掃防火牆 log;兩邊的對話分開保存(composables/aiChat.ts)
 *   追問沒寫 IP 會沿用前面的 IP;對話只存在這個分頁,重新整理就清空(同舊版)
 *   舊版的「請 AI 記錄」(整理成知識庫筆記)與翻譯依 2026-11-09 決定不搬(ARCHITECTURE D25)
 *   使用 AI 需要按鈕權限(netops.pa-ask.use / netops.ad-ask.use → netops.ai.use);沒有時只顯示說明(BFF 一定再檢查)
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ad } from '@/api/ad';
import { ai, AiStreamError, type AiStatus } from '@/api/ai';
import { can, describeError } from '@/api/gateway';
import { pa } from '@/api/pa';
import { UI } from '@/api/perms';
import AiMarkdown from '@/components/AiMarkdown.vue';
import { applyEvent, clearMessages, coarseNote, historyOf, messagesOf, searchLink, type ChatMessage, type Source } from '@/composables/aiChat';
import { localToIso, toLocalInput } from '@/composables/searchQuery';
import { toast } from '@/ui';

const props = defineProps<{ source: Source }>();
const isAd = props.source === 'ad';
const route = useRoute();
const router = useRouter();
const canUse = computed(() => can(isAd ? UI.adAskUse : UI.paAskUse));

const TEXT = isAd
  ? {
      empty: '問 AD 事件記錄的問題',
      desc: '系統會把這段時間的 AD 事件統計、需要注意的事件、帳號與特權異動,以及問題中帳號 / IP / 事件 ID 的相關事件整理給 AI。可以接著追問。',
      placeholder: '例如:S094009 為什麼被鎖定?事件 5719 要怎麼處理?(Ctrl + Enter 送出)',
      footer: 'AI 依 AD 事件記錄自動判斷,內容僅供參考;調整 AD 設定前請以「Log 明細查詢」與 DC 的事件檢視器確認。',
      examples: ['AD 網域控制站有哪些錯誤或警告?要怎麼處理?', '有沒有建立帳號或加入特權群組(Domain Admins 等)?', '事件 5719 和事件 37 是什麼問題?要怎麼處理?', '哪些帳號登入失敗或被鎖定最多?'],
    }
  : {
      empty: '問防火牆 log 的問題',
      desc: '問題裡寫 IP(可加 Port),系統會查這段時間的防火牆 log,把這些 IP 的連線、被擋規則、結束原因整理給 AI;問到 AD(帳號、登入、DNS、Kerberos、事件 ID)會一併附上 AD 事件記錄。時間越短越快。可以接著追問,沒寫 IP 會沿用上一題的 IP。',
      placeholder: '例如:10.10.112.1 連到 10.10.130.154 被擋,幫我查看問題(Ctrl + Enter 送出)',
      footer: 'AI 依 log 自動判斷,內容僅供參考;調整防火牆政策前請以「看原始紀錄」與 PA 管理介面確認。',
      examples: ['10.10.112.1 連到外面被擋,幫我查看問題', '10.10.130.3 的 445 port 有誰連不到?', '這段時間有沒有疑似掃描或中毒的主機?', 'AD 網域控制站有哪些錯誤或警告?要怎麼處理?'],
    };

const messages = messagesOf(props.source);
const range = reactive({ from: '', to: '' });
const input = ref('');
const think = ref(false);
const running = ref(false);
const service = shallowRef<AiStatus | null>(null);
const listEl = ref<HTMLElement | null>(null);
let controller: AbortController | null = null;

const rangeError = computed(() => {
  if (!range.from || !range.to) return '請選擇時間範圍';
  if (range.from > range.to) return '開始時間不可晚於結束時間';
  return '';
});
const unavailable = computed(() => !canUse.value || (service.value !== null && !service.value.ok));

async function scrollDown() {
  await nextTick();
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' });
}

/** 新增一則回覆訊息,回傳 reactive 版本(之後的修改才會更新畫面) */
function push(m: ChatMessage): ChatMessage {
  messages.push(m);
  return messages[messages.length - 1]!;
}

async function send(text = input.value) {
  const question = text.trim();
  if (!question || running.value || unavailable.value) return;
  if (rangeError.value) return toast.warning(rangeError.value);
  const history = historyOf(messages);
  push({ role: 'user', content: question });
  // 記住送出時的期間:之後改了時間,「看原始紀錄」仍用這一題的期間
  const r = push({ role: 'assistant', content: '', evidence: null, status: '準備中...', error: '', from: range.from, to: range.to });
  input.value = '';
  running.value = true;
  controller = new AbortController();
  void scrollDown();
  try {
    await ai.ask(
      { from: localToIso(range.from), to: localToIso(range.to), question, history, think: think.value, source: props.source },
      (e) => {
        applyEvent(r, e, isAd);
        if (e.event === 'content' && r.content.length % 400 < String((e.data as { text?: string }).text ?? '').length) void scrollDown();
      },
      controller.signal,
    );
    if (!r.content) r.error = 'AI 沒有產生內容,請再試一次';
  } catch (e) {
    // 停止或中斷時保留已收到的內容並標示不完整(有 error 的訊息不會進入之後的對話紀錄)
    if ((e as Error).name === 'AbortError') r.error = r.content ? '已停止,回答不完整' : '已停止';
    else r.error = e instanceof AiStreamError ? e.message : describeError(e);
  } finally {
    r.status = '';
    running.value = false;
    controller = null;
    void scrollDown();
  }
}

const stop = () => controller?.abort();
function clearChat() {
  stop();
  clearMessages(props.source);
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已複製(Markdown)');
  } catch {
    toast.error('無法複製,請手動選取文字');
  }
}

const openSearch = (m: ChatMessage) => void router.push(searchLink(m, m.from ?? range.from, m.to ?? range.to, isAd));
const fmt = (n: number | undefined) => (Number(n) || 0).toLocaleString('en-US');

onMounted(async () => {
  // 預設:最新一天有資料的整天;從其他頁帶過來的問題(?q=&from=&to=,YYYY-MM-DD)填入輸入框,由使用者送出(同舊版)
  const [days, st] = await Promise.all([
    (isAd ? ad.days().then((r) => r.days[0]?.day) : pa.days().then((r) => r.days[0]?.day)).catch(() => undefined),
    canUse.value ? ai.status().catch((e) => ({ enabled: true, ok: false, model: '', message: describeError(e) })) : Promise.resolve(null),
  ]);
  service.value = st;
  if (days && !range.from) Object.assign(range, { from: toLocalInput(days), to: toLocalInput(days, true) });
  const q = route.query;
  if (typeof q.from === 'string' && toLocalInput(q.from)) Object.assign(range, { from: toLocalInput(q.from), to: toLocalInput(typeof q.to === 'string' ? q.to : q.from, true) });
  if (typeof q.q === 'string' && q.q.trim()) {
    input.value = q.q.slice(0, 2000);
    void router.replace({ query: {} });
  }
});
onBeforeUnmount(stop);

const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void send();
  }
};
</script>

<template>
  <div class="stack" style="--gap: 12px">
    <Teleport to="#page-actions" defer>
      <GButton icon="trash" :disabled="!messages.length" @click="clearChat">清除對話</GButton>
    </Teleport>

    <GAlert v-if="!canUse" tone="warning">沒有使用 AI 問答的權限(netops.ai.use),請洽系統負責人。</GAlert>
    <GAlert v-else-if="service && !service.ok" tone="danger">{{ service.message }}</GAlert>

    <GCard padding="sm">
      <div class="filters">
        <GInput v-model="range.from" type="datetime-local" label="開始時間" :disabled="running" class="dt" />
        <GInput v-model="range.to" type="datetime-local" label="結束時間" :disabled="running" class="dt" />
        <p class="small muted hint">{{ isAd ? '只看已匯入的 AD 事件記錄' : '期間最長 31 天;有 IP 時從 log 查詢,時間越短越快' }}</p>
      </div>
      <p v-if="rangeError" class="small c-danger err">{{ rangeError }}</p>
    </GCard>

    <GCard class="chat" padding="none">
      <div ref="listEl" class="list" aria-live="polite">
        <div v-if="!messages.length" class="intro">
          <GIcon name="sparkles" :size="36" class="tone-primary ic-lg" />
          <p class="strong">{{ TEXT.empty }}</p>
          <p class="small muted">{{ TEXT.desc }}</p>
          <p class="small muted">回答會參考<RouterLink to="/knowledge">知識庫</RouterLink>的筆記;要補充環境資訊,請到知識庫新增筆記。</p>
          <div class="examples">
            <button v-for="q in TEXT.examples" :key="q" type="button" class="example" :disabled="unavailable" @click="send(q)">{{ q }}</button>
          </div>
          <p class="xs faint">資料只送到公司內部的 AI 服務{{ service?.model ? `(${service.model})` : '' }},不會傳到外部。</p>
        </div>

        <template v-for="(m, i) in messages" :key="i">
          <div v-if="m.role === 'user'" class="row-user">
            <div class="bubble-user">{{ m.content }}</div>
          </div>
          <div v-else class="bubble-ai">
            <!-- 查到的資料 -->
            <div v-if="m.evidence" class="evidence">
              <template v-if="m.evidence.summary && m.evidence.source === 'clickhouse'">
                {{ m.evidence.label }}<template v-if="m.evidence.hours || m.evidence.days">(每小時摘要 {{ fmt(m.evidence.hours) }} 小時<template v-if="m.evidence.days">、每天彙總 {{ fmt(m.evidence.days) }} 天</template>)</template>
                <span v-if="m.evidence.missing" class="c-warning"> · {{ fmt(m.evidence.missing) }} 小時的摘要還沒建好,資料不完整</span>
                <span v-if="!m.evidence.hours && !m.evidence.days" class="c-warning"> · 這段期間沒有資料</span>
                <span v-if="coarseNote(m.evidence.grain)" class="evidence-note c-warning"><GIcon name="alert-triangle" :size="13" /> {{ coarseNote(m.evidence.grain) }}</span>
              </template>
              <template v-else-if="m.evidence.summary">
                {{ m.evidence.label }}<span v-if="m.evidence.missing" class="c-warning"> · {{ m.evidence.missing }} 個檔案的摘要讀不到,資料不完整</span>
              </template>
              <template v-else-if="m.evidence.source === 'clickhouse'">
                <b>{{ m.evidence.label }}</b>:符合 {{ fmt(m.evidence.matched) }} 筆(<span class="c-success">允許 {{ fmt(m.evidence.allow) }}</span>、<span class="c-danger">阻擋 {{ fmt(m.evidence.block) }}</span>,{{ fmt(m.evidence.flows) }} 種連線組合<template v-if="m.evidence.samples">、{{ m.evidence.samples }} 筆範例</template>)
                · {{ m.evidence.cached ? '沿用剛才的查詢' : `查詢 ${m.evidence.seconds} 秒` }}
                <span v-if="m.evidence.partial" class="c-warning"> · 符合的連線組合太多,只取次數最多的部分,資料不完整</span>
                <span v-if="m.evidence.skipped" class="evidence-note c-warning">
                  <GIcon name="alert-triangle" :size="13" /> {{ m.evidence.skipped.from }} ~ {{ m.evidence.skipped.to }} 超過原始 log 保留期限,沒有資料可查(不代表沒有連線)
                </span>
                <GButton size="sm" variant="ghost" icon="search" @click="openSearch(m)">看原始紀錄</GButton>
              </template>
              <template v-else>
                <b>{{ m.evidence.label }}</b>:符合 {{ fmt(m.evidence.matched) }} 筆(<span class="c-success">允許 {{ fmt(m.evidence.allow) }}</span>、<span class="c-danger">阻擋 {{ fmt(m.evidence.block) }}</span>,{{ fmt(m.evidence.flows) }} 種連線組合)· 查了
                {{ m.evidence.filesScanned }} / {{ m.evidence.files }} 檔
                <template v-if="m.evidence.flowFiles">({{ m.evidence.flowFiles === m.evidence.files ? '全部' : m.evidence.flowFiles }} 查連線統計<template v-if="m.evidence.rows">,其餘從 FTP 掃 {{ fmt(m.evidence.rows) }} 列</template>)</template>
                <template v-else>、{{ fmt(m.evidence.rows) }} 列</template>
                {{ m.evidence.cached ? '(沿用剛才的查詢)' : `、${m.evidence.seconds} 秒` }}
                <span v-if="m.evidence.partial" class="c-warning"> · 掃描逾時,資料不完整</span>
                <GButton size="sm" variant="ghost" icon="search" @click="openSearch(m)">看原始紀錄</GButton>
              </template>
            </div>
            <div v-if="m.events" class="evidence">
              <GIcon name="shield-alert" :size="13" class="c-warning" />
              <template v-if="m.events.summary"> 一併參考威脅 / URL / VPN 等 log 的期間摘要</template>
              <template v-else> 其他 log 也有這些 IP:{{ (m.events.hits ?? []).map((h) => `${h.label} ${fmt(h.total)} 次`).join('、') }}</template>
            </div>
            <div v-if="m.ad" class="evidence">
              <GIcon name="gateway" :size="13" class="tone-primary" /> {{ m.ad.label }}<template v-if="m.ad.total">({{ fmt(m.ad.total) }} 筆)</template>
              <GButton size="sm" variant="ghost" icon="search" @click="openSearch(m)">看 AD 事件明細</GButton>
            </div>
            <div v-if="m.notes?.length || m.vectorError" class="evidence">
              <GIcon name="book-open" :size="13" class="tone-primary" />
              <template v-if="m.notes?.length">
                參考知識庫({{ m.notes.length }} 則,粗體為判斷相關):
                <RouterLink v-for="n in m.notes" :key="n.id" :to="{ path: '/knowledge', query: { id: n.id } }" :class="['note-link', { strong: n.related }]">{{ n.title }}</RouterLink>
              </template>
              <span v-if="m.notesOmitted?.length" class="c-warning"> 另有 {{ m.notesOmitted.length }} 則超過字數上限只附標題</span>
              <span v-if="m.vectorError" class="c-warning"> · 語意搜尋失敗,筆記改用關鍵字與 IP 比對</span>
            </div>
            <AiMarkdown v-if="m.content" :text="m.content" />
            <p v-if="m.truncated" class="xs c-warning">回答超過長度上限,內容可能不完整</p>
            <p v-if="m.status" class="small muted status" role="status"><span class="spin" aria-hidden="true" />{{ m.status }}</p>
            <p v-if="m.error" class="small c-danger">{{ m.error }}</p>
            <div v-if="m.content && !m.status" class="tools">
              <GButton size="sm" variant="ghost" icon="file-text" @click="copy(m.content)">複製</GButton>
            </div>
          </div>
        </template>
      </div>

      <div class="composer">
        <GTextarea v-model="input" label="問題" :rows="3" :placeholder="TEXT.placeholder" :disabled="running || unavailable" maxlength="2000" @keydown="onKey" />
        <div class="actions">
          <GCheckbox v-model="think" :disabled="running || unavailable" label="深入思考(較慢,先推理再回答)" />
          <span class="spacer" />
          <GButton v-if="running" variant="danger" icon="square" @click="stop">停止</GButton>
          <template v-else>
            <GButton variant="primary" icon="send" :disabled="!input.trim() || unavailable" @click="send()">送出</GButton>
          </template>
        </div>
        <p class="xs faint">{{ TEXT.footer }}</p>
      </div>
    </GCard>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}
.dt {
  width: 220px;
}
.hint {
  margin: 0 0 10px;
}
.err {
  margin: 8px 0 0;
}
.chat {
  display: flex;
  flex-direction: column;
  min-height: 480px;
}
.list {
  flex: 1;
  max-height: 64vh;
  overflow-y: auto;
  padding: 16px;
  display: grid;
  gap: 14px;
  align-content: start;
}
.intro {
  max-width: 720px;
  margin: 12px auto;
  text-align: center;
}
.intro p {
  margin: 6px 0;
}
.ic-lg {
  color: var(--c-primary);
}
.examples {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin: 14px 0;
}
.example {
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--glass-soft);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm, 0.875rem);
  cursor: pointer;
}
.example:hover:not(:disabled) {
  border-color: var(--c-primary);
}
.example:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.row-user {
  display: flex;
  justify-content: flex-end;
}
.bubble-user {
  max-width: min(720px, 85%);
  padding: 8px 12px;
  border-radius: 14px 14px 4px 14px;
  background: color-mix(in srgb, var(--c-primary) 12%, transparent);
  border: 1px solid var(--line);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.bubble-ai {
  max-width: 980px;
  min-width: 0;
  padding: 10px 14px;
  border-radius: 14px 14px 14px 4px;
  background: var(--glass-soft);
  border: 1px solid var(--line);
}
.evidence {
  font-size: var(--fs-sm, 0.8125rem);
  color: var(--text-2);
  padding: 6px 10px;
  margin-bottom: 8px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--c-primary) 6%, transparent);
}
.evidence-note {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin-top: 4px;
}
.evidence-note :deep(svg) {
  flex: none;
  margin-top: 3px;
}
.note-link {
  margin-right: 8px;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0 0;
}
.spin {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--c-primary) 30%, transparent);
  border-top-color: var(--c-primary);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.tools {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  margin-top: 6px;
}
.composer {
  border-top: 1px solid var(--line);
  padding: 12px 16px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.spacer {
  flex: 1;
}
.composer p {
  margin: 6px 0 0;
}
</style>

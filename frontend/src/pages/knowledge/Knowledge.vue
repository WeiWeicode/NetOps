<script setup lang="ts">
/**
 * 網通知識 › 知識庫(docs/API.md §7;舊版 src/views/Knowledge.vue):
 *   筆記查詢(關鍵字以空白分隔、全部符合)、閱讀(Markdown 經 DOMPurify)、下載 .md、匯整檔預覽與下載;
 *   有編輯權限(UI.kbWrite)可新增、修改、刪除。?id= 記住目前筆記(__all__ = 匯整檔)。
 *   AI 功能(IMPL-PLAN A1;docs/API.md §10.2):語意搜尋(向量庫)、向量庫狀態與立即同步(VECTOR_SYNC 開啟時)、外部 IP 自動學習(components/IpLearning.vue);
 *   請 AI 記錄筆記在 AI 問答頁。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { can, describeError, download } from '@/api/gateway';
import { fmtTime } from '@/api/format';
import { KB_CONTENT_MAX, KB_IPS_MAX, KB_TAGS_MAX, KB_TITLE_MAX, kb, splitList, type KbCompilation, type KbNote } from '@/api/kb';
import { UI } from '@/api/perms';
import { renderMarkdown } from '@/composables/markdown';
import { ai, type VectorStatus } from '@/api/ai';
import IpLearning from '@/components/IpLearning.vue';
import { confirm, toast } from '@/ui';

const ALL = '__all__';
const PAGE_SIZE = 50;
const route = useRoute();
const router = useRouter();
const canWrite = computed(() => can(UI.kbWrite));

// ---------- 清單 ----------
const q = ref('');
const notes = shallowRef<KbNote[]>([]);
const total = ref(0);
const page = ref(1);
const compilation = shallowRef<KbCompilation | null>(null);
const loading = ref(false);
const error = ref<Error | null>(null);
const currentId = ref(typeof route.query.id === 'string' ? route.query.id : '');
let seq = 0;
/** 語意搜尋(向量庫):依意思相近排序,每則附相近度;不分頁(最多 20 則) */
const semantic = ref(false);
const scores = shallowRef<Map<string, number>>(new Map());
const vector = shallowRef<VectorStatus | null>(null);
const learnOpen = ref(false);

/** reloadAll:新增、修改、刪除後要重抓匯整檔 */
async function load(p = 1, reloadAll = false) {
  const my = ++seq;
  loading.value = true;
  error.value = null;
  try {
    let r: { items: KbNote[]; compilation: KbCompilation };
    if (semantic.value && q.value.trim()) {
      // 語意搜尋的回應沒有匯整檔資訊:同時取(新增、修改、刪除後也要更新);全部取回後才更新畫面
      const [s, list] = await Promise.all([ai.semanticSearch(q.value.trim()), !compilation.value || reloadAll ? kb.list('', 1, 1) : null]);
      if (my !== seq) return;
      r = { items: s.items, compilation: list?.compilation ?? compilation.value! };
      scores.value = new Map(s.items.map((n) => [n.id, n.score]));
      total.value = s.items.length;
      page.value = 1;
      vector.value = s.vector;
    } else {
      const res = await kb.list(q.value, p, PAGE_SIZE);
      if (my !== seq) return;
      r = res;
      scores.value = new Map();
      total.value = res.total;
      page.value = res.page;
    }
    notes.value = r.items;
    compilation.value = r.compilation;
    if (currentId.value === ALL) {
      // 沒有任何筆記時匯整檔入口會消失,改回未選取
      if (!r.compilation.count) select(r.items[0]?.id ?? '');
      else if (reloadAll || !allText.value) void loadAll();
    } else if (!current.value && currentId.value) void loadOne(currentId.value);
    else if (!currentId.value && r.items[0]) select(r.items[0].id);
  } catch (e) {
    if (my === seq) error.value = e as Error;
  } finally {
    if (my === seq) loading.value = false;
  }
}
const pages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));

/** 目前筆記不在這一頁(例如從 ?id= 進來或換頁後):另外讀單則 */
const single = shallowRef<KbNote | null>(null);
const singleError = ref<Error | null>(null);
let oneSeq = 0;
let loadingId = '';
async function loadOne(id: string) {
  if (loadingId === id) return;
  const my = ++oneSeq;
  loadingId = id;
  singleError.value = null;
  try {
    const n = await kb.get(id);
    if (my === oneSeq) single.value = n;
  } catch (e) {
    if (my === oneSeq) {
      single.value = null;
      singleError.value = e as Error;
    }
  } finally {
    if (my === oneSeq) loadingId = '';
  }
}
const current = computed(() => (single.value?.id === currentId.value ? single.value : null) ?? notes.value.find((n) => n.id === currentId.value) ?? null);

// ---------- 匯整檔 ----------
const allText = ref('');
const allLoading = ref(false);
const allError = ref<Error | null>(null);
async function loadAll() {
  allLoading.value = true;
  allError.value = null;
  try {
    const t = await kb.compilation();
    allText.value = typeof t === 'string' ? t : '';
  } catch (e) {
    allError.value = e as Error;
  } finally {
    allLoading.value = false;
  }
}

function select(id: string) {
  currentId.value = id;
  void router.replace({ query: { ...route.query, id: id || undefined } });
  if (id === ALL && !allText.value) void loadAll();
}
watch(currentId, (id) => {
  if (id && id !== ALL && !notes.value.some((n) => n.id === id) && single.value?.id !== id) void loadOne(id);
});

const html = computed(() => renderMarkdown(currentId.value === ALL ? allText.value : current.value?.content));

// ---------- 下載 ----------
const downloading = ref(false);
async function downloadMd(n: KbNote | null) {
  downloading.value = true;
  try {
    if (n) await download(kb.markdownPath(n.id), undefined, `${n.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'note'}.md`);
    else await download(kb.compilationPath, undefined, '網通知識庫匯整.md');
  } catch (e) {
    toast.fromError(e, '下載失敗');
  } finally {
    downloading.value = false;
  }
}

// ---------- 新增 / 修改 / 刪除 ----------
const dialog = reactive({ open: false, saving: false, id: '', title: '', ips: '', tags: '', content: '', source: '' });
const dialogError = computed(() => {
  if (!dialog.content.trim()) return '請輸入內容';
  if (dialog.title.length > KB_TITLE_MAX || /[\r\n]/.test(dialog.title)) return `標題最多 ${KB_TITLE_MAX} 字且不可換行`;
  if (dialog.content.length > KB_CONTENT_MAX) return `內容最多 ${KB_CONTENT_MAX.toLocaleString()} 字`;
  if (splitList(dialog.ips).length > KB_IPS_MAX) return `IP 最多 ${KB_IPS_MAX} 個`;
  if (splitList(dialog.tags).length > KB_TAGS_MAX) return `標籤最多 ${KB_TAGS_MAX} 個`;
  return '';
});
function openEdit(n: KbNote | null = null) {
  Object.assign(dialog, {
    open: true,
    saving: false,
    id: n?.id ?? '',
    title: n?.title ?? '',
    ips: n?.ips.join(', ') ?? '',
    tags: n?.tags.join(', ') ?? '',
    content: n?.content ?? '',
    source: n?.source ?? '',
  });
}
async function save() {
  if (dialogError.value) return toast.warning(dialogError.value);
  dialog.saving = true;
  const body = {
    title: dialog.title.trim(),
    ips: splitList(dialog.ips),
    tags: splitList(dialog.tags),
    content: dialog.content,
    source: dialog.source || undefined,
  };
  try {
    const n = dialog.id ? await kb.update(dialog.id, body) : await kb.create(body);
    toast.success(dialog.id ? '已修改筆記' : '已新增筆記', n.title);
    dialog.open = false;
    single.value = n;
    select(n.id);
    allText.value = '';
    await load(dialog.id ? page.value : 1, true);
  } catch (e) {
    toast.fromError(e, '儲存失敗');
  } finally {
    dialog.saving = false;
  }
}
async function remove(n: KbNote) {
  const ok = await confirm({ title: `刪除「${n.title}」?`, message: '刪除後無法復原;匯整檔會一併更新。', confirmText: '刪除', tone: 'danger' });
  if (!ok) return;
  try {
    await kb.remove(n.id);
    toast.success('已刪除筆記', n.title);
    if (currentId.value === n.id) select('');
    if (single.value?.id === n.id) single.value = null;
    allText.value = '';
    // 刪掉該頁最後一筆時退回前一頁
    const last = Math.max(1, Math.ceil((total.value - 1) / PAGE_SIZE));
    await load(Math.min(page.value, last), true);
  } catch (e) {
    toast.fromError(e, '刪除失敗');
  }
}

/** 向量庫狀態(沒有權限或 AI 未設定時不顯示語意搜尋);同步中每 3 秒查一次直到結束 */
let vectorTimer: ReturnType<typeof setTimeout> | undefined;
let unmounted = false;
async function loadVector() {
  clearTimeout(vectorTimer);
  try {
    vector.value = await ai.vectorStatus();
  } catch {
    vector.value = null;
  }
  if (vector.value?.syncing && !unmounted) vectorTimer = setTimeout(() => void loadVector(), 3000);
}
const syncing = ref(false);
async function syncVector() {
  syncing.value = true;
  try {
    vector.value = await ai.vectorSync();
    toast.success('已開始同步向量庫');
    clearTimeout(vectorTimer);
    if (!unmounted) vectorTimer = setTimeout(() => void loadVector(), 3000);
  } catch (e) {
    toast.fromError(e, '無法同步向量庫');
  } finally {
    syncing.value = false;
  }
}

// 切換語意搜尋:有關鍵字就重查;取消時清掉相近度
watch(semantic, (on) => {
  if (q.value.trim()) void load(1);
  else if (!on) scores.value = new Map();
});

onMounted(() => {
  void load();
  void loadVector();
});
onBeforeUnmount(() => {
  unmounted = true;
  clearTimeout(vectorTimer);
});
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <Teleport to="#page-actions" defer>
      <GButton icon="globe" @click="learnOpen = true">外部 IP 自動學習</GButton>
      <GButton v-if="canWrite" variant="primary" icon="plus" @click="openEdit()">新增筆記</GButton>
    </Teleport>

    <div class="layout">
      <!-- 清單 -->
      <GCard padding="sm" class="list-card">
        <form class="search" @submit.prevent="load(1)">
          <GInput v-model="q" icon="search" placeholder="IP、標題、內容、標籤(空白分隔多個關鍵字)" clearable class="grow" />
          <GButton type="submit" icon="search" :loading="loading" square aria-label="查詢" />
        </form>
        <GCheckbox v-if="vector?.enabled" v-model="semantic" class="sem" label="語意搜尋(找意思相近的筆記)" />
        <p class="xs faint meta">
          共 {{ total.toLocaleString() }} 則<template v-if="pages > 1"> · 第 {{ page }} / {{ pages }} 頁</template>
          <template v-if="semantic && q.trim()"> · 依相近度排序</template>
        </p>
        <p v-if="vector?.enabled" class="xs faint meta">
          向量庫 {{ vector.points.toLocaleString() }} 筆<template v-if="vector.lastSync"> · 同步於 {{ fmtTime(vector.lastSync) }}</template>
          <template v-if="!vector.sync"> · 只搜尋、不同步(與舊版共用)</template>
          <GButton v-else-if="canWrite" size="sm" variant="ghost" icon="refresh" :loading="syncing || vector.syncing" @click="syncVector">立即同步</GButton>
        </p>
        <GAlert v-if="vector?.error" tone="warning">向量庫:{{ vector.error }}(語意搜尋可能沒有結果)</GAlert>
        <GAlert v-if="error" tone="danger">{{ describeError(error) }}</GAlert>
        <ul class="notes">
          <li v-if="compilation?.count">
            <button type="button" class="note" :class="{ active: currentId === ALL }" @click="select(ALL)">
              <span class="t"><GIcon name="file-text" :size="14" class="tone-primary ic" />匯整檔(全部 {{ compilation.count }} 則)</span>
              <span class="xs muted">AI 問答直接使用這份 · {{ compilation.chars.toLocaleString() }} 字</span>
              <span class="xs faint">更新於 {{ fmtTime(compilation.updated) }}</span>
            </button>
          </li>
          <li v-if="loading && !notes.length"><GSkeleton :lines="4" /></li>
          <li v-else-if="!notes.length" class="small faint empty">{{ q ? '沒有符合的筆記' : '還沒有筆記' }}</li>
          <li v-for="n in notes" :key="n.id">
            <button type="button" class="note" :class="{ active: n.id === currentId }" @click="select(n.id)">
              <span class="t">{{ n.title }}</span>
              <span class="xs muted ellipsis">{{ n.ips.join('、') || '一般說明' }}</span>
              <span class="xs faint">{{ fmtTime(n.updated) }} · {{ n.author }}<template v-if="scores.has(n.id)"> · 相近度 {{ scores.get(n.id)!.toFixed(2) }}</template></span>
            </button>
          </li>
        </ul>
        <div v-if="pages > 1" class="pager">
          <GButton size="sm" variant="ghost" icon="chevron-left" :disabled="page <= 1 || loading" aria-label="上一頁" @click="load(page - 1)" />
          <span class="xs muted num">{{ page }} / {{ pages }}</span>
          <GButton size="sm" variant="ghost" icon-right="chevron-right" :disabled="page >= pages || loading" aria-label="下一頁" @click="load(page + 1)" />
        </div>
      </GCard>

      <!-- 內容 -->
      <GCard class="content-card">
        <template v-if="currentId === ALL">
          <header class="head">
            <h2>匯整檔(全部筆記)</h2>
            <GButton size="sm" icon="download" :loading="downloading" @click="downloadMd(null)">下載匯整 .md</GButton>
          </header>
          <p class="xs faint">
            每次新增、修改、刪除筆記時自動重新產生,AI 問答與分析直接使用這份。{{ compilation?.count }} 則、{{ compilation?.chars.toLocaleString() }} 字,更新於
            {{ fmtTime(compilation?.updated) }}
          </p>
          <GAlert v-if="allError" tone="danger">{{ describeError(allError) }}</GAlert>
          <GSkeleton v-else-if="allLoading && !allText" :lines="8" />
          <!-- 已經過 DOMPurify(composables/markdown.ts) -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <article v-else class="md" v-html="html" />
        </template>
        <template v-else-if="current">
          <header class="head">
            <h2>{{ current.title }}</h2>
            <GButton size="sm" icon="download" :loading="downloading" @click="downloadMd(current)">下載 .md</GButton>
            <template v-if="canWrite">
              <GButton size="sm" icon="edit" @click="openEdit(current)">修改</GButton>
              <GButton size="sm" variant="danger" icon="trash" @click="remove(current)">刪除</GButton>
            </template>
          </header>
          <div v-if="current.ips.length || current.tags.length" class="chips">
            <GBadge v-for="ip in current.ips" :key="`ip-${ip}`" tone="primary" mono>{{ ip }}</GBadge>
            <GBadge v-for="t in current.tags" :key="`t-${t}`" tone="neutral">{{ t }}</GBadge>
          </div>
          <p class="xs faint">
            {{ current.author }} 記錄於 {{ fmtTime(current.created) }}
            <template v-if="current.updated !== current.created">,{{ current.updatedBy || current.author }} 修改於 {{ fmtTime(current.updated) }}</template>
          </p>
          <!-- 已經過 DOMPurify(composables/markdown.ts) -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <article class="md" v-html="html" />
          <div v-if="current.source && current.source !== current.content" class="source">
            <p class="xs faint">{{ current.tags.includes('自動學習') ? '資料來源' : '管理者原始說明' }}</p>
            <p class="small muted pre">{{ current.source }}</p>
          </div>
        </template>
        <GAlert v-else-if="singleError" tone="danger" title="無法讀取這則筆記">{{ describeError(singleError) }}</GAlert>
        <GEmpty v-else icon="book-open" title="選擇左邊的筆記查看內容" compact />
      </GCard>
    </div>

    <GModal v-model:open="dialog.open" :title="dialog.id ? '修改筆記' : '新增筆記'" icon="edit" width="760px" :persistent="dialog.saving">
      <div class="stack" style="--gap: 12px">
        <GInput v-model="dialog.title" label="標題" placeholder="例如:10.10.130.154 是防毒伺服器(空白 = 取內容第一行)" />
        <div class="grid grid-2">
          <GInput v-model="dialog.ips" label="相關 IP(逗號分隔,可寫網段)" placeholder="空白 = 一般說明" :hint="`最多 ${KB_IPS_MAX} 個`" />
          <GInput v-model="dialog.tags" label="標籤(逗號分隔)" :hint="`最多 ${KB_TAGS_MAX} 個`" />
        </div>
        <GTextarea
          v-model="dialog.content"
          label="內容(Markdown)"
          required
          :rows="14"
          :hint="`${dialog.content.length.toLocaleString()} / ${KB_CONTENT_MAX.toLocaleString()} 字`"
        />
        <p v-if="dialogError && dialog.content" class="small c-danger">{{ dialogError }}</p>
      </div>
      <template #footer>
        <GButton :disabled="dialog.saving" @click="dialog.open = false">取消</GButton>
        <GButton variant="primary" icon="save" :loading="dialog.saving" :disabled="!!dialogError" @click="save">儲存</GButton>
      </template>
    </GModal>
    <IpLearning v-model="learnOpen" :can-run="canWrite" @learned="load(page, true)" />
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.search {
  display: flex;
  gap: 8px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.sem {
  margin-top: 8px;
}
.meta {
  margin: 8px 2px;
}
.notes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
  max-height: 70vh;
  overflow-y: auto;
}
.note {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.note:hover {
  background: var(--glass-soft);
}
.note.active {
  border-color: color-mix(in srgb, var(--c-primary) 45%, transparent);
  background: color-mix(in srgb, var(--c-primary) 10%, transparent);
}
.note .t {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ic {
  margin-right: 4px;
  vertical-align: -2px;
  color: var(--c-primary);
}
.empty {
  padding: var(--space-6) 0;
  text-align: center;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding-top: 8px;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
}
.head h2 {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-lg);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.content-card p.xs {
  margin: 8px 0 0;
}
.source {
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: 1px solid var(--line);
}
.source p {
  margin: 0;
}
.pre {
  white-space: pre-wrap;
  margin-top: 4px !important;
}
/* Markdown 內容(v-html,需 :deep) */
.md {
  margin-top: var(--space-3);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.md :deep(h1),
.md :deep(h2),
.md :deep(h3) {
  margin: 1.1em 0 0.5em;
  font-size: var(--fs-lg);
}
.md :deep(p),
.md :deep(ul),
.md :deep(ol) {
  margin: 0.5em 0;
}
.md :deep(code) {
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--field);
  font-family: var(--font-mono);
  font-size: 0.92em;
}
.md :deep(pre) {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--field);
  overflow-x: auto;
}
.md :deep(pre code) {
  padding: 0;
  background: none;
}
.md :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}
.md :deep(th),
.md :deep(td) {
  padding: 6px 10px;
  border: 1px solid var(--line);
}
.md :deep(blockquote) {
  margin: 0.6em 0;
  padding: 2px 12px;
  border-left: 3px solid var(--line-strong);
  color: var(--text-2);
}
.md :deep(a) {
  color: var(--c-primary-text);
}
@media (max-width: 960px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .notes {
    max-height: 40vh;
  }
  .head h2 {
    flex-basis: 100%;
  }
}
</style>

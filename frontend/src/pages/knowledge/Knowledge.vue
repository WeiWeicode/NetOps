<script setup lang="ts">
/**
 * 網通知識 › 知識庫(docs/API.md §7;舊版 src/views/Knowledge.vue):
 *   筆記查詢(關鍵字以空白分隔、全部符合)、閱讀(Markdown 經 DOMPurify)、下載 .md、匯整檔預覽與下載;
 *   有編輯權限(UI.kbWrite)可新增、修改、刪除。?id= 記住目前筆記(__all__ = 匯整檔)。
 *   不改寫(ARCHITECTURE D17):語意搜尋、向量同步、外部 IP 自動學習、在 AI 問答請 AI 記錄 → 連到舊版。
 */
import { computed, onMounted, reactive, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { can, describeError, download } from '@/api/gateway';
import { fmtTime } from '@/api/format';
import { KB_CONTENT_MAX, KB_IPS_MAX, KB_TAGS_MAX, KB_TITLE_MAX, kb, splitList, type KbCompilation, type KbNote } from '@/api/kb';
import { UI } from '@/api/perms';
import { renderMarkdown } from '@/composables/markdown';
import { LINKS } from '@/config/links';
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

/** reloadAll:新增、修改、刪除後要重抓匯整檔 */
async function load(p = 1, reloadAll = false) {
  const my = ++seq;
  loading.value = true;
  error.value = null;
  try {
    const r = await kb.list(q.value, p, PAGE_SIZE);
    if (my !== seq) return;
    notes.value = r.items;
    total.value = r.total;
    page.value = r.page;
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

onMounted(() => void load());
</script>

<template>
  <div class="stack" style="--gap: 16px">
    <Teleport to="#page-actions" defer>
      <a :href="LINKS.knowledge" target="_blank" rel="noopener noreferrer" title="語意搜尋與外部 IP 自動學習在舊版(ARCHITECTURE D17)">
        <GButton icon="sparkles" icon-right="external">語意搜尋 / 自動學習(舊版)</GButton>
      </a>
      <a :href="LINKS.paAsk" target="_blank" rel="noopener noreferrer"><GButton icon="message" icon-right="external">到 AI 問答記錄(舊版)</GButton></a>
      <GButton v-if="canWrite" variant="primary" icon="plus" @click="openEdit()">新增筆記</GButton>
    </Teleport>

    <div class="layout">
      <!-- 清單 -->
      <GCard padding="sm" class="list-card">
        <form class="search" @submit.prevent="load(1)">
          <GInput v-model="q" icon="search" placeholder="IP、標題、內容、標籤(空白分隔多個關鍵字)" clearable class="grow" />
          <GButton type="submit" icon="search" :loading="loading" square aria-label="查詢" />
        </form>
        <p class="xs faint meta">
          共 {{ total.toLocaleString() }} 則<template v-if="pages > 1"> · 第 {{ page }} / {{ pages }} 頁</template>
        </p>
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
              <span class="xs faint">{{ fmtTime(n.updated) }} · {{ n.author }}</span>
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

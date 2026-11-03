<script setup lang="ts" generic="T extends Record<string, any>">
/**
 * 資料表:columns 定義欄位;自訂儲存格用 #cell-{key}="{ row }";
 * 前端排序(column.sortable)與分頁(pageSize,0 = 不分頁);server 分頁時傳 total + v-model:page。
 * server 分頁時只拿到一頁資料,前端排序只會排這一頁、容易誤導,因此 sortable 會被忽略(需要排序請由 API 提供)。
 */
import { computed, ref, watch } from 'vue';

export interface Column {
  key: string;
  label: string;
  width?: string;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
  mono?: boolean;
  hideSm?: boolean;
}

const props = withDefaults(
  defineProps<{
    columns: Column[];
    rows: T[];
    rowKey: string;
    loading?: boolean;
    pageSize?: number;
    total?: number;
    emptyTitle?: string;
    emptyDescription?: string;
    clickable?: boolean;
    dense?: boolean;
  }>(),
  { pageSize: 10, emptyTitle: '沒有資料' },
);
const emit = defineEmits<{ 'row-click': [T] }>();
const page = defineModel<number>('page', { default: 1 });

const sortKey = ref<string | null>(null);
const sortDir = ref<1 | -1>(1);
const serverPaged = computed(() => props.total !== undefined);
const canSort = (c: Column) => !!c.sortable && !serverPaged.value;
function toggleSort(c: Column) {
  if (!canSort(c)) return;
  if (sortKey.value === c.key) sortDir.value = sortDir.value === 1 ? -1 : 1;
  else {
    sortKey.value = c.key;
    sortDir.value = 1;
  }
}

const sorted = computed(() => {
  if (!sortKey.value) return props.rows;
  const k = sortKey.value;
  return [...props.rows].sort((a, b) => {
    const x = a[k];
    const y = b[k];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-Hant')) * sortDir.value;
  });
});
const totalRows = computed(() => props.total ?? props.rows.length);
const pages = computed(() => (props.pageSize ? Math.max(1, Math.ceil(totalRows.value / props.pageSize)) : 1));
const visible = computed(() => {
  if (serverPaged.value || !props.pageSize) return sorted.value;
  const start = (page.value - 1) * props.pageSize;
  return sorted.value.slice(start, start + props.pageSize);
});
watch(
  () => props.rows,
  () => {
    if (!serverPaged.value) page.value = 1;
  },
);
</script>

<template>
  <div class="g-table" :class="{ dense }">
    <div class="scroller">
      <table>
        <thead>
          <tr>
            <th
              v-for="c in columns"
              :key="c.key"
              :style="{ width: c.width, textAlign: c.align ?? 'left' }"
              :class="{ sortable: canSort(c), 'hide-sm': c.hideSm }"
              :aria-sort="sortKey === c.key ? (sortDir === 1 ? 'ascending' : 'descending') : undefined"
              @click="toggleSort(c)"
            >
              {{ c.label }}
              <GIcon
                v-if="c.sortable"
                :name="sortKey === c.key && sortDir === -1 ? 'trend-down' : 'trend-up'"
                :size="12"
                class="sort-ic"
                :class="{ on: sortKey === c.key }"
              />
            </th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="i in 5" :key="i">
            <td :colspan="columns.length"><GSkeleton :lines="1" /></td>
          </tr>
        </tbody>
        <tbody v-else-if="visible.length">
          <tr v-for="row in visible" :key="row[rowKey]" :class="{ clickable }" @click="clickable && emit('row-click', row)">
            <td v-for="c in columns" :key="c.key" :style="{ textAlign: c.align ?? 'left' }" :class="{ mono: c.mono, 'hide-sm': c.hideSm }">
              <slot :name="`cell-${c.key}`" :row="row" :value="row[c.key]">{{ row[c.key] ?? '—' }}</slot>
            </td>
          </tr>
        </tbody>
      </table>
      <GEmpty v-if="!loading && !visible.length" compact :title="emptyTitle" :description="emptyDescription" />
    </div>
    <footer v-if="pageSize && totalRows > pageSize" class="pager">
      <span class="faint small num">共 {{ totalRows }} 筆 · 第 {{ page }} / {{ pages }} 頁</span>
      <div class="spacer" />
      <GButton size="sm" variant="ghost" icon="chevron-left" :disabled="page <= 1" aria-label="上一頁" @click="page--" />
      <GButton size="sm" variant="ghost" icon-right="chevron-right" :disabled="page >= pages" aria-label="下一頁" @click="page++" />
    </footer>
  </div>
</template>

<style scoped>
.g-table {
  min-width: 0;
}
.scroller {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--fs-md);
}
th {
  position: sticky;
  top: 0;
  padding: 10px 14px;
  font-size: var(--fs-xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
  white-space: nowrap;
  border-bottom: 1px solid var(--line);
  user-select: none;
}
th.sortable {
  cursor: pointer;
}
th.sortable:hover {
  color: var(--text-2);
}
.sort-ic {
  opacity: 0.3;
  margin-left: 2px;
}
.sort-ic.on {
  opacity: 1;
  color: var(--c-primary);
}
td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  vertical-align: middle;
}
.dense td {
  padding: 8px 12px;
}
.dense th {
  padding: 8px 12px;
}
tbody tr {
  transition: background var(--dur);
}
tbody tr:hover {
  background: var(--glass-soft);
}
tbody tr:last-child td {
  border-bottom: 0;
}
tr.clickable {
  cursor: pointer;
}
.pager {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
}
@media (max-width: 760px) {
  .hide-sm {
    display: none;
  }
}
</style>

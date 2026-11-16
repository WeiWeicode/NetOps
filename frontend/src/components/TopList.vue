<script setup lang="ts">
/**
 * 排行清單(安全事件、流量總覽共用;舊版 src/components/TopList.vue):橫條長度 = 次數(或流量),
 * 可點選的項目送出 pick(頁面決定帶到明細查詢或 AI 問答);不可點的只顯示。
 * items: [{ key, n, bytes?, sub? }];byBytes 依流量顯示;sub 顯示在名稱後面的補充;#extra 放在標題右側(例如次數 / 流量切換)。
 * tone:primary / warning / danger(舊版 brand / warn / danger)。
 */
import { computed } from 'vue';
import { fmtNum, fmtSize } from '@/api/format';
import { ipNameOf, ipNameText, ipNameTitle } from '@/composables/ipNames';

export interface TopItem {
  key: string;
  n: number;
  bytes?: number;
  sub?: string;
}

const props = withDefaults(
  defineProps<{
    title: string;
    items: TopItem[];
    byBytes?: boolean;
    showBytes?: boolean;
    tone?: 'primary' | 'danger' | 'warning';
    hint?: string;
    /** 可點選的項目(預設全部);回 false 的只顯示 */
    pickable?: (key: string) => boolean;
    /** 點選說明(滑鼠提示) */
    pickHint?: string;
  }>(),
  { tone: 'primary', hint: '', pickHint: '點選查看明細' },
);
const emit = defineEmits<{ pick: [string] }>();

const max = computed(() => Math.max(1, ...props.items.map((x) => (props.byBytes ? (x.bytes ?? 0) : x.n))));
const canPick = (key: string) => !props.pickable || props.pickable(key);
const value = (x: TopItem) => (props.byBytes ? (x.bytes ?? 0) : x.n);
/** IP 項目在 IP 對照表的名稱(AC3;key 不是 IP 或沒有對照時空白) */
const nameOf = (key: string) => {
  const l = ipNameOf(key);
  return l ? { text: ipNameText(l), title: ipNameTitle(l) } : null;
};
const label = (x: TopItem) => {
  const n = nameOf(x.key);
  return `${x.key}${n ? `(${n.title})` : ''}:${fmtNum(x.n)} 次${x.bytes ? `,${fmtSize(x.bytes)}` : ''}`;
};
</script>

<template>
  <GCard :title="title" :subtitle="hint || undefined" :tone="tone" padding="sm">
    <template v-if="$slots.extra" #actions><slot name="extra" /></template>
    <p v-if="!items.length" class="small muted empty">沒有資料</p>
    <ol v-else class="top" :class="`tone-${tone}`">
      <li v-for="(x, i) in items" :key="x.key">
        <component
          :is="canPick(x.key) ? 'button' : 'div'"
          :type="canPick(x.key) ? 'button' : undefined"
          class="item"
          :class="{ pick: canPick(x.key) }"
          :title="canPick(x.key) ? `${label(x)}(${pickHint})` : label(x)"
          :aria-label="canPick(x.key) ? `${label(x)},${pickHint}` : undefined"
          @click="canPick(x.key) && emit('pick', x.key)"
        >
          <span class="rank num">{{ i + 1 }}</span>
          <span class="lbl">
            <span class="bar" :style="{ width: `${(value(x) / max) * 100}%` }" />
            <span class="text"
              >{{ x.key }}<span v-if="nameOf(x.key)?.text" class="who" aria-hidden="true">{{ nameOf(x.key)!.text }}</span><small v-if="x.sub" class="faint">{{ x.sub }}</small></span
            >
          </span>
          <span class="val num">{{ byBytes ? fmtSize(x.bytes) : fmtNum(x.n) }}</span>
          <span v-if="showBytes && !byBytes" class="val num faint">{{ fmtSize(x.bytes) }}</span>
        </component>
      </li>
    </ol>
  </GCard>
</template>

<style scoped>
.who {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 5px;
  background: var(--grad-brand-soft);
  color: var(--c-primary-text);
  font-size: var(--fs-xs, 11px);
}
.empty {
  margin: 0;
  padding: var(--space-5) 0;
  text-align: center;
}
.top {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 2px;
  font-size: var(--fs-sm);
}
.top li {
  min-width: 0;
}
.item {
  display: flex;
  min-width: 0;
  overflow: hidden;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
}
.item.pick {
  cursor: pointer;
}
.item.pick:hover,
.item.pick:focus-visible {
  background: var(--glass-soft);
}
.rank {
  width: 1.6em;
  flex: none;
  color: var(--text-3);
  text-align: right;
}
.lbl {
  position: relative;
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
}
.bar {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--tone) 18%, transparent);
}
.text {
  position: relative;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.text small {
  margin-left: 6px;
}
.val {
  flex: none;
  min-width: 4.5em;
  text-align: right;
  color: var(--text-2);
}
</style>

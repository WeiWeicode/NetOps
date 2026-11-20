<script setup lang="ts">
/**
 * 戰情室新威脅特徵碼命中提示列(TS-4;docs/THREAT-SIGNATURE-PLAN.md §5.4):
 *   - 當戰情室(WR-1 / WR-2)回傳 newSignatureHits 時顯示於戰情室上方
 *   - 顯示特徵 ID、名稱、嚴重度、首次出現版本與命中筆數(不含 IP)
 *   - 若有檢視權限(sigLinkable),點選特徵膠囊開啟特徵碼說明抽屜
 */
import { RouterLink } from 'vue-router';
import { fmtNum } from '@/api/format';
import type { NewSignatureHit } from '@/api/warroom';

defineProps<{
  hits: readonly NewSignatureHit[];
  canOpenSignaturePage?: boolean;
  sigLinkable?: (nameOrId: string) => boolean;
}>();

const emit = defineEmits<{
  (e: 'open-signature', id: string): void;
}>();

function sevTone(sev: string): 'danger' | 'warning' | 'info' {
  const s = sev.toLowerCase();
  if (s === 'critical') return 'danger';
  if (s === 'high') return 'warning';
  return 'info';
}
</script>

<template>
  <div v-if="hits.length" class="wr-newsig" role="alert" aria-label="新威脅特徵碼命中提示">
    <span class="wr-newsig__label">
      <span class="wr-newsig__dot" aria-hidden="true" />
      <span>偵測到近 30 天新增威脅特徵碼命中（{{ hits.length }} 項）：</span>
    </span>

    <div class="wr-newsig__chips">
      <component
        :is="sigLinkable?.(h.id) ? 'button' : 'span'"
        v-for="h in hits"
        :key="h.id"
        :type="sigLinkable?.(h.id) ? 'button' : undefined"
        class="wr-newsig__chip"
        :class="[`is-${sevTone(h.severity)}`, { clickable: sigLinkable?.(h.id) }]"
        :title="`#${h.id} ${h.name}（${h.severity}，首次版本 ${h.firstVersion || '未知'}，命中 ${fmtNum(h.count)} 筆）`"
        @click="sigLinkable?.(h.id) && emit('open-signature', h.id)"
      >
        <strong class="mono">#{{ h.id }}</strong>
        <span class="wr-newsig__name">{{ h.name }}</span>
        <span class="wr-newsig__cnt mono">{{ fmtNum(h.count) }} 筆</span>
      </component>
    </div>

    <RouterLink v-if="canOpenSignaturePage" to="/firewall/signatures" class="wr-newsig__more">
      前往威脅特徵碼 →
    </RouterLink>
  </div>
</template>

<style scoped>
.wr-newsig {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  padding: 6px 14px;
  background: rgba(54, 18, 28, 0.88);
  border-bottom: 1px solid rgba(255, 77, 94, 0.45);
  font-size: 11px;
  color: #ffd6db;
  z-index: 12;
}
.wr-newsig__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  white-space: nowrap;
}
.wr-newsig__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ff4d5e;
  box-shadow: 0 0 8px #ff4d5e;
  flex: none;
}
.wr-newsig__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.wr-newsig__chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 77, 94, 0.5);
  background: rgba(255, 77, 94, 0.14);
  color: #ffe3e6;
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
}
.wr-newsig__chip.is-warning {
  border-color: rgba(245, 176, 58, 0.55);
  background: rgba(245, 176, 58, 0.14);
  color: #ffe5b4;
}
.wr-newsig__chip.is-info {
  border-color: rgba(62, 168, 255, 0.5);
  background: rgba(62, 168, 255, 0.14);
  color: #cfe8ff;
}
.wr-newsig__chip.clickable {
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease;
}
.wr-newsig__chip.clickable:hover {
  border-color: #ffffff;
  transform: translateY(-1px);
}
.wr-newsig__name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wr-newsig__cnt {
  opacity: 0.9;
}
.wr-newsig__more {
  margin-left: auto;
  color: #8fc3ff;
  text-decoration: none;
  white-space: nowrap;
  font-weight: 600;
}
.wr-newsig__more:hover {
  text-decoration: underline;
}
</style>

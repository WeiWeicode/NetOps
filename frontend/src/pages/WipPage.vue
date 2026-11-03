<script setup lang="ts">
/**
 * 改寫中頁面的共用佔位頁(由 GigaItApp pages/WipFeature.vue 複製;IMPL-PLAN F1):說明這頁要做什麼。
 * 權限與選單已依 ARCHITECTURE §5 生效;F1 逐頁改寫時換成正式頁面。內容由路由 props 傳入。
 * 擁有 netops.ping.read 時附上連線驗證(PingCard)。
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { can } from '@/api/gateway';
import { API } from '@/api/perms';
import PingCard from '@/components/PingCard.vue';

const props = defineProps<{
  /** 這個功能要做什麼 */
  summary: string;
  /** 預計內容 / 分批 */
  plan?: string[];
  /** 對應的設計文件或路線圖(repo 與路徑、章節) */
  docs?: string[];
}>();

const route = useRoute();
const title = computed(() => route.matched[1]?.meta.title ?? '此功能');
</script>

<template>
  <div class="wip stack">
    <GCard :title="`${title}(改寫中)`" icon="construction" tone="warning">
      <div class="stack body">
        <div class="row">
          <GBadge tone="warning" icon="construction">改寫中</GBadge>
          <span class="hint">新版畫面尚未完成;切換前請繼續使用舊版</span>
        </div>
        <p class="summary">{{ props.summary }}</p>
        <section v-if="props.plan?.length" class="stack sec">
          <h4>預計內容</h4>
          <ul>
            <li v-for="p in props.plan" :key="p">{{ p }}</li>
          </ul>
        </section>
        <section v-if="props.docs?.length" class="stack sec">
          <h4>設計文件 / 路線圖</h4>
          <ul class="docs">
            <li v-for="d in props.docs" :key="d"><GIcon name="file" :size="14" /> {{ d }}</li>
          </ul>
        </section>
      </div>
    </GCard>
    <PingCard v-if="can(API.ping)" />
  </div>
</template>

<style scoped>
.body {
  --gap: 14px;
}
.sec {
  --gap: 6px;
}
.hint {
  color: var(--text-3);
  font-size: var(--fs-sm);
}
.summary {
  margin: 0;
  color: var(--text);
  line-height: 1.7;
}
h4 {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
ul {
  margin: 0;
  padding-left: 20px;
  color: var(--text-2);
  line-height: 1.8;
}
.docs {
  list-style: none;
  padding-left: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  overflow-wrap: anywhere;
}
.docs li {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
</style>

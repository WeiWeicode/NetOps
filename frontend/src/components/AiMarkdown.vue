<script setup lang="ts">
/** AI 回答(Markdown)→ HTML:一律經 DOMPurify(composables/markdown.ts;AGENT.md §7.4) */
import { computed } from 'vue';
import { renderMarkdown } from '@/composables/markdown';

const props = defineProps<{ text: string }>();
const html = computed(() => renderMarkdown(props.text));
</script>

<template>
  <!-- 已經過 DOMPurify -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <article class="ai-md" v-html="html" />
</template>

<style scoped>
.ai-md {
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.ai-md :deep(h1),
.ai-md :deep(h2) {
  margin: 1em 0 0.4em;
  padding-bottom: 0.2em;
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-lg);
}
.ai-md :deep(h1:first-child),
.ai-md :deep(h2:first-child) {
  margin-top: 0;
}
.ai-md :deep(h3) {
  margin: 0.8em 0 0.3em;
  font-size: var(--fs-md, 1rem);
}
.ai-md :deep(p),
.ai-md :deep(ul),
.ai-md :deep(ol) {
  margin: 0.4em 0;
}
.ai-md :deep(ul),
.ai-md :deep(ol) {
  padding-left: 1.4em;
}
.ai-md :deep(code) {
  font-family: var(--font-mono, monospace);
  font-size: 0.85em;
  padding: 0.1em 0.35em;
  border-radius: 4px;
  background: var(--glass-soft);
}
.ai-md :deep(table) {
  border-collapse: collapse;
  margin: 0.5em 0;
  display: block;
  overflow-x: auto;
}
.ai-md :deep(th),
.ai-md :deep(td) {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
}
</style>

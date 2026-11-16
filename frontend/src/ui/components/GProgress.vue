<script setup lang="ts">
/** 進度條:value / max,可選多段(segments 依序堆疊) */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{ value?: number; max?: number; tone?: string; segments?: { value: number; tone: string; label?: string }[]; height?: number }>(),
  {
    value: 0,
    max: 100,
    tone: 'primary',
    height: 8,
  },
);
const segs = computed(() => props.segments ?? [{ value: props.value, tone: props.tone }]);
const total = computed(
  () =>
    (props.segments
      ? Math.max(
          props.max,
          props.segments.reduce((s, x) => s + x.value, 0),
        )
      : props.max) || 1,
);
</script>

<template>
  <div class="g-progress" :style="{ height: `${height}px` }" role="progressbar" :aria-valuenow="value" :aria-valuemax="max">
    <span v-for="(s, i) in segs" :key="i" class="seg" :class="`tone-${s.tone}`" :style="{ width: `${(s.value / total) * 100}%` }" :title="s.label" />
  </div>
</template>

<style scoped>
.g-progress {
  display: flex;
  gap: 2px;
  width: 100%;
  overflow: hidden;
  border-radius: 99px;
  background: var(--line);
}
.seg {
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, color-mix(in srgb, var(--tone) 70%, white), var(--tone));
  box-shadow: 0 0 12px color-mix(in srgb, var(--tone) 50%, transparent);
  transition: width 600ms var(--ease);
}
</style>

<script setup lang="ts">
import { computed } from 'vue';
import { ICONS, type IconDef, type IconName } from '../icons';

const props = withDefaults(defineProps<{ name: IconName; size?: number; stroke?: number }>(), {
  size: 18,
  stroke: 2,
});

const icon = computed<IconDef>(() => ICONS[props.name]);
</script>

<template>
  <svg
    :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    :stroke-width="stroke" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"
  >
    <path v-for="(d, i) in icon.paths ?? []" :key="`p${i}`" :d="d" />
    <circle v-for="(c, i) in icon.circles ?? []" :key="`c${i}`" :cx="c[0]" :cy="c[1]" :r="c[2]" />
    <rect v-for="(r, i) in icon.rects ?? []" :key="`r${i}`" :x="r[0]" :y="r[1]" :width="r[2]" :height="r[3]" :rx="r[4]" />
  </svg>
</template>

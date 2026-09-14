<script setup lang="ts">
withDefaults(defineProps<{ rows?: number }>(), { rows: 3 });
const WIDTHS = ['34%', '22%', '16%', '12%'];
</script>

<template>
  <div class="skeleton-rows" role="status" aria-label="加载中">
    <div v-for="row in rows" :key="row" class="skeleton-row">
      <span v-for="(width, i) in WIDTHS" :key="i" class="skeleton" :style="{ width }"></span>
    </div>
  </div>
</template>

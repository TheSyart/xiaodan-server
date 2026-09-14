<script setup lang="ts">
import PixelMascot from './PixelMascot.vue';

defineProps<{ title: string; description?: string }>();
</script>

<template>
  <div class="empty">
    <span class="mascot-tile" style="width: 52px; height: 52px"><PixelMascot :size="36" /></span>
    <div class="empty-title">{{ title }}</div>
    <p v-if="description">{{ description }}</p>
    <div v-if="$slots.default" class="empty-actions"><slot /></div>
  </div>
</template>

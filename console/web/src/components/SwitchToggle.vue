<script setup lang="ts">
defineProps<{ modelValue: boolean; label?: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
</script>

<template>
  <label class="switch" :class="{ disabled }">
    <input
      type="checkbox" role="switch" :checked="modelValue" :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="switch-track" aria-hidden="true"></span>
    <span v-if="label">{{ label }}</span>
    <slot />
  </label>
</template>

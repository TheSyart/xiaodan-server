<script setup lang="ts">
// 六格绑定码输入。只有一个真实的 input,透明地盖在六个格子上:
// 粘贴一整串、手机数字键盘、输入法与读屏都照常工作,格子只负责显示。
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{ modelValue: string; length?: number; invalid?: boolean; disabled?: boolean; label?: string }>(),
  { length: 6, invalid: false, disabled: false, label: '绑定码' },
);
const emit = defineEmits<{ 'update:modelValue': [value: string]; complete: [value: string] }>();

const input = ref<HTMLInputElement | null>(null);
const focused = ref(false);

const digits = computed(() => Array.from({ length: props.length }, (_, i) => props.modelValue[i] ?? ''));
const current = computed(() => Math.min(props.modelValue.length, props.length - 1));

function onInput(event: Event) {
  const target = event.target as HTMLInputElement;
  const value = target.value.replace(/\D/gu, '').slice(0, props.length);
  if (target.value !== value) target.value = value;
  emit('update:modelValue', value);
  if (value.length === props.length) emit('complete', value);
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="code-input" :class="{ focused, invalid, disabled }" @click="input?.focus()">
    <input
      ref="input" :value="modelValue" type="text" inputmode="numeric" autocomplete="one-time-code"
      :maxlength="length" :disabled="disabled" :aria-label="label" :aria-invalid="invalid"
      @input="onInput" @focus="focused = true" @blur="focused = false"
    />
    <span
      v-for="(digit, i) in digits" :key="i" class="code-cell" aria-hidden="true"
      :class="{ filled: digit !== '', current: i === current, caret: focused && digit === '' && i === modelValue.length }"
    >{{ digit }}</span>
  </div>
</template>

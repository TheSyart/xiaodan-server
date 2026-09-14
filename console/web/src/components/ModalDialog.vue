<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';

const props = withDefaults(defineProps<{ open: boolean; title: string; wide?: boolean }>(), { wide: false });
const emit = defineEmits<{ close: [] }>();

const dialog = ref<HTMLElement | null>(null);
let restoreFocus: HTMLElement | null = null;
let listening = false;

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}

function release() {
  if (!listening) return;
  listening = false;
  document.removeEventListener('keydown', onKeydown);
  document.body.classList.remove('modal-open');
  restoreFocus?.focus?.();
  restoreFocus = null;
}

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      release();
      return;
    }
    restoreFocus = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', onKeydown);
    document.body.classList.add('modal-open');
    listening = true;
    await nextTick();
    dialog.value?.querySelector<HTMLElement>('[autofocus], input:not([disabled]), select, textarea')?.focus();
  },
  { immediate: true },
);

onBeforeUnmount(release);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @mousedown.self="emit('close')">
      <div ref="dialog" class="modal" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
        <div class="modal-head">
          <h2>{{ title }}</h2>
          <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label="关闭" @click="emit('close')">
            <AppIcon name="x" :size="16" />
          </button>
        </div>
        <div class="modal-body"><slot /></div>
        <div v-if="$slots.footer" class="modal-foot"><slot name="footer" /></div>
      </div>
    </div>
  </Teleport>
</template>

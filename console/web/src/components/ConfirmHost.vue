<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';
import { closeDialog, dialogState } from '../ui';

const input = ref<HTMLInputElement | null>(null);
const confirmButton = ref<HTMLButtonElement | null>(null);
let restoreFocus: HTMLElement | null = null;

watch(
  () => dialogState.open,
  async (open) => {
    if (!open) {
      restoreFocus?.focus?.();
      restoreFocus = null;
      return;
    }
    restoreFocus = document.activeElement as HTMLElement | null;
    await nextTick();
    if (dialogState.input) {
      input.value?.focus();
      input.value?.select();
    } else {
      // 危险操作默认聚焦"取消"那一侧更稳妥,但确认框本身已足够醒目;聚焦确认键方便键盘操作
      confirmButton.value?.focus();
    }
  },
);

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeDialog(false);
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="dialogState.open" class="modal-backdrop top" @mousedown.self="closeDialog(false)" @keydown="onKeydown">
      <form
        class="modal" role="alertdialog" aria-modal="true" :aria-label="dialogState.title"
        @submit.prevent="closeDialog(true)"
      >
        <div class="confirm-body">
          <div class="confirm-icon" :class="dialogState.danger ? 'danger' : 'info'">
            <AppIcon :name="dialogState.danger ? 'alert' : 'info'" :size="20" />
          </div>
          <div class="confirm-text">
            <h2>{{ dialogState.title }}</h2>
            <p v-if="dialogState.message">{{ dialogState.message }}</p>
            <label v-if="dialogState.input" class="field">
              <span class="field-label">{{ dialogState.input.label }}</span>
              <input
                ref="input" v-model="dialogState.value" class="input" type="text"
                :placeholder="dialogState.input.placeholder" :maxlength="dialogState.input.maxlength ?? 200"
              />
            </label>
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" @click="closeDialog(false)">{{ dialogState.cancelText }}</button>
          <button
            ref="confirmButton" type="submit" class="btn"
            :class="dialogState.danger ? 'btn-danger-solid' : 'btn-primary'"
          >{{ dialogState.confirmText }}</button>
        </div>
      </form>
    </div>
  </Teleport>
</template>

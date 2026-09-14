<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import { dismissToast, toasts, type ToastKind } from '../ui';
import type { IconName } from '../icons';

const ICON: Record<ToastKind, IconName> = { success: 'check', error: 'alert', info: 'info', warn: 'alert' };
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="item in toasts" :key="item.id" class="toast" :class="item.kind" role="status">
        <span class="toast-icon"><AppIcon :name="ICON[item.kind]" :size="14" :stroke="2.6" /></span>
        <span class="toast-msg">{{ item.message }}</span>
        <button type="button" class="toast-close" aria-label="关闭提示" @click="dismissToast(item.id)">
          <AppIcon name="x" :size="14" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import AppIcon from '../AppIcon.vue';
import EmptyState from '../EmptyState.vue';
import PageHeader from '../PageHeader.vue';
import SkeletonRows from '../SkeletonRows.vue';
import { signed, useCreditChild } from '../../credits/useCreditChild';

// 学分各子页的页头:标题、孩子选择器、余额、待确认的申报提醒。
// 没有设备时整页只显示「去绑定设备」,子页内容靠默认插槽,只有选中了孩子才渲染。

defineProps<{ title: string; description: string }>();

const { children, mac, child, loaded, loadError, refresh } = useCreditChild();
onMounted(refresh);
</script>

<template>
  <PageHeader :title="title" :description="description">
    <template #actions>
      <slot name="actions" />
      <select v-if="children.length > 1" v-model="mac" class="select" style="height: 32px; width: auto" aria-label="选择孩子">
        <option v-for="item in children" :key="item.mac" :value="item.mac">{{ item.alias || item.mac }}</option>
      </select>
    </template>
  </PageHeader>

  <div v-if="loadError" class="callout danger" role="alert">
    <AppIcon name="alert" :size="18" /><div class="callout-body"><strong>加载失败。</strong>{{ loadError }}</div>
  </div>

  <div v-if="!loaded" class="card"><SkeletonRows :rows="3" /></div>

  <section v-else-if="!child" class="card">
    <EmptyState title="还没有绑定设备" description="学分按设备记账,一台设备就是一个孩子。先绑定一台设备。">
      <RouterLink class="btn btn-primary" to="/devices"><AppIcon name="device" :size="16" /><span>去绑定设备</span></RouterLink>
    </EmptyState>
  </section>

  <template v-else>
    <div class="credit-bar">
      <div class="balance">
        <AppIcon name="medal" :size="20" />
        <span class="balance-value" :class="{ negative: child.balance < 0 }">{{ child.balance }}</span>
        <span class="muted">分 · {{ child.alias || child.mac }}</span>
      </div>
      <span class="muted">今天完成 {{ child.today.done }} / {{ child.today.total }},得分 {{ signed(child.today.points) || 0 }}</span>
      <RouterLink v-if="child.pending_claims" class="tag warn dot claim-link" to="/credits/tasks">
        {{ child.pending_claims }} 项作业孩子说做完了,等你检查
      </RouterLink>
    </div>
    <slot />
  </template>
</template>

<style scoped>
.credit-bar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 0 0 14px; }
.balance { display: flex; align-items: baseline; gap: 8px; }
.balance :deep(svg) { align-self: center; color: var(--sun); }
.balance-value { font-size: 28px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
.negative { color: var(--red); }
.claim-link { text-decoration: none; }
</style>

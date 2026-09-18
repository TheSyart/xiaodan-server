<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '../api';
import AppIcon from './AppIcon.vue';
import EmptyState from './EmptyState.vue';
import PixelMascot from './PixelMascot.vue';
import SkeletonRows from './SkeletonRows.vue';
import { formatTime, parseDbTime } from '../ui';

// 一段对话的逐轮原文。记忆页的对话详情用它;工具调用折成一行灰字。

const props = defineProps<{ messages: ChatMessage[]; loading?: boolean }>();

/** 工具调用记录是 JSON:[{"type":"tool","text":"get_weather({...})"}] 或 tool_result。 */
function toolText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          const entry = item as { type?: string; text?: string };
          return entry.type === 'tool_result' ? `返回 ${entry.text ?? ''}` : `调用 ${entry.text ?? ''}`;
        })
        .join(' · ');
    }
  } catch {
    /* 不是 JSON 就原样显示 */
  }
  return content;
}

interface Line {
  id: number;
  kind: 'user' | 'bot' | 'tool';
  text: string;
  time: string;
}
const lines = computed<Line[]>(() =>
  props.messages.map((m) => ({
    id: m.id,
    kind: m.chat_type === 1 ? 'user' : m.chat_type === 2 ? 'bot' : 'tool',
    text: m.chat_type === 3 ? toolText(m.content) : m.content,
    time: m.created_at,
  })),
);
const clock = (value: string) =>
  parseDbTime(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
</script>

<template>
  <SkeletonRows v-if="loading" :rows="4" />
  <EmptyState v-else-if="lines.length === 0" title="这段对话没有内容" />
  <div v-else class="chat">
    <template v-for="line in lines" :key="line.id">
      <div v-if="line.kind === 'tool'" class="tool-line" :title="line.text">
        <AppIcon name="zap" :size="13" /><span>{{ line.text }}</span>
      </div>
      <div v-else class="bubble-row" :class="line.kind">
        <span v-if="line.kind === 'user'" class="avatar tone-sky"><AppIcon name="user" :size="16" /></span>
        <span v-else class="mascot-tile" style="width: 32px; height: 32px; border-radius: 9px; box-shadow: none; border-width: 1.5px">
          <PixelMascot :size="22" :blink="false" />
        </span>
        <div class="bubble-col">
          <div class="bubble">{{ line.text }}</div>
          <span class="bubble-time" :title="formatTime(line.time)">{{ line.kind === 'user' ? '用户' : '小单' }} · {{ clock(line.time) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

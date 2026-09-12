<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, type ChatMessage, type ChatSession } from '../api';

const sessions = ref<ChatSession[]>([]);
const messages = ref<ChatMessage[]>([]);
const current = ref<ChatSession | null>(null);
const error = ref('');

async function load() {
  try {
    sessions.value = (await api.get<{ items: ChatSession[] }>('/chats')).items;
  } catch (e) { error.value = (e as Error).message; }
}
onMounted(load);

async function open(session: ChatSession) {
  current.value = session;
  try {
    messages.value = (await api.get<{ items: ChatMessage[] }>(`/chats/${encodeURIComponent(session.session_id)}`)).items;
  } catch (e) { error.value = (e as Error).message; }
}

async function remove(session: ChatSession) {
  if (!confirm('删除这段对话记录?')) return;
  try {
    await api.del(`/chats/${encodeURIComponent(session.session_id)}`);
    if (current.value?.session_id === session.session_id) current.value = null;
    await load();
  } catch (e) { error.value = (e as Error).message; }
}

const when = (iso: string) => new Date(`${iso.replace(' ', 'T')}Z`).toLocaleString('zh-CN');
const who = (type: number) => (type === 1 ? '用户' : type === 2 ? '小单' : '工具');
</script>

<template>
  <div class="page-head">
    <h1>对话记录</h1>
    <p>只保存文字。音频不落盘,避免数据目录无限增长。</p>
  </div>

  <div v-if="error" class="notice error">{{ error }}</div>

  <div v-if="current" class="card">
    <h2>
      {{ current.mac }} · {{ when(current.started_at) }}
      <button class="link" style="float: right" @click="current = null">返回列表</button>
    </h2>
    <div v-for="message in messages" :key="message.id" class="chat-line" :class="{ user: message.chat_type === 1 }">
      <div class="who">{{ who(message.chat_type) }} · {{ when(message.created_at) }}</div>
      <div>{{ message.content }}</div>
    </div>
  </div>

  <div v-else class="card">
    <div v-if="sessions.length === 0" class="empty">
      还没有对话记录。设备聊过之后这里会自动出现,前提是智能体的「对话记录」没有设成不记录。
    </div>
    <table v-else>
      <thead>
        <tr><th>设备</th><th>消息数</th><th>开始</th><th>结束</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="session in sessions" :key="session.session_id">
          <td><span class="code">{{ session.mac }}</span></td>
          <td>{{ session.messages }}</td>
          <td>{{ when(session.started_at) }}</td>
          <td>{{ when(session.ended_at) }}</td>
          <td class="actions">
            <button class="link" @click="open(session)">查看</button>
            <button class="link danger" @click="remove(session)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

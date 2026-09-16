import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { applyTheme, storedTheme } from './ui';
import './styles.css';

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
  }
}

// 挂载前先套上用户选过的主题,免得深色模式下先闪一下浅色
applyTheme(storedTheme());

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/devices' },
    { path: '/login', component: () => import('./views/Login.vue'), meta: { title: '登录' } },
    { path: '/devices', component: () => import('./views/Devices.vue'), meta: { title: '设备' } },
    { path: '/agents', component: () => import('./views/Agents.vue'), meta: { title: '智能体' } },
    { path: '/voices', component: () => import('./views/Voices.vue'), meta: { title: '音色' } },
    { path: '/playground', component: () => import('./views/Playground.vue'), meta: { title: '试聊' } },
    { path: '/services', component: () => import('./views/Services.vue'), meta: { title: '工具与服务' } },
    { path: '/mcp', component: () => import('./views/Mcp.vue'), meta: { title: 'MCP' } },
    { path: '/skills', component: () => import('./views/Skills.vue'), meta: { title: '技能' } },
    { path: '/reminders', component: () => import('./views/Reminders.vue'), meta: { title: '提醒' } },
    { path: '/content', component: () => import('./views/Content.vue'), meta: { title: '内容库' } },
    { path: '/gallery', component: () => import('./views/Gallery.vue'), meta: { title: '画廊' } },
    { path: '/models', component: () => import('./views/Models.vue'), meta: { title: '模型' } },
    { path: '/chats', component: () => import('./views/Chats.vue'), meta: { title: '对话记录' } },
    { path: '/words', component: () => import('./views/Words.vue'), meta: { title: '读音替换' } },
    { path: '/settings', component: () => import('./views/Settings.vue'), meta: { title: '设置' } },
    { path: '/:rest(.*)', redirect: '/devices' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · 小单控制台` : '小单控制台';
});

createApp(App).use(router).mount('#app');

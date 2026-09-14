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

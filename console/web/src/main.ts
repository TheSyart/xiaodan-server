import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/devices' },
    { path: '/login', component: () => import('./views/Login.vue'), meta: { anon: true } },
    { path: '/devices', component: () => import('./views/Devices.vue') },
    { path: '/agents', component: () => import('./views/Agents.vue') },
    { path: '/models', component: () => import('./views/Models.vue') },
    { path: '/chats', component: () => import('./views/Chats.vue') },
    { path: '/settings', component: () => import('./views/Settings.vue') },
    { path: '/:rest(.*)', redirect: '/devices' },
  ],
});

createApp(App).use(router).mount('#app');

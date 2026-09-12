import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // 产物直接落进后端的 dist/web,由同一个 Node 进程托管 —— 单容器单端口,
  // 不需要再为前端起一个 nginx。
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8002', '/health': 'http://127.0.0.1:8002' },
  },
});

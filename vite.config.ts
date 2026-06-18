import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    port: 3000,
    open: true,
    // 将 /socket.io 代理到后端 WebSocket 服务器
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3457',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});

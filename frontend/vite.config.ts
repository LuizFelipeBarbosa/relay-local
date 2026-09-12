import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the UI with hot reload against a running `relay serve`.
// The dashboard only accepts loopback Host and Origin headers, so the proxy rewrites both.
const dashboard = 'http://127.0.0.1:7331';

export default defineConfig({
  plugins: [react()],
  build: { outDir: '../internal/dashboard/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: dashboard, changeOrigin: true, headers: { Origin: dashboard } },
    },
  },
});

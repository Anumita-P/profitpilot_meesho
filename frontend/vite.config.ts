import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Offline by design: no CDN, no external fonts, no analytics. Everything ships in the bundle and the
// dev server proxies /api to the FastAPI process on :8000 (same origin as the built app in demo mode).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // sandbox preview domains (and localhost) are allowed; anything else is rejected
    allowedHosts: ['.e2b.app', '.e2b.dev', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2020' },
})

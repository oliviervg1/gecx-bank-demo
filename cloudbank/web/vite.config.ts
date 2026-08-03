import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Forward /ws/agent through this dev server so the browser can use a
    // same-origin WS URL. Without this, environments behind a reverse proxy
    // (Cloud Workstations, Codespaces, etc.) can't reach localhost:8080
    // because their external port forwarding strips the WS upgrade.
    proxy: {
      '/ws/agent': {
        target: 'ws://localhost:8080',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})

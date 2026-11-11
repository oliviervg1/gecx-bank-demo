import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const cloudbankRoot = fileURLToPath(new URL('..', import.meta.url))
const proxyTarget =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.VITE_PROXY_TARGET ?? 'ws://127.0.0.1:8765'

const wsProxy = {
  '/ws/agent': {
    target: proxyTarget,
    ws: true,
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [cloudbankRoot],
    },
    // Forward /ws/agent through this dev server so the browser uses a same-origin
    // WebSocket URL (including behind Cloud Shell or Codespaces port forwarding).
    proxy: wsProxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: wsProxy,
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
            },
            {
              name: 'ui-vendor',
              test: /node_modules[\\/](?:framer-motion|motion-dom|motion-utils|lucide-react)[\\/]/,
            },
          ],
        },
      },
    },
  },
})

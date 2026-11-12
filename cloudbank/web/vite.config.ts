import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const cloudbankRoot = fileURLToPath(new URL('..', import.meta.url))
const proxyTarget = process.env.VITE_PROXY_TARGET ?? 'ws://127.0.0.1:8765'
const proxyAuthToken = process.env.PROXY_AUTH_TOKEN?.trim()

function resolveProductionConnectSrc(): string {
  const customProxyUrl = process.env.VITE_PROXY_URL?.trim()
  if (customProxyUrl) {
    try {
      const parsed = new URL(customProxyUrl)
      if (
        parsed.protocol === 'ws:' ||
        parsed.protocol === 'wss:' ||
        parsed.protocol === 'http:' ||
        parsed.protocol === 'https:'
      ) {
        return `connect-src 'self' ${parsed.protocol}//${parsed.host}`
      }
    } catch {
      // Ignore malformed build-time URL and fall back to strict same-origin.
    }
  }
  return "connect-src 'self'"
}

export function tightenProductionCspPlugin(): Plugin {
  return {
    name: 'cloudbank-tighten-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self' 'unsafe-inline'", "script-src 'self'")
        .replace("connect-src 'self' ws: wss:", resolveProductionConnectSrc())
    },
  }
}

const wsProxy = {
  '/ws/agent': {
    target: proxyTarget,
    ws: true,
    changeOrigin: true,
    headers: proxyAuthToken ? { 'x-proxy-token': proxyAuthToken } : undefined,
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss(), tightenProductionCspPlugin()],
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
              test: /node_modules[\\/]lucide-react[\\/]/,
            },
          ],
        },
      },
    },
  },
})

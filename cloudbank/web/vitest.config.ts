import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const cloudbankRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      allow: [cloudbankRoot],
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
})

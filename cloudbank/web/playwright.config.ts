import { defineConfig, devices } from '@playwright/test'

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
const isCI = Boolean(env.CI)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  reporter: isCI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'uv --directory ../proxy run --locked python ../web/e2e/fake_bidi_server.py',
      url: 'http://127.0.0.1:8765/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        "sh -c '[ -f dist/index.html ] || npm run build; exec npx vite preview --host 127.0.0.1 --port 4173 --strictPort'",
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
})

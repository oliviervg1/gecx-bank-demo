import { defineConfig, devices } from '@playwright/test'

const isCI = Boolean(process.env.CI)
const proxyPort = Number.parseInt(process.env.CLOUDBANK_E2E_PROXY_PORT ?? '8765', 10) || 8765
const webPort = Number.parseInt(process.env.CLOUDBANK_E2E_WEB_PORT ?? '4173', 10) || 4173

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  reporter: isCI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
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
      url: `http://127.0.0.1:${proxyPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        CLOUDBANK_E2E_PROXY_PORT: String(proxyPort),
        CLOUDBANK_E2E_WEB_PORT: String(webPort),
      },
    },
    {
      command: `sh -c '[ -f dist/index.html ] || npm run build; exec npx vite preview --host 127.0.0.1 --port ${webPort} --strictPort'`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        ...process.env,
        VITE_PROXY_TARGET: `ws://127.0.0.1:${proxyPort}`,
      },
    },
  ],
})

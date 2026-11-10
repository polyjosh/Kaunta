import { defineConfig } from '@playwright/test';

const PORT = 5199;

/**
 * Counter flows on a 360×800 phone (CLAUDE.md, testing expectations).
 * Uses the Chrome installed on this machine (`channel: 'chrome'`), so no
 * browser download is needed. Each test gets a fresh browser context, and
 * so a fresh local database seeded from the handoff sample data.
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    viewport: { width: 360, height: 800 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    trace: 'retain-on-failure',
  },
  // The production build, so the service worker (offline start) is the real one.
  // Empty server settings: these tests run on the sample data even if .env.local exists.
  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
  },
});

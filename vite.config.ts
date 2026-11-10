import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // R-SYNC-4: the whole app (code, fonts, strings) is cached on the phone, so it
    // starts and sells with no network. Data lives in IndexedDB, not here.
    VitePWA({
      // 'prompt' with no prompt: a new version waits until the app is next opened,
      // instead of reloading under someone mid-sale (which would empty the tray).
      registerType: 'prompt',
      injectRegister: false, // registered in src/pwa.ts
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Kaunta',
        short_name: 'Kaunta',
        description: 'Record what was served and confirm it was paid.',
        start_url: '/counter/login',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#15100C',
        theme_color: '#15100C',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,json}'],
        navigateFallback: '/index.html',
        // Never cache the sync API: it must always reach the server or fail.
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//],
        cleanupOutdatedCaches: true,
        // The first install takes charge of the open page at once, so it works offline
        // from the first visit. Updates still wait (no skipWaiting).
        clientsClaim: true,
        skipWaiting: false,
      },
    }),
  ],
  test: {
    // Tests run on the sample data, whatever .env.local says.
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'supabase/**/*.test.ts'],
    css: false,
    // Each Supabase test file builds a real Postgres (PGlite) once; with several
    // running side by side that first build can take longer than the default 10s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

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
      // The logo files (kaunta-handoff/design/logo), cached so the app starts offline with them.
      includeAssets: ['favicon.svg', 'favicon.ico', 'brand/apple-touch-icon-180.png', 'brand/app-icon-192.png', 'brand/app-icon-512.png'],
      manifest: {
        id: '/',
        name: 'Kaunta · Till · Cash · Shelf',
        short_name: 'Kaunta',
        description: 'Kaunta shows you when your till, your cash, and your shelf don’t agree.',
        lang: 'en',
        categories: ['business', 'productivity'],
        // The landing page; the installed app goes on to the way this device used last (counter or admin).
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Phones at the counter are held upright; laptops for admin may be any way round.
        orientation: 'any',
        shortcuts: [
          { name: 'Open the counter', short_name: 'Counter', url: '/counter/login', icons: [{ src: '/brand/app-icon-192.png', sizes: '192x192', type: 'image/png' }] },
          { name: 'Owner or manager', short_name: 'Admin', url: '/admin', icons: [{ src: '/brand/app-icon-192.png', sizes: '192x192', type: 'image/png' }] },
        ],
        background_color: '#15100C',
        theme_color: '#15100C',
        icons: [
          { src: '/brand/app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/brand/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/brand/app-icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/brand/app-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,json}'],
        // OneSignal's worker is fetched by the browser itself, never from this cache.
        globIgnores: ['push/**'],
        navigateFallback: '/index.html',
        // Never cache the sync API: it must always reach the server or fail.
        navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//, /^\/push\//],
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
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', VITE_ONESIGNAL_APP_ID: '' },
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

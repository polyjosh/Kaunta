import { registerSW } from 'virtual:pwa-register';

/**
 * Caches the app on the phone. A new version activates on the next start
 * rather than mid-shift, so nothing reloads under someone's thumb.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  registerSW({ immediate: true });
}

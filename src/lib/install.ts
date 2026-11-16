import { useEffect, useState } from 'react';

/**
 * Installing Kaunta as an app (PWA). Chrome, Edge and Android fire
 * `beforeinstallprompt` once the app qualifies (manifest, icons, service
 * worker); we keep it for the landing page's "Install Kaunta" button. iPhone
 * Safari has no such event: there it is Share → Add to Home Screen.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | null = null;
let justInstalled = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Call once at start-up, before the event can fire. */
export function listenForInstall(target: Window = window): void {
  target.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  target.addEventListener('appinstalled', () => {
    deferred = null;
    justInstalled = true;
    notify();
  });
}

/** Running as the installed app (its own window, no browser bar). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export interface InstallState {
  /** The browser offered to install: the button can show. */
  canInstall: boolean;
  /** Already the app, or just installed. */
  installed: boolean;
  /** iPhone or iPad, not yet installed: show the Share → Add to Home Screen hint. */
  iosHint: boolean;
  install: () => Promise<void>;
}

export function useInstall(): InstallState {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }, []);
  const installed = justInstalled || isStandalone();
  return {
    canInstall: deferred !== null && !installed,
    installed,
    iosHint: !installed && deferred === null && isIos(),
    install: async () => {
      const event = deferred;
      if (!event) return;
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === 'accepted') {
        deferred = null;
        notify();
      }
    },
  };
}

const LAST_WAY = 'kaunta.lastWay';

/** Which way in this device used last (counter or admin), so the installed app opens there. */
export function lastWay(): '/counter/login' | '/admin' | null {
  try {
    const v = localStorage.getItem(LAST_WAY);
    return v === '/counter/login' || v === '/admin' ? v : null;
  } catch {
    return null;
  }
}

export function rememberWay(way: '/counter/login' | '/admin'): void {
  try {
    localStorage.setItem(LAST_WAY, way);
  } catch {
    // Only a convenience.
  }
}

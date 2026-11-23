import { useEffect, useState } from 'react';
import { serverConfig } from '../sync/config';

/**
 * Push notifications through OneSignal (web push; works in the installed app).
 *
 * Who is who: a counter phone signs in to OneSignal as `device_<device id>`
 * (it is shared, so its notifications are for whoever works on it), an owner
 * or manager as `account_<account id>`. The server (Supabase) sends to those
 * ids; see supabase/migrations/20261125000000_kaunta_notifications.sql.
 *
 * Needs `VITE_ONESIGNAL_APP_ID` in `.env.local` and a Supabase project: in the
 * browser demo, or without the app id, everything here does nothing.
 */

/** The part of OneSignal's v16 web SDK that Kaunta uses. */
export interface OneSignalApi {
  init(options: Record<string, unknown>): Promise<void>;
  login(externalId: string): Promise<void>;
  logout(): Promise<void>;
  User: { setLanguage(language: string): void };
  Notifications: {
    readonly permission: boolean;
    readonly isPushSupported?: () => boolean;
    requestPermission(): Promise<void>;
    addEventListener(event: 'permissionChange', listener: (granted: boolean) => void): void;
  };
}

type Deferred = ((sdk: OneSignalApi) => void | Promise<void>)[];
declare global {
  interface Window {
    OneSignalDeferred?: Deferred | { push: (fn: (sdk: OneSignalApi) => void | Promise<void>) => void };
  }
}

const SDK_URL = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js';
/** Its own scope, so it never takes over from the app's offline service worker (sw.js at /). */
export const PUSH_WORKER_PATH = 'push/onesignal/OneSignalSDKWorker.js';
export const PUSH_WORKER_SCOPE = '/push/onesignal/';

export interface PushConfig {
  /** OneSignal App ID (public). Safari on macOS 13+ and iOS 16.4+ uses standard web push: no Safari id. */
  appId: string;
}

export function pushConfig(env: Record<string, string | undefined> = import.meta.env): PushConfig | null {
  const appId = env.VITE_ONESIGNAL_APP_ID?.trim();
  // Only with a server: the server is what sends.
  if (!appId || !serverConfig(env)) return null;
  return { appId };
}

let started: Promise<OneSignalApi | null> | null = null;

/** Loads and starts the SDK once; resolves to null when push is off here. */
export function startPush(config: PushConfig | null = pushConfig(), doc: Document | null = typeof document === 'undefined' ? null : document): Promise<OneSignalApi | null> {
  if (!config || !doc) return Promise.resolve(null);
  if (started) return started;
  started = new Promise<OneSignalApi | null>((resolve) => {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    window.OneSignalDeferred.push(async (sdk) => {
      try {
        await sdk.init({
          appId: config.appId,
          serviceWorkerPath: PUSH_WORKER_PATH,
          serviceWorkerParam: { scope: PUSH_WORKER_SCOPE },
          allowLocalhostAsSecureOrigin: true,
          // Kaunta asks with its own button (counter menu, admin account menu), never on load
          // (leave OneSignal's own prompts off in its dashboard).
          autoResubscribe: true,
          notifyButton: { enable: false },
        });
        resolve(sdk);
      } catch (error) {
        console.warn('[Kaunta] push notifications are off:', error);
        resolve(null);
      }
    });
    if (!doc.querySelector(`script[src="${SDK_URL}"]`)) {
      const script = doc.createElement('script');
      script.src = SDK_URL;
      script.defer = true;
      script.onerror = () => resolve(null); // offline, or blocked: the app works without it
      doc.head.appendChild(script);
    }
  });
  return started;
}

/** For tests. */
export function resetPushForTests(): void {
  started = null;
  delete window.OneSignalDeferred;
}

/** Who this browser receives notifications for (null: nobody, e.g. after signing out). */
export async function pushAs(externalId: string | null, locale?: string): Promise<void> {
  const sdk = await startPush();
  if (!sdk) return;
  try {
    if (externalId) await sdk.login(externalId);
    else await sdk.logout();
    if (locale) sdk.User.setLanguage(locale);
  } catch (error) {
    console.warn('[Kaunta] push sign-in failed:', error);
  }
}

export const deviceAudience = (deviceId: string) => `device_${deviceId}`;
export const accountAudience = (accountId: string) => `account_${accountId}`;

export type PushState = 'off' | 'unsupported' | 'ask' | 'on' | 'blocked';

/** Whether notifications are on in this browser, and a way to turn them on (a tap: browsers require one). */
export function usePush(): { state: PushState; enable: () => Promise<void> } {
  const [sdk, setSdk] = useState<OneSignalApi | null>(null);
  const [state, setState] = useState<PushState>('off');
  useEffect(() => {
    let live = true;
    void startPush().then((s) => {
      if (!live || !s) return;
      // OneSignal's SDK object is a class (static members). Handed to setState as is, React would call it
      // as an updater ("Class constructor … cannot be invoked without 'new'") and the screen would fail.
      setSdk(() => s);
      const read = () => {
        if (s.Notifications.isPushSupported && !s.Notifications.isPushSupported()) return 'unsupported';
        if (s.Notifications.permission) return 'on';
        return typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'blocked' : 'ask';
      };
      setState(read());
      s.Notifications.addEventListener('permissionChange', () => live && setState(read()));
    });
    return () => {
      live = false;
    };
  }, []);
  return {
    state,
    enable: async () => {
      if (!sdk) return;
      await sdk.Notifications.requestPermission();
      setState(sdk.Notifications.permission ? 'on' : typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'blocked' : 'ask');
    },
  };
}

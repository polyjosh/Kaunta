import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PushButton } from '../components/PushButton';
import { PushPrompt, resetPushPrompt } from '../components/PushPrompt';
import { I18nProvider } from './I18nProvider';
import type { OneSignalApi } from './push';
import { PUSH_WORKER_PATH, PUSH_WORKER_SCOPE, accountAudience, deviceAudience, pushConfig, resetPushForTests, startPush, watchPushSubscription } from './push';

const live = { VITE_SUPABASE_URL: 'https://x.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' };

function fakeSdk(permission = false) {
  const listeners: ((granted: boolean) => void)[] = [];
  const sdk = {
    init: vi.fn(async () => {}),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    User: { setLanguage: vi.fn() },
    Notifications: {
      permission,
      isPushSupported: () => true,
      requestPermission: vi.fn(async () => {
        sdk.Notifications.permission = true;
        listeners.forEach((l) => l(true));
      }),
      addEventListener: (_: 'permissionChange', l: (granted: boolean) => void) => void listeners.push(l),
    },
  };
  return sdk;
}

/** What OneSignal's page script does once it loads: runs everything queued in OneSignalDeferred. */
async function sdkLoads(sdk: ReturnType<typeof fakeSdk>) {
  const queue = window.OneSignalDeferred as ((s: OneSignalApi) => Promise<void>)[];
  for (const fn of queue) await fn(sdk as unknown as OneSignalApi);
}

afterEach(() => {
  resetPushForTests();
  document.head.querySelectorAll('script').forEach((s) => s.remove());
});

describe('push notifications (OneSignal)', () => {
  it('are on only with an app id and a server', () => {
    expect(pushConfig({})).toBeNull();
    expect(pushConfig({ VITE_ONESIGNAL_APP_ID: 'app-1' })).toBeNull(); // the demo: no server to send
    expect(pushConfig({ ...live, VITE_ONESIGNAL_APP_ID: ' app-1 ' })).toEqual({ appId: 'app-1' });
  });

  it('load the SDK once, in its own service-worker scope, without prompting', async () => {
    const sdk = fakeSdk();
    const started = startPush({ appId: 'app-1' });
    startPush({ appId: 'app-1' });
    expect(document.head.querySelectorAll('script[src*="OneSignalSDK.page.js"]')).toHaveLength(1);
    await sdkLoads(sdk);
    expect(await started).toBe(sdk);
    expect(sdk.init).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'app-1',
      serviceWorkerPath: PUSH_WORKER_PATH,
      serviceWorkerParam: { scope: PUSH_WORKER_SCOPE },
      notifyButton: { enable: false },
    }));
  });

  it('do nothing at all in the demo', async () => {
    expect(await startPush(null)).toBeNull();
    expect(document.head.querySelector('script')).toBeNull();
  });

  it('name counter phones and accounts the way the server sends to them', () => {
    expect(deviceAudience('d_counter1')).toBe('device_d_counter1');
    expect(accountAudience('acc_1')).toBe('account_acc_1');
  });

  it('are turned on with a tap, and then say so', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', live.VITE_SUPABASE_URL);
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', live.VITE_SUPABASE_PUBLISHABLE_KEY);
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-1');
    const sdk = fakeSdk();
    render(
      <I18nProvider initialLocale="en">
        <PushButton className="x" />
      </I18nProvider>,
    );
    await sdkLoads(sdk);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }));
    expect(sdk.Notifications.requestPermission).toHaveBeenCalled();
    expect(await screen.findByText('Notifications are on on this phone.')).toBeInTheDocument();
    vi.unstubAllEnvs();
  });

  it('work with the real SDK’s shape: OneSignal hands over a class, not a plain object', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', live.VITE_SUPABASE_URL);
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', live.VITE_SUPABASE_PUBLISHABLE_KEY);
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-1');
    const plain = fakeSdk();
    // Like OneSignal v16: everything is static on a class.
    class OneSignal {
      static init = plain.init;
      static login = plain.login;
      static logout = plain.logout;
      static User = plain.User;
      static Notifications = plain.Notifications;
    }
    render(
      <I18nProvider initialLocale="en">
        <PushButton className="x" />
      </I18nProvider>,
    );
    await sdkLoads(OneSignal as unknown as ReturnType<typeof fakeSdk>);
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on notifications' }));
    expect(plain.Notifications.requestPermission).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('report this browser’s subscription once it is subscribed, and again only if it changes', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', live.VITE_SUPABASE_URL);
    vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', live.VITE_SUPABASE_PUBLISHABLE_KEY);
    vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-1');
    const sdk = fakeSdk();
    let onChange: ((c: { current?: { id?: string | null; optedIn?: boolean } }) => void) | null = null;
    const sub = { id: 'sub-1', optedIn: false, addEventListener: (_: 'change', l: typeof onChange) => void (onChange = l), removeEventListener: vi.fn() };
    (sdk.User as Record<string, unknown>).PushSubscription = sub;
    const reported: string[] = [];
    const watching = watchPushSubscription((id) => reported.push(id));
    await sdkLoads(sdk);
    const stop = await watching;
    expect(reported).toEqual([]); // not allowed yet
    onChange!({ current: { id: 'sub-1', optedIn: true } });
    onChange!({ current: { id: 'sub-1', optedIn: true } });
    onChange!({ current: { id: 'sub-2', optedIn: true } });
    expect(reported).toEqual(['sub-1', 'sub-2']);
    stop();
    expect(sub.removeEventListener).toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('show nothing while push is not set up', () => {
    const { container } = render(
      <I18nProvider initialLocale="en">
        <PushButton className="x" />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  describe('the prompt after signing in', () => {
    const renderPrompt = (audience: 'counter' | 'admin' = 'counter') =>
      render(
        <I18nProvider initialLocale="en">
          <PushPrompt audience={audience} />
        </I18nProvider>,
      );
    const livePush = () => {
      vi.stubEnv('VITE_SUPABASE_URL', live.VITE_SUPABASE_URL);
      vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', live.VITE_SUPABASE_PUBLISHABLE_KEY);
      vi.stubEnv('VITE_ONESIGNAL_APP_ID', 'app-1');
    };
    afterEach(() => {
      vi.unstubAllEnvs();
      sessionStorage.clear();
    });

    it('asks someone who has not allowed notifications; Turn on opens the browser’s question', async () => {
      livePush();
      const sdk = fakeSdk();
      renderPrompt();
      await sdkLoads(sdk);
      const dialog = await screen.findByRole('alertdialog', { name: 'Turn on notifications' });
      expect(dialog).toHaveTextContent('when an order is still unpaid');
      await userEvent.click(screen.getByRole('button', { name: 'Turn on' }));
      expect(sdk.Notifications.requestPermission).toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('Not now hides it until the next sign-in', async () => {
      livePush();
      const sdk = fakeSdk();
      const first = renderPrompt('admin');
      await sdkLoads(sdk);
      expect(await screen.findByRole('alertdialog')).toHaveTextContent('a request waits for you');
      await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      first.unmount();

      renderPrompt('admin');
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      first.unmount();

      resetPushPrompt();
      renderPrompt('admin');
      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    });

    it('says nothing when notifications are already on, or push is not set up', async () => {
      livePush();
      const sdk = fakeSdk(true);
      const { container } = renderPrompt();
      await sdkLoads(sdk);
      await new Promise((r) => setTimeout(r, 0));
      expect(container).toBeEmptyDOMElement();
      vi.unstubAllEnvs();
      resetPushForTests();
      const off = renderPrompt();
      expect(off.container).toBeEmptyDOMElement();
    });
  });
});

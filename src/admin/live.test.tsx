import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { KauntaDB } from '../data/db';
import { I18nProvider } from '../lib/I18nProvider';
import { ThemeProvider } from '../lib/ThemeProvider';
import { AdminApp } from './AdminApp';
import { AdminServer, normaliseLogin } from './server';

const config = { url: 'https://example.supabase.co', anonKey: 'anon' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const memory = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
};

describe('normaliseLogin', () => {
  it('turns the ways Kenyans write a number into +254…, and leaves emails alone', () => {
    expect(normaliseLogin('0712 345 678')).toEqual({ phone: '+254712345678' });
    expect(normaliseLogin('712345678')).toEqual({ phone: '+254712345678' });
    expect(normaliseLogin('+254 712-345-678')).toEqual({ phone: '+254712345678' });
    expect(normaliseLogin(' Njeri@Baraka.co.ke ')).toEqual({ email: 'njeri@baraka.co.ke' });
  });
});

describe('AdminServer', () => {
  it('signs in with Supabase Auth and calls the admin functions with the access token', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/auth/v1/token?grant_type=password')) {
        expect(JSON.parse(String(init!.body))).toEqual({ phone: '+254712345678', password: 'secret' });
        return json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, user: { id: 'u1' } });
      }
      expect(u).toBe('https://example.supabase.co/rest/v1/rpc/admin_pull');
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer at1');
      expect(JSON.parse(String(init!.body))).toEqual({ p_bar_id: 'bar_1', p_since: null });
      return json({ me: 'p_njeri' });
    });
    const server = new AdminServer(config, fetchMock as typeof fetch, memory());
    await server.signIn('0712 345 678', 'secret');
    expect(server.signedIn).toBe(true);
    expect((await server.forBar('bar_1').pull(null)).me).toBe('p_njeri');
  });

  it('refreshes a token that is about to run out', async () => {
    const storage = memory();
    storage.setItem('kaunta.adminAuth', JSON.stringify({ access_token: 'old', refresh_token: 'rt', expires_at: Date.now() + 10_000, user_id: 'u1' }));
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes('grant_type=refresh_token')) return json({ access_token: 'new', refresh_token: 'rt2', expires_in: 3600, user: { id: 'u1' } });
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer new');
      return json({ me: 'p_njeri' });
    });
    await new AdminServer(config, fetchMock as typeof fetch, storage).forBar('bar_1').pull(null);
    expect(calls[0]).toContain('grant_type=refresh_token');
  });

  it('a wrong password is said as such', async () => {
    const server = new AdminServer(config, (async () => json({ error: 'invalid_grant' }, 400)) as typeof fetch, memory());
    await expect(server.signIn('0712345678', 'nope')).rejects.toThrow('wrong_password');
    expect(server.signedIn).toBe(false);
  });
});

describe('admin with a server', () => {
  const dbs: KauntaDB[] = [];
  afterEach(async () => {
    await Promise.all(dbs.splice(0).map((d) => d.delete()));
  });

  function renderLive(server: AdminServer) {
    const db = new KauntaDB(`kaunta-admin-live-${dbs.length}-${Math.random()}`);
    dbs.push(db);
    render(
      <MemoryRouter initialEntries={['/admin']}>
        <I18nProvider initialLocale="en">
          <ThemeProvider>
            <Routes>
              <Route path="/admin/*" element={<AdminApp server={server} db={db} />} />
            </Routes>
          </ThemeProvider>
        </I18nProvider>
      </MemoryRouter>,
    );
  }

  it('asks to sign in, and says plainly when the account is not an admin', async () => {
    const fetchMock = (async (url: RequestInfo | URL) =>
      String(url).includes('/auth/')
        ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u2' } })
        : new Response('{"message":"not_admin"}', { status: 400 })) as typeof fetch;
    renderLive(new AdminServer(config, fetchMock, memory()));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Phone number or email'), '0712345678');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This account is not an owner or admin of this bar.');
  });

  it('someone with two bars picks one, and can switch from the bar’s name', async () => {
    localStorage.clear();
    const bars = [
      { id: 'bar_1', name: 'Pub One', role: 'owner', person_id: 'p_1' },
      { id: 'bar_2', name: 'Pub Two', role: 'admin', person_id: 'p_2' },
    ];
    const pulled: string[] = [];
    const pull = (bar: (typeof bars)[number]) => ({
      me: bar.person_id,
      cursor: '2026-11-16T10:00:00.000Z',
      server_time: '2026-11-16T10:00:30.000Z',
      bar: [{ id: bar.id, name: bar.name, timezone: 'Africa/Nairobi', day_start: '06:00', self_void_minutes: 5, ageing_minutes: 30, pin_attempts: 5, lockout_minutes: 5, keg_foam_allowance_cups: 0 }],
      people: [{ id: bar.person_id, name: 'Njeri', initial: 'N', colour: '#f2a0a0', role: bar.role, login: 'password', pin_hash: null, pin_locked_until: null, failed_pin_attempts: 0, archived_at: null }],
    });
    const fetchMock = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/auth/')) return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, user: { id: 'u1' } });
      if (u.endsWith('/admin_bars')) return json(bars);
      if (u.endsWith('/admin_pull')) {
        const id = JSON.parse(String(init!.body)).p_bar_id as string;
        pulled.push(id);
        return json(pull(bars.find((b) => b.id === id)!));
      }
      return json({ server_time: '2026-11-16T10:00:30.000Z', results: [] });
    }) as typeof fetch;
    const storage = memory();
    storage.setItem('kaunta.adminAuth', JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600_000, user_id: 'u1' }));
    renderLive(new AdminServer(config, fetchMock, storage));
    const user = userEvent.setup();

    expect(await screen.findByRole('heading', { name: 'Which bar?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Pub Two/ }));
    // A bar with no products yet opens on first run.
    expect(await screen.findByRole('heading', { name: 'No products yet' })).toBeInTheDocument();
    expect(pulled[0]).toBe('bar_2');

    await user.click(screen.getByRole('button', { name: 'Pub Two: switch bar' }));
    const menu = screen.getByRole('group', { name: 'Your bars' });
    expect(within(menu).getByRole('button', { name: /Pub Two/ })).toHaveAttribute('aria-current', 'true');
    // Only owners start bars; here she is an owner of Pub One, so she may.
    expect(within(menu).getByRole('button', { name: 'Add a bar' })).toBeInTheDocument();
    await user.click(within(menu).getByRole('button', { name: /Pub One/ }));
    expect(await screen.findByRole('button', { name: 'Pub One: switch bar' })).toBeInTheDocument();
    expect(pulled).toContain('bar_1');
    // Remembered for next time on this browser.
    expect(JSON.parse(localStorage.getItem('kaunta.adminBar')!)).toBe('bar_1');
  });
});

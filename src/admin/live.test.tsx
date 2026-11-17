import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { KauntaDB } from '../data/db';
import { I18nProvider } from '../lib/I18nProvider';
import { ThemeProvider } from '../lib/ThemeProvider';
import { AdminApp } from './AdminApp';
import { AdminServer, normaliseLogin } from './server';

const config = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' };
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
  it('signs in with a username and password, then calls kaunta_admin with the session (publishable key only)', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      expect(init!.headers).toEqual({ apikey: 'sb_publishable_test', 'Content-Type': 'application/json' });
      if (u.endsWith('/rpc/account_sign_in')) {
        expect(JSON.parse(String(init!.body))).toEqual({ p_username: 'njeri', p_secret: 'Baraka@2026' });
        return json({ ok: true, token: 'tok1', account: { id: 'acct_1', username: 'njeri' } });
      }
      expect(u).toBe('https://example.supabase.co/rest/v1/rpc/kaunta_admin');
      expect(JSON.parse(String(init!.body))).toEqual({ p_session: 'tok1', p_call: 'admin_pull', p_args: { p_bar_id: 'bar_1', p_since: null } });
      return json({ me: 'p_njeri' });
    });
    const storage = memory();
    const server = new AdminServer(config, fetchMock as typeof fetch, storage);
    expect(await server.signIn('njeri', 'Baraka@2026')).toMatchObject({ ok: true });
    expect(server.signedIn).toBe(true);
    expect(storage.getItem('kaunta.adminSession')).toBe('tok1');
    expect((await server.forBar('bar_1').pull(null)).me).toBe('p_njeri');
  });

  it('says how many tries are left, or until when the account is locked', async () => {
    const answers = [{ ok: false, reason: 'wrong', tries_left: 3 }, { ok: false, reason: 'locked', until: '2026-11-17T10:15:00Z' }];
    const server = new AdminServer(config, (async () => json(answers.shift())) as typeof fetch, memory());
    expect(await server.signIn('njeri', 'nope')).toEqual({ ok: false, reason: 'wrong', triesLeft: 3 });
    expect(await server.signIn('njeri', 'nope')).toEqual({ ok: false, reason: 'locked', until: '2026-11-17T10:15:00Z' });
    expect(server.signedIn).toBe(false);
  });

  it('an expired session signs out; Kaunta uses kaunta_super', async () => {
    const storage = memory();
    storage.setItem('kaunta.adminSession', 'old');
    const server = new AdminServer(config, (async () => new Response('{"message":"signed_out"}', { status: 400 })) as typeof fetch, storage);
    await expect(server.bars()).rejects.toThrow('signed_out');
    expect(server.signedIn).toBe(false);
    const calls: string[] = [];
    const kaunta = new AdminServer(config, (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return String(url).endsWith('super_sign_in') ? json({ ok: true, token: 'k1' }) : json({ version: 2, accounts: [], bars: [], members: [] });
    }) as typeof fetch, memory(), true);
    expect(await kaunta.superSignIn('kaunta-2026')).toBe('ok');
    await kaunta.platform();
    expect(calls.at(-1)).toBe('https://example.supabase.co/rest/v1/rpc/kaunta_super');
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

  it('asks for a username and password, and says plainly when they are wrong', async () => {
    const fetchMock = (async () => json({ ok: false, reason: 'wrong', tries_left: 4 })) as typeof fetch;
    renderLive(new AdminServer(config, fetchMock, memory()));
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'njeri');
    await user.type(screen.getByLabelText('Password or PIN'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('4 tries left');
    // No demo accounts are offered on a real server.
    expect(screen.queryByText(/Baraka@2026/)).not.toBeInTheDocument();
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
      const body = JSON.parse(String(init!.body)) as { p_call: string; p_args: { p_bar_id?: string } };
      expect(u.endsWith('/kaunta_admin')).toBe(true);
      if (body.p_call === 'admin_bars') return json(bars);
      if (body.p_call === 'admin_me') return json({ account: { id: 'acct_1', username: 'njeri', secret: 'password', pin_set_by: 'self' }, bar_limit: { used: 1, max: 3 }, suspended: [] });
      if (body.p_call === 'admin_platform') return json({ version: 2, accounts: [], bars: [], members: [] });
      if (body.p_call === 'admin_pull') {
        const id = body.p_args.p_bar_id!;
        pulled.push(id);
        return json(pull(bars.find((b) => b.id === id)!));
      }
      return json({ server_time: '2026-11-16T10:00:30.000Z', results: [] });
    }) as typeof fetch;
    const storage = memory();
    storage.setItem('kaunta.adminSession', 'tok');
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

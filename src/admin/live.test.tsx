import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
      return json({ me: 'p_njeri' });
    });
    const server = new AdminServer(config, fetchMock as typeof fetch, memory());
    await server.signIn('0712 345 678', 'secret');
    expect(server.signedIn).toBe(true);
    expect((await server.pull(null)).me).toBe('p_njeri');
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
    await new AdminServer(config, fetchMock as typeof fetch, storage).pull(null);
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
});

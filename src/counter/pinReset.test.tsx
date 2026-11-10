import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { checkResetCode, setNewPin } from '../data/login';
import { KauntaDB } from '../data/db';
import { pendingEvents } from '../data/outbox';
import { DbProvider } from '../data/react';
import { seedDatabase } from '../data/seedDb';
import { hashResetCode, verifyPin } from '../domain/pin';
import { I18nProvider } from '../lib/I18nProvider';
import { LoginScreen } from './LoginScreen';
import { SessionProvider } from './Session';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();
const CODE = '482913';

beforeEach(async () => {
  db = new KauntaDB(`kaunta-reset-${++n}`);
  await seedDatabase(db);
  // An admin reset Akinyi's PIN (R-PIN-2): only the hash of the code is on the phone.
  await db.people.update('p_akinyi', { pin_reset_hash: await hashResetCode(CODE), pin_reset_expires_at: new Date(Date.now() + 86_400_000).toISOString() });
});
afterEach(() => db.delete());

const keys = async (digits: string) => {
  for (const d of digits) await user.click(screen.getByRole('button', { name: d }));
};

describe('R-PIN-2 at the counter', () => {
  it('code from the admin → new PIN twice → logged in; only the PIN’s hash is recorded', async () => {
    render(
      <MemoryRouter initialEntries={['/counter/login']}>
        <I18nProvider initialLocale="en">
          <DbProvider db={db}>
            <SessionProvider>
              <Routes>
                <Route path="/counter/login" element={<LoginScreen />} />
                <Route path="/counter/sell" element={<p>sell screen</p>} />
              </Routes>
            </SessionProvider>
          </DbProvider>
        </I18nProvider>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: /Akinyi/ }));
    expect(screen.getByText('Type the 6-digit code from your admin')).toBeInTheDocument();
    await keys('111111');
    expect(await screen.findByText('That code is not right · 4 tries left')).toBeInTheDocument();
    await keys(CODE);
    expect(await screen.findByText('Choose a new 4-digit PIN')).toBeInTheDocument();
    await keys('1357');
    expect(await screen.findByText('Type the same PIN again')).toBeInTheDocument();
    await keys('1357');
    expect(await screen.findByText('sell screen')).toBeInTheDocument();

    const akinyi = (await db.people.get('p_akinyi'))!;
    expect(akinyi.pin_reset_hash).toBeNull();
    expect(await verifyPin('1357', akinyi.pin_hash)).toBe(true);
    const sent = await pendingEvents(db);
    const set = sent.find((e) => e.type === 'pin_set')!;
    expect(JSON.stringify(set)).not.toContain('1357');
  });

  it('two different PINs start the choice again', async () => {
    render(
      <MemoryRouter initialEntries={['/counter/login']}>
        <I18nProvider initialLocale="en">
          <DbProvider db={db}>
            <SessionProvider>
              <Routes>
                <Route path="/counter/login" element={<LoginScreen />} />
              </Routes>
            </SessionProvider>
          </DbProvider>
        </I18nProvider>
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: /Akinyi/ }));
    await keys(CODE);
    await screen.findByText('Choose a new 4-digit PIN');
    await keys('1357');
    await screen.findByText('Type the same PIN again');
    await keys('2468');
    expect(await screen.findByText('The two PINs were different. Choose a new PIN again.')).toBeInTheDocument();
    expect(screen.getByText('Choose a new 4-digit PIN')).toBeInTheDocument();
  });

  it('wrong codes lock the person like wrong PINs do (R-PIN-1)', async () => {
    for (let i = 0; i < 4; i++) expect((await checkResetCode(db, 'd_counter1', 'p_akinyi', '000000')).status).toBe('wrong');
    expect((await checkResetCode(db, 'd_counter1', 'p_akinyi', '000000')).status).toBe('locked');
    expect((await checkResetCode(db, 'd_counter1', 'p_akinyi', CODE)).status).toBe('locked');
  });

  it('an expired code does not work', async () => {
    await db.people.update('p_akinyi', { pin_reset_expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await checkResetCode(db, 'd_counter1', 'p_akinyi', CODE)).status).toBe('wrong');
  });

  it('setNewPin refuses anything but 4 digits', async () => {
    await expect(setNewPin(db, 'd_counter1', 'p_akinyi', '12345')).rejects.toThrow('4 digits');
  });
});

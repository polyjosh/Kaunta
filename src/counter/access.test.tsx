import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { KauntaDB } from '../data/db';
import { seedDatabase } from '../data/seedDb';
import { hashPin, hashSecret } from '../domain/pin';
import { setAdminHere } from '../lib/adminHere';

/**
 * Who may use the counter: staff with the PIN an owner or manager set; the
 * owner (password) and managers (PIN) too, straight in when already signed in
 * to admin here; and nobody whose access was removed, who is signed out at once.
 */

let db: KauntaDB;
let n = 0;
const COUNTER_NOW = '2026-11-10T19:20:00.000Z';
const user = userEvent.setup();

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(COUNTER_NOW));
  localStorage.clear();
  db = new KauntaDB(`kaunta-access-${++n}`);
  await seedDatabase(db);
  // As the demo gives them: the owner's password and the manager's PIN, hashed on their rows.
  await db.people.update('p_njeri', { pin_hash: await hashSecret('Baraka@2026') });
  await db.people.update('p_chebet', { pin_hash: await hashPin('4826') });
});
afterEach(async () => {
  vi.useRealTimers();
  localStorage.clear();
  await db.delete();
});

const renderApp = (path = '/counter/login') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App db={db} />
    </MemoryRouter>,
  );

const tile = async (name: string) => (await screen.findAllByRole('button', { name: new RegExp(name) })).find((b) => b.classList.contains('c-staff-tile'))!;
const typePin = async (pin: string) => {
  for (const digit of pin) await user.click(screen.getByRole('button', { name: digit }));
};

describe('owners and managers at the counter', () => {
  it('the owner signs in with their password and sells', async () => {
    renderApp();
    await user.click(await tile('Njeri'));
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'wrong-one');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Wrong password · 4 tries left')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'Baraka@2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    // A new shift on this phone: the float first.
    expect(await screen.findByRole('heading', { name: 'Start your shift, Njeri' })).toBeInTheDocument();
    for (const key of ['1', '5', '0', '0']) await user.click(screen.getByRole('button', { name: key }));
    await user.click(screen.getByRole('button', { name: 'Start shift · float KES 1,500' }));
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await user.click(screen.getByRole('button', { name: 'Record (pay later)' }));
    expect(await screen.findByText(/Order #049 recorded/)).toBeInTheDocument();
    expect((await db.orders.toArray()).find((o) => o.short_no === '#049')?.recorded_by).toBe('p_njeri');
    expect((await db.shifts.toArray()).find((x) => x.person_id === 'p_njeri' && x.closed_at === null)?.float_kes).toBe(1500);
  });

  it('a manager signs in with their 4-digit PIN, and can go to admin from the menu', async () => {
    renderApp();
    await user.click(await tile('Chebet'));
    await typePin('4826');
    await user.click(await screen.findByRole('button', { name: 'Start shift with no float' }));
    await user.click(await screen.findByRole('button', { name: /Switch user · Chebet/ }));
    expect(screen.getByRole('button', { name: 'Open admin' })).toBeInTheDocument();
  });

  it('whoever is signed in to admin on this browser goes straight in, without signing in again', async () => {
    setAdminHere({ bar_id: 'bar_baraka', person_id: 'p_njeri' });
    renderApp('/counter/login?from=admin');
    await user.click(await screen.findByRole('button', { name: 'Start shift with no float' }));
    expect(await screen.findByRole('button', { name: 'Tusker Lager' })).toBeInTheDocument();
    expect((await db.outbox.toArray()).some((e) => e.type === 'logged_in' && e.recorded_by === 'p_njeri')).toBe(true);
  });

  it('only for that person and that bar: anyone else still types theirs', async () => {
    setAdminHere({ bar_id: 'another_bar', person_id: 'p_njeri' });
    renderApp('/counter/login?from=admin');
    await user.click(await tile('Njeri'));
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
  });
});

describe('staff PINs and suspension', () => {
  it('someone without a PIN is told to ask the owner or a manager (staff can’t set their own)', async () => {
    await db.people.update('p_akinyi', { pin_hash: null });
    renderApp();
    await user.click(await tile('Akinyi'));
    expect(screen.getByText('Akinyi has no PIN yet. Ask the owner or a manager to set one (admin → Staff & devices).')).toBeInTheDocument();
  });

  it('a suspended person is not on the list', async () => {
    await db.people.update('p_kiprop', { suspended_at: COUNTER_NOW });
    renderApp();
    await tile('Wanjiku');
    expect(screen.queryByRole('button', { name: /Kiprop/ })).toBeNull();
  });

  it('suspended while logged in: what is in the tray is saved, and they are signed out at once', async () => {
    renderApp();
    await user.click(await tile('Wanjiku'));
    await typePin('2580');
    await user.click(await screen.findByRole('button', { name: 'Tusker Lager' }));
    await db.people.update('p_wanjiku', { suspended_at: new Date().toISOString() });
    expect(await screen.findByText('Wanjiku’s access was removed, so they were signed out. Everything they recorded is saved.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Wanjiku/ })).toBeNull();
    await waitFor(async () => {
      const order = (await db.orders.toArray()).find((o) => o.short_no === '#049');
      expect(order).toMatchObject({ recorded_by: 'p_wanjiku', status: 'open' });
    });
  });
});

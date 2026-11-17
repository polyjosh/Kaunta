import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { seedAdminDatabase } from '../data/adminSeed';
import { KauntaDB } from '../data/db';
import { SAMPLE_NOW } from '../domain/sampleDay';
import { I18nProvider } from '../lib/I18nProvider';
import { ThemeProvider } from '../lib/ThemeProvider';
import { accountByUsername, barsFor, DEMO_MANAGER, LOUNGE_BAR_ID, resetPlatform, SAMPLE_BAR_ID } from '../platform/platform';
import { AdminApp } from './AdminApp';
import { demoBars, demoStore, demoStoreName } from './bars';

/** The owner adds managers on Staff & devices, to one or more of their own bars. */

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

beforeEach(async () => {
  localStorage.clear();
  resetPlatform();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SAMPLE_NOW));
  db = new KauntaDB(`kaunta-admin-managers-${++n}`);
  await seedAdminDatabase(db, { now: new Date(SAMPLE_NOW) });
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await db.delete();
  await Promise.all(demoBars().filter((b) => b.id !== SAMPLE_BAR_ID).map((b) => new KauntaDB(demoStoreName(b.id)).delete()));
  localStorage.clear();
  resetPlatform();
});

function renderStaff() {
  return render(
    <MemoryRouter initialEntries={['/admin/staff']}>
      <I18nProvider initialLocale="en">
        <ThemeProvider>
          <Routes>
            <Route path="/admin/*" element={<AdminApp db={db} config={null} />} />
          </Routes>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

const card = async () => (await screen.findByRole('heading', { name: 'Managers' })).closest('section')!;

describe('Managers (owners only)', () => {
  it('the owner adds a new manager to both of their bars; they are in each bar, audited', async () => {
    renderStaff();
    const c = await card();
    expect(within(c).getByText('Chebet')).toBeInTheDocument();
    await user.click(within(c).getByRole('button', { name: '+ Add a manager' }));
    await user.type(within(c).getByLabelText('Name'), 'Amani');
    await user.type(within(c).getByLabelText('Username'), 'amani');
    const pin = within(c).getByLabelText('PIN (4 digits)');
    await user.clear(pin);
    await user.type(pin, '2468');
    await user.click(within(c).getByRole('checkbox', { name: 'Baraka Lounge' }));
    await user.click(within(c).getByRole('button', { name: 'Add manager' }));

    expect(await within(c).findByText('Amani can now run Baraka Pub, Baraka Lounge.')).toBeInTheDocument();
    expect(within(c).getByText('2468')).toBeInTheDocument();
    const amani = accountByUsername('amani')!;
    expect(barsFor(amani.id).map((b) => b.id).sort()).toEqual([LOUNGE_BAR_ID, SAMPLE_BAR_ID].sort());
    // Their row in each bar's store, so admin opens it and the counter lists them.
    expect(await db.people.get(amani.person_id)).toMatchObject({ role: 'admin', login: 'pin', archived_at: null });
    expect(await demoStore(LOUNGE_BAR_ID).people.get(amani.person_id)).toMatchObject({ role: 'admin' });
    expect((await db.auditEvents.where('kind').equals('person_saved').toArray()).some((e) => e.ref_id === amani.person_id)).toBe(true);
    // And on the Staff list.
    expect(await screen.findByRole('rowheader', { name: /Amani/ })).toBeInTheDocument();
  });

  it('an existing manager is added to the other bar, and removed from it again', async () => {
    renderStaff();
    await user.click(await screen.findByRole('button', { name: 'Baraka Pub: switch bar' }));
    await user.click(within(screen.getByRole('group', { name: 'Your bars' })).getByRole('button', { name: /Baraka Lounge/ }));
    const c = await card();
    expect(within(c).getByText('No managers at Baraka Lounge yet.')).toBeInTheDocument();
    await user.click(within(c).getByRole('button', { name: '+ Add a manager' }));
    expect(within(c).getByLabelText('Manager')).toHaveDisplayValue('Chebet (chebet)');
    await user.click(within(c).getByRole('button', { name: 'Add to this bar' }));
    expect(await within(c).findByText('Chebet now runs Baraka Lounge too.')).toBeInTheDocument();
    expect(barsFor(DEMO_MANAGER.id).map((b) => b.id).sort()).toEqual([LOUNGE_BAR_ID, SAMPLE_BAR_ID].sort());
    expect(within(c).getByText(/also runs Baraka Pub/)).toBeInTheDocument();

    await user.click(within(c).getByRole('button', { name: 'Remove Chebet from Baraka Lounge' }));
    await user.click(within(c).getByRole('button', { name: 'Yes, remove from Baraka Lounge' }));
    expect(await within(c).findByText('No managers at Baraka Lounge yet.')).toBeInTheDocument();
    expect(barsFor(DEMO_MANAGER.id).map((b) => b.id)).toEqual([SAMPLE_BAR_ID]);
    const chebet = accountByUsername('chebet')!;
    await waitFor(async () => expect((await demoStore(LOUNGE_BAR_ID).people.get(chebet.person_id))?.archived_at).toBeTruthy());
  });

  it('a username that is taken is refused', async () => {
    renderStaff();
    const c = await card();
    await user.click(within(c).getByRole('button', { name: '+ Add a manager' }));
    await user.type(within(c).getByLabelText('Name'), 'Another');
    await user.type(within(c).getByLabelText('Username'), 'chebet');
    await user.click(within(c).getByRole('button', { name: 'Add manager' }));
    expect(await within(c).findByRole('alert')).toHaveTextContent('That username is taken');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { seedAdminDatabase } from '../data/adminSeed';
import { KauntaDB } from '../data/db';
import { SAMPLE_NOW } from '../domain/sampleDay';
import { I18nProvider } from '../lib/I18nProvider';
import { ThemeProvider } from '../lib/ThemeProvider';
import { AdminApp } from './AdminApp';
import { formatBarCode } from '../domain/barCode';
import { demoBarByCode, demoBars, demoStoreName } from './bars';
import { resetPlatform } from '../platform/platform';

let db: KauntaDB;
let n = 0;
const user = userEvent.setup();

beforeEach(async () => {
  localStorage.clear();
  resetPlatform();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(SAMPLE_NOW));
  db = new KauntaDB(`kaunta-admin-bars-${++n}`);
  await seedAdminDatabase(db, { now: new Date(SAMPLE_NOW) });
});
afterEach(async () => {
  // Unmount before the stores go, so nothing reads a deleted store.
  cleanup();
  vi.useRealTimers();
  await db.delete();
  // The other demo bars' stores.
  await Promise.all(demoBars().filter((b) => b.id !== 'bar_baraka').map((b) => new KauntaDB(demoStoreName(b.id)).delete()));
  localStorage.clear();
  resetPlatform();
});

function renderAdmin() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
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

describe('an owner with more than one bar (demo)', () => {
  it('opens the sample bar, and switches to the second bar, which has not started yet', async () => {
    renderAdmin();
    expect(await screen.findByText('KES 86,450')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Baraka Pub: switch bar' }));
    const menu = screen.getByRole('group', { name: 'Your bars' });
    // By name.
    expect(within(menu).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Baraka Lounge'),
      expect.stringContaining('Baraka Pub'),
    ]);
    await user.click(within(menu).getByRole('button', { name: /Baraka Lounge/ }));

    // Its own store: no sales, no products, so Today starts the menu.
    expect(await screen.findByRole('heading', { name: 'No products yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Baraka Lounge: switch bar' })).toBeInTheDocument();
    expect(screen.queryByText('KES 86,450')).not.toBeInTheDocument();

    // And back: the sample bar is as it was.
    await user.click(screen.getByRole('button', { name: 'Baraka Lounge: switch bar' }));
    await user.click(within(screen.getByRole('group', { name: 'Your bars' })).getByRole('button', { name: /Baraka Pub/ }));
    expect(await screen.findByText('KES 86,450')).toBeInTheDocument();
  });

  it('“Add a bar” starts a new bar and opens it', async () => {
    renderAdmin();
    await user.click(await screen.findByRole('button', { name: 'Baraka Pub: switch bar' }));
    await user.click(screen.getByRole('button', { name: 'Add a bar' }));
    await user.click(screen.getByRole('button', { name: 'Start this bar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give the bar a name.');
    await user.type(screen.getByLabelText('Name of the new bar'), 'Baraka Garden');
    await user.click(screen.getByRole('button', { name: 'Start this bar' }));

    expect(await screen.findByRole('button', { name: 'Baraka Garden: switch bar' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'No products yet' })).toBeInTheDocument();
    expect(demoBars().map((b) => b.name)).toEqual(['Baraka Pub', 'Baraka Lounge', 'Baraka Garden']);
  });

  it('Staff & devices shows the bar code for counter phones; the owner can make a new one', async () => {
    render(
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
    const card = (await screen.findByRole('heading', { name: 'Bar code for counter phones' })).closest('section')!;
    expect(within(card).getByText('BRKA-PUB2')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Change the code' }));
    expect(within(card).getByText(/The old code stops working for new phones/)).toBeInTheDocument();
    // Their own code: one another bar has is refused (look-alikes too)…
    await user.type(within(card).getByLabelText('The code you want'), 'brka-4nge');
    await user.click(within(card).getByRole('button', { name: 'Use this code' }));
    expect(within(card).getByRole('alert')).toHaveTextContent('Another bar already has that code.');
    // …a free one is taken.
    await user.clear(within(card).getByLabelText('The code you want'));
    await user.type(within(card).getByLabelText('The code you want'), 'baraka-pub');
    await user.click(within(card).getByRole('button', { name: 'Use this code' }));
    expect(await within(card).findByText(/New code made/)).toBeInTheDocument();
    expect(within(card).getByText('BARA-KAPU-B')).toBeInTheDocument();
    expect(demoBarByCode('BRKAPUB2')).toBeNull();
    expect(demoBarByCode('barakapub')?.id).toBe('bar_baraka');
    // Or one made for them.
    await user.click(within(card).getByRole('button', { name: 'Change the code' }));
    await user.click(within(card).getByRole('button', { name: 'Make one for me' }));
    const fresh = demoBars().find((b) => b.id === 'bar_baraka')!.counter_code!;
    expect(fresh).not.toBe('BARAKAPUB');
    expect(await within(card).findByText(formatBarCode(fresh))).toBeInTheDocument();
  });

  it('a new bar opens with its code on Today, next to first run', async () => {
    renderAdmin();
    await user.click(await screen.findByRole('button', { name: 'Baraka Pub: switch bar' }));
    await user.click(screen.getByRole('button', { name: 'Add a bar' }));
    await user.type(screen.getByLabelText('Name of the new bar'), 'Baraka Garden');
    await user.click(screen.getByRole('button', { name: 'Start this bar' }));
    expect(await screen.findByRole('heading', { name: 'No products yet' })).toBeInTheDocument();
    const code = demoBars().find((b) => b.name === 'Baraka Garden')!.counter_code!;
    expect(await screen.findByText(formatBarCode(code))).toBeInTheDocument();
  });
});


import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { demoBars, demoStore, demoStoreName, seedNewDemoBar } from '../admin/bars';
import { applyAdminPull } from '../admin/server';
import type { AdminPull } from '../admin/server';
import { KauntaDB } from '../data/db';
import { LOUNGE_BAR_CODE, LOUNGE_BAR_ID, PRESET_SUPER_PASSWORD, addManager, membersOf, platform, resetPlatform } from './platform';

const user = userEvent.setup();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetPlatform();
});
afterEach(async () => {
  cleanup();
  await Promise.all(demoBars().map((b) => new KauntaDB(demoStoreName(b.id)).delete()));
  localStorage.clear();
  resetPlatform();
});

describe('Kaunta resets a bar to new (demo)', () => {
  it('after typing its name: records and everyone the owner added go; the bar, code and owner stay', async () => {
    const store = demoStore(LOUNGE_BAR_ID);
    await seedNewDemoBar(store, { id: LOUNGE_BAR_ID, name: 'Baraka Lounge', counter_code: LOUNGE_BAR_CODE });
    await store.products.put({ id: 'test_beer', category_id: 'beer', name: 'Test Beer', name_sw: null, stock_mode: 'count', stock_qty: 10, low_stock_at: null, manual_out_of_stock: false, archived_at: null, sort: 0 } as never);
    const added = await addManager(LOUNGE_BAR_ID, { name: 'Test Manager', username: 'testmgr', pin: '1234' });
    if ('error' in added) throw new Error(added.error);

    render(
      <MemoryRouter initialEntries={[`/super/bars/${LOUNGE_BAR_ID}`]}>
        <App config={null} />
      </MemoryRouter>,
    );
    await user.type(await screen.findByLabelText('Password'), PRESET_SUPER_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Reset bar…' }));
    const confirm = screen.getByRole('button', { name: 'Reset Baraka Lounge to new' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type the bar’s name to confirm/), 'Baraka');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Type the bar’s name to confirm/), ' lounge');
    await user.click(confirm);
    expect(await screen.findByText('Baraka Lounge has been reset. It opens as a new bar.')).toBeInTheDocument();

    const p = platform();
    expect(p.bars.find((b) => b.id === LOUNGE_BAR_ID)).toMatchObject({ name: 'Baraka Lounge', counter_code: LOUNGE_BAR_CODE });
    expect(membersOf(LOUNGE_BAR_ID).map((m) => m.role)).toEqual(['owner']);
    expect(p.accounts.some((a) => a.username === 'testmgr')).toBe(false);
    expect(await demoStore(LOUNGE_BAR_ID).products.count()).toBe(0);
  });
});

describe('a browser holding a bar that was reset', () => {
  const pull = (reset_at: string | null, extra: Partial<AdminPull> = {}): AdminPull =>
    ({ me: 'p_owner', cursor: '2026-11-19T10:00:00.000Z', server_time: '2026-11-19T10:00:00.000Z', bar: [{ id: 'bar_x', name: 'X', reset_at }], ...extra }) as unknown as AdminPull;

  it('drops what it has and pulls the bar again from the start', async () => {
    const db = new KauntaDB('kaunta-reset-pull');
    try {
      // First full pull: the reset is noted, nothing dropped.
      expect(await applyAdminPull(db, pull('2026-11-01T00:00:00+00:00', { products: [{ id: 'old' }] } as never))).toBe(true);
      expect(await db.products.count()).toBe(1);
      // A later pull says the bar was reset since: everything goes and the cursor is cleared.
      expect(await applyAdminPull(db, pull('2026-11-19T09:00:00+00:00'))).toBe(false);
      expect(await db.products.count()).toBe(0);
      expect(await db.bar.count()).toBe(0);
      expect(await db.meta.get('pull_cursor')).toBeUndefined();
      // The full pull that follows applies as normal.
      expect(await applyAdminPull(db, pull('2026-11-19T09:00:00+00:00', { products: [{ id: 'new' }] } as never))).toBe(true);
      expect((await db.products.toArray()).map((x) => x.id)).toEqual(['new']);
    } finally {
      await db.delete();
    }
  });
});

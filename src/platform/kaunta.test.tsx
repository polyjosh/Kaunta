import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { demoBars, demoStore, demoStoreName, rememberCounterBar } from '../admin/bars';
import { KAUNTA_ACTOR } from '../data/adminEvents';
import { KauntaDB } from '../data/db';
import { DEMO_MANAGER, DEMO_OWNER, PRESET_SUPER_PASSWORD, resetPlatform, SAMPLE_BAR_ID, setBarLimit, setBarSuspended } from './platform';

/**
 * The super admin (Kaunta): how many bars an owner may open, suspending a bar
 * (everyone attached loses access until it is given back), suspending staff in
 * a bar, opening a bar's admin with every owner tab, and staying out of the
 * logs owners and managers see.
 */

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
  sessionStorage.clear();
  resetPlatform();
});

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App config={null} />
    </MemoryRouter>,
  );

async function superSignIn(path = '/super/bars') {
  renderAt(path);
  await user.type(await screen.findByLabelText('Password'), PRESET_SUPER_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

async function ownerSignIn(username: string, secret: string) {
  await user.type(await screen.findByLabelText('Username'), username);
  await user.type(screen.getByLabelText('Password or PIN'), secret);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

/** Njeri opens on Baraka Lounge (first by name); the sample night is Baraka Pub. */
async function openPub() {
  const switcher = await screen.findByRole('button', { name: /: switch bar$/ });
  if (switcher.textContent!.includes('Baraka Pub')) return;
  await user.click(switcher);
  await user.click(within(screen.getByRole('group', { name: 'Your bars' })).getByRole('button', { name: /Baraka Pub/ }));
  await screen.findByRole('button', { name: 'Baraka Pub: switch bar' });
}

describe('Kaunta suspends a bar', () => {
  it('its owner, managers and counter lose access until access is given back', async () => {
    await superSignIn(`/super/bars/${SAMPLE_BAR_ID}`);
    const access = (await screen.findByRole('heading', { name: 'Access' })).closest('section')!;
    await user.click(within(access).getByRole('button', { name: 'Suspend bar' }));
    await user.click(within(access).getByRole('button', { name: 'Yes, suspend Baraka Pub' }));
    expect(await within(access).findByText(/Suspended since/)).toBeInTheDocument();
    cleanup();

    // The manager of only that bar: told why, no way in.
    renderAt('/admin');
    await ownerSignIn('chebet', DEMO_MANAGER.pin);
    expect(await screen.findByRole('heading', { name: 'Your bar is suspended' })).toBeInTheDocument();
    cleanup();

    // Its counter: nobody signs in.
    rememberCounterBar(SAMPLE_BAR_ID);
    renderAt('/counter/login');
    expect(await screen.findByRole('heading', { name: 'This bar is suspended' })).toBeInTheDocument();
    expect(screen.queryByText('Wanjiku')).not.toBeInTheDocument();
    cleanup();

    // Given back: the counter's staff list is there again.
    setBarSuspended(SAMPLE_BAR_ID, false);
    renderAt('/counter/login');
    expect(await screen.findByText('Wanjiku')).toBeInTheDocument();
  });
});

describe('Kaunta in a bar', () => {
  it('suspends a counter person as an owner would, and the owner’s log does not show who did it', async () => {
    await superSignIn(`/super/bars/${SAMPLE_BAR_ID}`);
    const staff = (await screen.findByRole('heading', { name: 'Staff at the counter' })).closest('section')!;
    const wanjiku = (await within(staff).findByText('Wanjiku', {}, { timeout: 5000 })).closest('li')!;
    await user.click(within(wanjiku).getByRole('button', { name: /^Suspend\s*· Wanjiku$/ }));
    await user.click(within(wanjiku).getByRole('button', { name: 'Yes, suspend Wanjiku' }));
    await waitFor(async () => expect((await demoStore(SAMPLE_BAR_ID).people.get('p_wanjiku'))?.suspended_at).toBeTruthy());
    const row = await demoStore(SAMPLE_BAR_ID).auditEvents.where('kind').equals('person_suspended').first();
    expect(row?.actor_id).toBe(KAUNTA_ACTOR);
    cleanup();

    // The owner: Wanjiku is suspended on Staff & devices…
    renderAt('/admin/staff');
    await ownerSignIn('njeri', DEMO_OWNER.password);
    await openPub();
    const suspended = (await screen.findByRole('heading', { name: 'Suspended' })).closest('section')!;
    expect(within(suspended).getByText(/Wanjiku/)).toBeInTheDocument();
    // …but the log does not say Kaunta did it, on any day.
    await user.click(screen.getByRole('link', { name: 'Audit log' }));
    await user.selectOptions(await screen.findByLabelText('Day'), 'All days');
    await waitFor(() => expect(document.querySelector('.a-audit-foot')?.textContent).toMatch(/^Showing \d+ of \d+ events,/));
    expect([...document.querySelectorAll('.a-audit-who')].some((w) => w.textContent!.startsWith('Kaunta'))).toBe(false);
  });

  it('opens a bar’s admin with every owner tab; its changes are hidden from owners but not from Kaunta', async () => {
    await superSignIn(`/super/bars/${SAMPLE_BAR_ID}`);
    await user.click(await screen.findByRole('button', { name: "Open this bar's admin" }));
    expect(await screen.findByText(/You are in this bar as Kaunta/)).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: /menu/i });
    for (const tab of ['Today', 'Sales', 'Approvals', 'Reconcile', 'Products', 'Stock', 'Kegs', 'Staff & devices', 'Audit log']) {
      expect(within(nav).getByRole('link', { name: new RegExp(`^${tab}`) })).toBeInTheDocument();
    }
    // Kaunta changes a staff PIN here: in Kaunta's view of the log.
    await user.click(within(nav).getByRole('link', { name: 'Staff & devices' }));
    const row = (await screen.findByRole('rowheader', { name: /Otieno/ })).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: /Change PIN/ }));
    const input = await screen.findByLabelText('New PIN for Otieno');
    await user.clear(input);
    await user.type(input, '1122');
    await user.click(screen.getByRole('button', { name: 'Save PIN' }));
    await waitFor(async () => expect((await demoStore(SAMPLE_BAR_ID).people.get('p_otieno'))?.pin_code).toBe('1122'));
    await user.click(within(screen.getByRole('navigation', { name: /menu/i })).getByRole('link', { name: 'Audit log' }));
    await waitFor(() => expect([...document.querySelectorAll('.a-audit-who')].some((w) => w.textContent!.startsWith('Kaunta'))).toBe(true));

    // Back to Kaunta, then the owner: the same change, without Kaunta in the log.
    await user.click(screen.getAllByRole('button', { name: 'Back to Kaunta' })[0]!);
    cleanup();
    renderAt('/admin/audit');
    await ownerSignIn('njeri', DEMO_OWNER.password);
    await openPub();
    expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    // Every day, so Kaunta's change (made on another day's clock) would be there if it were shown.
    await user.selectOptions(screen.getByLabelText('Day'), 'All days');
    await waitFor(() => expect(document.querySelector('.a-audit-foot')?.textContent).toMatch(/^Showing \d+ of \d+ events,/));
    expect([...document.querySelectorAll('.a-audit-who')].some((w) => w.textContent!.startsWith('Kaunta'))).toBe(false);
    expect(screen.queryByText(/You are in this bar as Kaunta/)).not.toBeInTheDocument();
  });
});

describe('Kaunta sets how many bars an owner may open', () => {
  it('on Owners & managers; the owner at the limit is told to ask Kaunta', async () => {
    await superSignIn('/super/owners');
    const row = (await screen.findByRole('rowheader', { name: 'Njeri' })).closest('tr')!;
    expect(within(row).getByText('2 of 3')).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /^Change\s*· Njeri$/ }));
    const field = within(row).getByLabelText('Bars Njeri can own');
    await user.clear(field);
    await user.type(field, '2');
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByText('2 of 2')).toBeInTheDocument();
    cleanup();

    renderAt('/admin');
    await ownerSignIn('njeri', DEMO_OWNER.password);
    await user.click(await screen.findByRole('button', { name: /: switch bar$/ }));
    const menu = screen.getByRole('group', { name: 'Your bars' });
    expect(within(menu).getByText(/as many bars as your plan allows \(2\)/)).toBeInTheDocument();
    expect(within(menu).queryByRole('button', { name: 'Add a bar' })).not.toBeInTheDocument();
    setBarLimit(DEMO_OWNER.id, 3);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { demoBars, demoStoreName } from '../admin/bars';
import { KauntaDB } from '../data/db';
import { DEMO_MANAGER, DEMO_OWNER, PRESET_SUPER_PASSWORD, resetPlatform } from './platform';

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

async function ownerSignIn(username: string, secret: string) {
  await user.type(await screen.findByLabelText('Username'), username);
  await user.type(screen.getByLabelText('Password or PIN'), secret);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('owner or manager sign in (demo)', () => {
  it('asks for a username and password (or PIN) first, then shows that person’s bars', async () => {
    renderAt('/admin');
    expect(await screen.findByRole('heading', { name: 'Sign in to run your bars' })).toBeInTheDocument();
    await ownerSignIn('njeri', 'not-it');
    expect(await screen.findByRole('alert')).toHaveTextContent('That username, password or PIN is not right. 4 tries left');
    await user.clear(screen.getByLabelText('Username'));
    await ownerSignIn('njeri', DEMO_OWNER.password);
    // Her bars, in the switcher.
    const switcher = await screen.findByRole('button', { name: /: switch bar$/ });
    await user.click(switcher);
    const menu = screen.getByRole('group', { name: 'Your bars' });
    expect(within(menu).getAllByRole('listitem').map((li) => li.querySelector('.a-bars-item-name')!.textContent)).toEqual(['Baraka Lounge', 'Baraka Pub']);
    expect(within(menu).getByRole('button', { name: 'Add a bar' })).toBeInTheDocument();
  });

  it('a manager sees only the bar they manage, and cannot start bars', async () => {
    renderAt('/admin');
    await ownerSignIn('chebet', DEMO_MANAGER.pin);
    expect(await screen.findByText('KES 86,450')).toBeInTheDocument();
    // One bar, no right to start another: just the name, no switcher.
    expect(screen.queryByRole('button', { name: /switch bar/ })).not.toBeInTheDocument();
    expect(screen.getByText('Baraka Pub')).toBeInTheDocument();
  });

  it('suggests changing the PIN Kaunta set, and changes it', async () => {
    renderAt('/admin');
    await ownerSignIn('chebet', DEMO_MANAGER.pin);
    const reminder = await screen.findByText('Kaunta set your PIN. Change it to one only you know.');
    await user.click(within(reminder.closest('div')!).getByRole('link', { name: 'Change my PIN' }));
    await user.type(await screen.findByLabelText('Current PIN'), DEMO_MANAGER.pin);
    await user.type(screen.getByLabelText('New PIN (4 digits)'), '9081');
    await user.type(screen.getByLabelText('New PIN again'), '9081');
    await user.click(screen.getByRole('button', { name: 'Save new PIN' }));
    expect(await screen.findByText('Your PIN is changed. Use it next time you sign in, here or at the counter.')).toBeInTheDocument();
    expect(screen.queryByText('Kaunta set your PIN. Change it to one only you know.')).not.toBeInTheDocument();
  });
});

describe('the Kaunta platform (super admin)', () => {
  it('opens with the preset password and shows every bar', async () => {
    renderAt('/super');
    expect(await screen.findByRole('heading', { name: 'Kaunta platform' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That password is not right.');
    await user.type(screen.getByLabelText('Password'), PRESET_SUPER_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'All bars' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('link', { name: 'Baraka Pub' })).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Baraka Lounge' })).toBeInTheDocument();
    expect(within(table).getByText('BRKA-PUB2')).toBeInTheDocument();
    // The sample night's numbers come from the pub's own data.
    expect(await within(table).findByText('KES 86,450')).toBeInTheDocument();
  });

  it('creates an owner with a first bar and its code; the owner signs in and sees only that bar', async () => {
    localStorage.setItem('kaunta.superSession', 'yes');
    renderAt('/super/owners/new');
    await user.type(await screen.findByLabelText('Owner’s name'), 'Amina');
    await user.type(screen.getByLabelText('Username'), 'amina');
    await user.type(screen.getByLabelText('Password'), 'amina-2026');
    await user.type(screen.getByLabelText('First bar’s name'), 'Kilimani Lounge');
    const code = screen.getByLabelText('Bar code for counter phones');
    await user.type(code, 'brka-pub2');
    expect(screen.getByText('Another bar already has that code.')).toBeInTheDocument();
    await user.clear(code);
    await user.type(code, 'kilimani');
    expect(screen.getByText('No other bar has this code.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create owner and bar' }));

    expect(await screen.findByRole('heading', { name: 'Amina can start' })).toBeInTheDocument();
    expect(screen.getByText('amina')).toBeInTheDocument();
    expect(screen.getByText('amina-2026')).toBeInTheDocument();
    expect(screen.getByText('KILI-MANI')).toBeInTheDocument();
    cleanup();

    // Amina at Owner or manager sign in.
    renderAt('/admin');
    await ownerSignIn('amina', 'amina-2026');
    expect(await screen.findByRole('heading', { name: 'No products yet' })).toBeInTheDocument();
    expect(await screen.findByText('KILI-MANI')).toBeInTheDocument();
    // Her one bar; she owns it, so she may start more.
    await user.click(screen.getByRole('button', { name: 'Kilimani Lounge: switch bar' }));
    const menu = screen.getByRole('group', { name: 'Your bars' });
    expect(within(menu).getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows a bar’s counter PINs and sets a new one, logged as Kaunta', async () => {
    localStorage.setItem('kaunta.superSession', 'yes');
    renderAt('/super/bars/bar_baraka');
    const staff = (await screen.findByRole('heading', { name: 'Staff at the counter' })).closest('section')!;
    const wanjiku = (await within(staff).findByText('Wanjiku')).closest('li')!;
    expect(within(wanjiku).getByText('••••')).toBeInTheDocument();
    await user.click(within(wanjiku).getByRole('button', { name: /^Show/ }));
    expect(within(wanjiku).getByText('2580')).toBeInTheDocument();
    await user.click(within(wanjiku).getByRole('button', { name: /^Change PIN/ }));
    const input = within(wanjiku).getByLabelText('New PIN for Wanjiku');
    await user.clear(input);
    await user.type(input, '7531');
    await user.click(within(wanjiku).getByRole('button', { name: 'Save PIN' }));
    expect(await within(wanjiku).findByText('7531')).toBeInTheDocument();
    expect(await screen.findByText('PIN changed · Wanjiku')).toBeInTheDocument();
  });

  it('changes the platform password', async () => {
    localStorage.setItem('kaunta.superSession', 'yes');
    renderAt('/super/settings');
    expect(await screen.findByText('The preset password is still in use. Change it now.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Current password'), PRESET_SUPER_PASSWORD);
    await user.type(screen.getByLabelText('New password'), 'karibu-sana-2026');
    await user.type(screen.getByLabelText('New password again'), 'karibu-sana-2026');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Password changed. Use it next time you sign in.')).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { demoBarByCode, demoDirectory, demoStore, rememberCounterBar } from '../admin/bars';
import { db as sampleCounterDb } from '../data/db';
import { canonicalBarCode, formatBarCode, isBarCode, isChoosableBarCode, isPairingCode, makeBarCode, normaliseBarCode } from '../domain/barCode';
import { resetPlatform } from '../platform/platform';

const user = userEvent.setup();

beforeEach(() => {
  localStorage.clear();
  resetPlatform();
});
afterEach(async () => {
  // Unmount before the stores go, so nothing reads a deleted store.
  cleanup();
  localStorage.clear();
  resetPlatform();
  await sampleCounterDb.delete();
  await sampleCounterDb.open();
});

const renderCounter = () =>
  render(
    <MemoryRouter initialEntries={['/counter/login']}>
      <App config={null} />
    </MemoryRouter>,
  );

const enter = async (code: string) => {
  const input = await screen.findByLabelText('Bar code');
  await user.clear(input);
  await user.type(input, code);
  await user.click(screen.getByRole('button', { name: 'Open the counter' }));
};

describe('bar codes', () => {
  it('read the same however they are typed, and avoid look-alike characters', () => {
    expect(normaliseBarCode(' brka-pub2 ')).toBe('BRKAPUB2');
    expect(formatBarCode('brkapub2')).toBe('BRKA-PUB2');
    expect(isBarCode('BRKA-PUB2')).toBe(true);
    expect(isBarCode('ABC12')).toBe(false); // too short
    expect(isBarCode('ABCDEFGHJKMNP')).toBe(false); // too long
    // Look-alikes are one code: O and 0, I, L and 1.
    expect(canonicalBarCode('baraka-o1')).toBe(canonicalBarCode('BARAKA01'));
    expect(canonicalBarCode('PUBLI')).toBe('PUB11');
    expect(isChoosableBarCode('123456')).toBe(false); // a pairing code's shape
    expect(isPairingCode('482 913')).toBe(true);
    for (let i = 0; i < 50; i++) expect(isBarCode(makeBarCode())).toBe(true);
  });
});

describe('Open the counter, without a server (demo)', () => {
  it('asks for the bar code, and the sample bar’s code opens its counter', async () => {
    renderCounter();
    expect(await screen.findByRole('heading', { name: 'Which bar is this counter for?' })).toBeInTheDocument();
    expect(screen.getByText(/Baraka Pub’s code is BRKA-PUB2/)).toBeInTheDocument();
    await enter('ZZZZ-ZZZZ');
    expect(await screen.findByRole('alert')).toHaveTextContent('That code doesn’t match a bar.');
    await enter('brka-pub2');
    expect(await screen.findByRole('heading', { name: 'Who is at the counter?' })).toBeInTheDocument();
    expect(await screen.findByText('Baraka Pub')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Wanjiku' })).toBeInTheDocument();
  });

  it('remembers the bar on this browser, and can be set to another bar', async () => {
    rememberCounterBar('bar_baraka');
    renderCounter();
    expect(await screen.findByRole('heading', { name: 'Who is at the counter?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use this phone for another bar' }));
    expect(await screen.findByRole('heading', { name: 'Which bar is this counter for?' })).toBeInTheDocument();
  });

  it('a bar the owner added opens its own store, shared with admin: only its owner until staff are added', async () => {
    const bar = await demoDirectory.create('Baraka Garden');
    expect(demoBarByCode(bar.counter_code!)?.id).toBe(bar.id);
    renderCounter();
    await enter(formatBarCode(bar.counter_code!));
    expect(await screen.findByText('Baraka Garden')).toBeInTheDocument();
    const tiles = async () => (await screen.findAllByRole('button', { name: /Njeri/ })).filter((b) => b.classList.contains('c-staff-tile'));
    expect((await tiles())[0]).toHaveTextContent('Owner');
    expect(screen.queryByText(/No one can log in here yet/)).toBeNull();
    // The same store admin opens for that bar.
    expect((await demoStore(bar.id).bar.get(bar.id))?.counter_code).toBe(bar.counter_code);
    await demoStore(bar.id).delete();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import tokens from '../../kaunta-handoff/design/tokens.json';
import { I18nProvider } from '../lib/I18nProvider';
import type { Locale } from '../lib/i18n';
import { STATUS, StatusChip } from './StatusChip';
import type { Status } from './StatusChip';
import { SYNC, SyncPill } from './SyncPill';
import type { SyncState } from '../lib/sync';

const wrap = (ui: React.ReactNode, locale: Locale = 'en') =>
  render(<I18nProvider initialLocale={locale}>{ui}</I18nProvider>);

// tokens.json uses snake_case status ids; the app uses the camelCase of the i18n keys.
const TOKEN_ID: Partial<Record<Status, keyof typeof tokens.status>> = {
  paid: 'paid',
  pending: 'pending',
  partPaid: 'part_paid',
  voided: 'voided',
  writtenOff: 'written_off',
  outOfStock: 'out_of_stock',
  offline: 'offline',
  needsReview: 'needs_review',
  short: 'short',
};

describe('StatusChip', () => {
  const statuses = Object.keys(STATUS) as Status[];

  it.each(statuses)('%s has a colour tone, an icon and a label', (status) => {
    const { container } = wrap(<StatusChip status={status} />);
    const chip = container.querySelector('.k-chip')!;
    expect(chip.className).toMatch(/k-tone-/);
    expect(chip.querySelector('svg[aria-hidden="true"] path')?.getAttribute('d')).toBeTruthy();
    expect(chip.textContent?.trim()).not.toBe('');
  });

  it.each(Object.entries(TOKEN_ID))('%s matches the icon and labels in tokens.json', (status, tokenId) => {
    const spec = tokens.status[tokenId];
    for (const locale of ['en', 'sw'] as const) {
      const { container, unmount } = wrap(<StatusChip status={status as Status} />, locale);
      expect(container.querySelector('svg')?.dataset.icon).toBe(spec.icon);
      expect(screen.getByText(spec[locale])).toBeInTheDocument();
      unmount();
    }
  });

  it('never uses ember as a status colour', () => {
    for (const { tone } of Object.values(STATUS)) expect(tone).not.toMatch(/ember/);
  });

  it('can carry detail text while keeping its icon', () => {
    const { container } = wrap(<StatusChip status="pending">12 min</StatusChip>);
    expect(screen.getByText('12 min')).toBeInTheDocument();
    expect(container.querySelector('svg')?.dataset.icon).toBe('clock');
  });
});

describe('SyncPill', () => {
  const cases: [SyncState, number, string, string][] = [
    ['synced', 0, 'Synced', 'Imesawazishwa'],
    ['waiting', 3, '3 waiting', '3 zinasubiri'],
    ['sending', 3, 'Sending 3…', 'Inatuma 3…'],
    ['offline', 3, 'Offline · 3 saved', 'Nje ya mtandao · 3'],
    ['needsAdmin', 1, '1 needs admin', '1 inahitaji msimamizi'],
  ];

  it.each(cases)('%s reads as designed in both languages', (state, count, en, sw) => {
    const first = wrap(<SyncPill state={state} count={count} />, 'en');
    expect(screen.getByRole('button', { name: en })).toBeInTheDocument();
    first.unmount();
    wrap(<SyncPill state={state} count={count} />, 'sw');
    expect(screen.getByRole('button', { name: sw })).toBeInTheDocument();
  });

  it('is never red', () => {
    for (const { tone } of Object.values(SYNC)) expect(tone).not.toBe('error');
  });

  it('is grey when offline and yellow only when an admin is needed', () => {
    expect(SYNC.offline.tone).toBe('offline');
    expect(SYNC.needsAdmin.tone).toBe('warning');
  });

  it('opens the sync screen when tapped', async () => {
    const onClick = vi.fn();
    wrap(<SyncPill state="waiting" count={3} onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: '3 waiting' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

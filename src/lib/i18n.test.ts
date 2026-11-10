import { describe, expect, it } from 'vitest';
import { loadLocale, messages, saveLocale, translate } from './i18n';
import type { MessageKey } from './i18n';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('string files', () => {
  const enKeys = Object.keys(messages.en).sort();
  const swKeys = Object.keys(messages.sw).sort();

  it('have the same keys in English and Kiswahili', () => {
    expect(swKeys).toEqual(enKeys);
  });

  it('have no empty strings', () => {
    for (const locale of ['en', 'sw'] as const) {
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('use the same {placeholders} in both languages', () => {
    for (const key of enKeys) {
      expect(placeholders(messages.sw[key]!), key).toEqual(placeholders(messages.en[key]!));
    }
  });

  it('give every plural key both forms', () => {
    for (const key of enKeys) {
      const match = /^(.*)_(one|other)$/.exec(key);
      if (!match) continue;
      const other = `${match[1]}_${match[2] === 'one' ? 'other' : 'one'}`;
      expect(enKeys, `${key} needs ${other}`).toContain(other);
    }
  });
});

describe('translate', () => {
  it('returns the string for the locale', () => {
    expect(translate('en', 'status.paid')).toBe('Paid');
    expect(translate('sw', 'status.paid')).toBe('Imelipwa');
  });

  it('fills {placeholders}', () => {
    expect(translate('en', 'sync.offline', { count: 3 })).toBe('Offline · 3 saved');
    expect(translate('sw', 'sync.waiting', { count: 3 })).toBe('3 zinasubiri');
    expect(translate('en', 'orders.paidOf', { paid: 'KES 400', total: '1,250' })).toBe('KES 400 of 1,250 paid');
  });

  it('leaves a placeholder visible when its value is missing', () => {
    expect(translate('en', 'common.recordedBy', {})).toBe('Recorded by {name}');
  });

  it('picks _one / _other from count', () => {
    expect(translate('en', 'common.items', { count: 1 })).toBe('1 item');
    expect(translate('en', 'common.items', { count: 3 })).toBe('3 items');
    expect(translate('en', 'common.items', { count: 0 })).toBe('0 items');
    expect(translate('sw', 'common.items', { count: 1 })).toBe('Kitu 1');
    expect(translate('sw', 'common.items', { count: 3 })).toBe('Vitu 3');
    expect(translate('en', 'login.wrongPin', { count: 1 })).toBe('Wrong PIN · 1 try left');
    expect(translate('en', 'login.wrongPin', { count: 4 })).toBe('Wrong PIN · 4 tries left');
  });

  it('uses the plain key when a counted string has no plural forms', () => {
    expect(translate('en', 'common.minutes', { count: 1 })).toBe('1 min');
  });

  it('falls back to the key so a missing string is visible', () => {
    expect(translate('sw', 'no.such.key' as MessageKey)).toBe('no.such.key');
  });
});

describe('locale preference', () => {
  it('defaults to English and remembers a choice', () => {
    expect(loadLocale()).toBe('en');
    saveLocale('sw');
    expect(loadLocale()).toBe('sw');
  });

  it('ignores a stored value that is not a locale', () => {
    localStorage.setItem('kaunta.locale', 'fr');
    expect(loadLocale()).toBe('en');
  });
});

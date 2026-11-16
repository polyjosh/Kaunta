import en from '../../kaunta-handoff/i18n/en.json';
import sw from '../../kaunta-handoff/i18n/sw.json';
// Strings the screens need that the handoff files do not have yet (the designs
// show them as fixed English text). Same rules: same keys and placeholders in
// both files. To be folded into the handoff files once the product owner agrees.
import extraEn from '../i18n/extra.en.json';
import extraSw from '../i18n/extra.sw.json';
// Admin screens (build step 5): copy the designs show that the handoff files lack.
import adminEn from '../i18n/admin.en.json';
import adminSw from '../i18n/admin.sw.json';
// The Kaunta platform (super admin) screens.
import superEn from '../i18n/super.en.json';
import superSw from '../i18n/super.sw.json';

export type Locale = 'en' | 'sw';
export const LOCALES: readonly Locale[] = ['en', 'sw'];
export const DEFAULT_LOCALE: Locale = 'en';

type RawKey = keyof typeof en | keyof typeof extraEn | keyof typeof adminEn | keyof typeof superEn;
type StripPlural<K extends string> = K extends `${infer Base}_one`
  ? Base
  : K extends `${infer Base}_other`
    ? Base
    : K;

/** Every key in the string files; plural keys are addressed without their `_one` / `_other` suffix. */
export type MessageKey = StripPlural<RawKey>;
export type MessageParams = Record<string, string | number>;

export const messages: Record<Locale, Record<string, string>> = {
  en: { ...en, ...extraEn, ...adminEn, ...superEn },
  sw: { ...sw, ...extraSw, ...adminSw, ...superSw },
};

const pluralRules: Record<Locale, Intl.PluralRules> = {
  en: new Intl.PluralRules('en'),
  sw: new Intl.PluralRules('sw'),
};

function lookup(locale: Locale, key: string): string | undefined {
  return messages[locale][key] ?? messages[DEFAULT_LOCALE][key];
}

/**
 * Flat dot-path keys, `{name}` placeholders, and `_one` / `_other` plural
 * forms chosen by a numeric `count` param. Falls back to English, then to the
 * key itself, so a missing string is visible rather than blank.
 */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  let template: string | undefined;
  const count = params?.count;
  if (typeof count === 'number') {
    const form = pluralRules[locale].select(count) === 'one' ? 'one' : 'other';
    template = lookup(locale, `${key}_${form}`);
  }
  template ??= lookup(locale, key) ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

const STORAGE_KEY = 'kaunta.locale';

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'sw';
}

export function loadLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage can be unavailable (private mode); fall through to the default.
  }
  return DEFAULT_LOCALE;
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Not being able to remember the language must never block the counter.
  }
}

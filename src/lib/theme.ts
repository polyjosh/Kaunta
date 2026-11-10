export type Theme = 'night' | 'day';

const STORAGE_KEY = 'kaunta.adminTheme';

export function isTheme(value: unknown): value is Theme {
  return value === 'night' || value === 'day';
}

/**
 * Counter routes are always Counter Night (readable in a dark bar).
 * Admin defaults to Day and may be switched to Night by the user.
 */
export function themeForPath(pathname: string, adminTheme: Theme = 'day'): Theme {
  return pathname === '/admin' || pathname.startsWith('/admin/') ? adminTheme : 'night';
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
}

export function loadAdminTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Storage unavailable: use the default.
  }
  return 'day';
}

export function saveAdminTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Preference only; safe to drop.
  }
}

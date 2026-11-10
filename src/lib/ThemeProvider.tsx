import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { applyTheme, loadAdminTheme, saveAdminTheme, themeForPath } from './theme';
import type { Theme } from './theme';

interface ThemeValue {
  /** The theme in effect on the current route. */
  theme: Theme;
  /** The admin's own preference; ignored on counter routes. */
  adminTheme: Theme;
  setAdminTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

/** Keeps `<html data-theme>` in step with the route. Must sit inside a Router. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [adminTheme, setAdminThemeState] = useState<Theme>(loadAdminTheme);
  const theme = themeForPath(pathname, adminTheme);

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setAdminTheme = useCallback((next: Theme) => {
    saveAdminTheme(next);
    setAdminThemeState(next);
  }, []);

  const value = useMemo(() => ({ theme, adminTheme, setAdminTheme }), [theme, adminTheme, setAdminTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}

import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { applyTheme, loadAdminTheme, saveAdminTheme, themeForPath } from './theme';
import { ThemeProvider, useTheme } from './ThemeProvider';

describe('themeForPath', () => {
  it('forces Night on counter routes, whatever the admin preference', () => {
    expect(themeForPath('/counter/sell')).toBe('night');
    expect(themeForPath('/counter/sell', 'day')).toBe('night');
    expect(themeForPath('/')).toBe('night');
  });

  it('defaults admin routes to Day and honours the toggle', () => {
    expect(themeForPath('/admin')).toBe('day');
    expect(themeForPath('/admin/approvals')).toBe('day');
    expect(themeForPath('/admin/approvals', 'night')).toBe('night');
  });

  it('does not treat look-alike paths as admin', () => {
    expect(themeForPath('/administrator', 'day')).toBe('night');
  });
});

describe('admin theme preference', () => {
  it('defaults to Day and remembers a choice', () => {
    expect(loadAdminTheme()).toBe('day');
    saveAdminTheme('night');
    expect(loadAdminTheme()).toBe('night');
  });
});

describe('applyTheme', () => {
  it('sets data-theme on <html>', () => {
    applyTheme('day');
    expect(document.documentElement.dataset.theme).toBe('day');
  });
});

function Probe() {
  const { theme, setAdminTheme } = useTheme();
  const navigate = useNavigate();
  return (
    <>
      <output>{theme}</output>
      <button onClick={() => navigate('/admin')}>admin</button>
      <button onClick={() => navigate('/counter/sell')}>counter</button>
      <button onClick={() => setAdminTheme('night')}>night</button>
      <button onClick={() => setAdminTheme('day')}>day</button>
    </>
  );
}

describe('ThemeProvider', () => {
  it('switches <html data-theme> with the route and the admin toggle', () => {
    render(
      <MemoryRouter initialEntries={['/counter/sell']}>
        <ThemeProvider>
          <Probe />
        </ThemeProvider>
      </MemoryRouter>,
    );
    const html = document.documentElement;
    expect(html.dataset.theme).toBe('night');

    act(() => screen.getByText('admin').click());
    expect(html.dataset.theme).toBe('day');

    act(() => screen.getByText('night').click());
    expect(html.dataset.theme).toBe('night');

    act(() => screen.getByText('day').click());
    act(() => screen.getByText('counter').click());
    expect(html.dataset.theme).toBe('night');
    expect(loadAdminTheme()).toBe('day');
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../lib/I18nProvider';
import { ThemeProvider } from '../lib/ThemeProvider';
import { Landing } from './Landing';

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider initialLocale="en">
        <ThemeProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/counter/login" element={<p>counter</p>} />
            <Route path="/admin" element={<p>admin</p>} />
          </Routes>
        </ThemeProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe('landing', () => {
  it('shows the logo with its tagline and the promise, on Counter Night', () => {
    renderLanding();
    const logo = screen.getByRole('img', { name: 'Kaunta · Till · Cash · Shelf' });
    expect(logo).toHaveAttribute('src', '/brand/lockup-stacked-dark.svg');
    expect(screen.getByRole('heading', { level: 1 })).toContainElement(logo);
    expect(screen.getByText('Kaunta shows you when your till, your cash, and your shelf don’t agree.')).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('night');
  });

  it('offers the two ways in', async () => {
    renderLanding();
    expect(screen.getByRole('link', { name: /Open the counter/ })).toHaveAttribute('href', '/counter/login');
    await userEvent.setup().click(screen.getByRole('link', { name: /Owner or manager sign in/ }));
    expect(screen.getByText('admin')).toBeInTheDocument();
  });

  it('reads in Kiswahili', async () => {
    renderLanding();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Kiswahili' }));
    expect(screen.getByRole('link', { name: /Fungua kaunta/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Mmiliki au meneja: ingia/ })).toBeInTheDocument();
  });
});

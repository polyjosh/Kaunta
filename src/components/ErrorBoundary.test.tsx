import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '../lib/I18nProvider';
import { ScreenErrorBoundary } from './ErrorBoundary';

function Broken(): never {
  throw new Error('Invalid time value');
}

describe('a screen that fails', () => {
  it('shows what went wrong and a way back, instead of a blank page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <MemoryRouter initialEntries={['/counter/shift/close']}>
        <I18nProvider initialLocale="en">
          <ScreenErrorBoundary home="/counter/sell">
            <Routes>
              <Route path="/counter/shift/close" element={<Broken />} />
              <Route path="/counter/sell" element={<p>sell screen</p>} />
            </Routes>
          </ScreenErrorBoundary>
        </I18nProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('Something went wrong on this screen')).toBeInTheDocument();
    expect(screen.getByText('Invalid time value')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to selling' }));
    expect(await screen.findByText('sell screen')).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});

import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// The admin screens read a full sample day from IndexedDB on first render; under a
// full parallel run that can take longer than the default 1s for findBy queries.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  // Database tests run in the node environment, without a DOM.
  if (typeof document === 'undefined') return;
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

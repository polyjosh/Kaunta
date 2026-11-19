import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const seed = JSON.parse(readFileSync(new URL('../kaunta-handoff/data/seed.json', import.meta.url), 'utf8')) as {
  people: { name: string; demo_pin?: string }[];
};
const demo = seed.people.find((p) => p.demo_pin)!;

// The counter snapshot in the designs: 22:20 Nairobi on business day 10 Nov 2026.
// The clock is fixed; timers still run.
const NOW = new Date('2026-11-10T19:20:00.000Z');

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  // This browser has already joined the sample bar (its code, BRKA-PUB2, is typed in e2e/fullLoop.spec.ts).
  await page.addInitScript(() => {
    if (!localStorage.getItem('kaunta.counterBar')) localStorage.setItem('kaunta.counterBar', JSON.stringify('bar_baraka'));
  });
});

async function login(page: Page) {
  await page.goto('/counter/login');
  await page.getByRole('button', { name: demo.name }).click();
  for (const digit of demo.demo_pin!) await page.getByRole('button', { name: digit, exact: true }).click();
  await expect(page.getByRole('button', { name: /Record \(pay later\)|Rekodi \(lipa baadaye\)/ })).toBeVisible();
}

/** Counts every tap on a button from now on. */
async function countTaps(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __taps: number };
    w.__taps = 0;
    document.addEventListener('click', (e) => {
      if ((e.target as Element).closest('button')) w.__taps += 1;
    }, true);
  });
  return () => page.evaluate(() => (window as unknown as { __taps: number }).__taps);
}

/** Client-side navigation, so the in-memory login survives (a reload asks for the PIN again). */
async function goTo(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('a pay-later sale takes 2 taps', async ({ page }) => {
  await login(page);
  const taps = await countTaps(page);
  await page.getByRole('button', { name: 'Tusker Lager' }).tap();
  await page.getByRole('button', { name: 'Record (pay later)' }).tap();

  await expect(page.getByText('Order #049 recorded · No table · pay later')).toBeVisible();
  expect(await taps()).toBe(2);
  await expect(page.getByRole('button', { name: 'Open orders · 6' })).toBeVisible();
});

test('a paid sale takes 3 taps', async ({ page }) => {
  await login(page);
  const taps = await countTaps(page);
  await page.getByRole('button', { name: 'Guinness', exact: true }).tap();
  await page.getByRole('button', { name: 'Record & paid' }).tap();
  await page.getByRole('button', { name: 'M-Pesa' }).tap();

  await expect(page.getByText('Order #049 recorded · paid by M-Pesa')).toBeVisible();
  expect(await taps()).toBe(3);
  await expect(page.getByRole('button', { name: 'Open orders · 5' })).toBeVisible();
});

test('selling works with the network off, and nothing is lost', async ({ page, context }) => {
  await login(page);
  await context.setOffline(true);
  await expect(page.getByRole('button', { name: /^Offline · \d+ saved$/ })).toBeVisible();

  await page.getByRole('button', { name: 'Tusker Lager' }).tap();
  await page.getByRole('button', { name: 'Record (pay later)' }).tap();
  await expect(page.getByText('Order #049 recorded · No table · pay later')).toBeVisible();
  await expect(page.getByText('Saved on this phone. It will sync when the internet is back.')).toBeVisible();

  await page.getByRole('button', { name: 'White Cap' }).tap();
  await page.getByRole('button', { name: 'Record & paid' }).tap();
  await page.getByRole('button', { name: 'Cash' }).tap();
  await expect(page.getByText('Order #050 recorded · paid by cash')).toBeVisible();

  // Nothing about being offline is red.
  expect(await page.locator('.k-tone-error, .is-void').count()).toBe(0);

  // Back online: the queue is still there, and survives a reload of the app.
  await context.setOffline(false);
  await expect(page.getByRole('button', { name: /^\d+ waiting$/ })).toBeVisible();
  await page.reload();
  await login(page);
  await page.getByRole('button', { name: 'Open orders · 6' }).tap();
  await expect(page.getByText('6 open · still to collect')).toBeVisible();
  await expect(page.getByRole('link', { name: /#049/ })).toBeVisible();
  await goTo(page, '/counter/sync');
  await expect(page.getByText('Order #049 · No table')).toBeVisible();
  await expect(page.getByText('Order #050 · No table')).toBeVisible();
});

test('R-SYNC-4 the app starts, logs in and sells with no network at all', async ({ page, context }) => {
  await page.goto('/counter/login');
  // Wait until the service worker has cached the app and controls the page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });

  await context.setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: demo.name }).click();
  for (const digit of demo.demo_pin!) await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Tusker Lager' }).tap();
  await page.getByRole('button', { name: 'Record (pay later)' }).tap();
  await expect(page.getByText('Order #049 recorded · No table · pay later')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Offline · \d+ saved$/ })).toBeVisible();
  // The font came from the cache too, not a fallback.
  expect(await page.evaluate(() => document.fonts.check('800 17px Manrope'))).toBe(true);
});

test('every counter screen fits a 360px phone without sideways scrolling', async ({ page }) => {
  await login(page);
  for (const path of [
    '/counter/sell',
    '/counter/orders',
    '/counter/orders/o_044',
    '/counter/orders/o_044/void',
    '/counter/shift/close',
    '/counter/sync',
  ]) {
    await goTo(page, path);
    await expect(page.locator('.c-topbar')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
});

test('touch targets meet the sizes in the design rules', async ({ page }) => {
  await page.goto('/counter/login');
  await page.getByRole('button', { name: demo.name }).click();
  const pinKey = await page.getByRole('button', { name: '5', exact: true }).boundingBox();
  expect(pinKey!.height).toBe(72);

  await login(page);
  for (const name of ['Record (pay later)', 'Record & paid']) {
    expect((await page.getByRole('button', { name }).boundingBox())!.height, name).toBeGreaterThanOrEqual(64);
  }
  // Everything else tappable is at least 44px tall and wide. Some controls are drawn smaller than
  // 48 as in the designs (sync pill 40, chips and tabs 44) and stretch their tap area with ::before.
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('button:not([disabled])')]
      .map((b) => {
        const box = b.getBoundingClientRect();
        const before = getComputedStyle(b, '::before');
        const stretch = before.content !== 'none' && before.position === 'absolute' ? -2 * parseFloat(before.top || '0') : 0;
        return { label: b.getAttribute('aria-label') ?? b.textContent, width: box.width, tapHeight: box.height + Math.max(0, stretch) };
      })
      .filter((b) => b.width > 0 && (b.tapHeight < 44 || b.width < 44)),
  );
  expect(small).toEqual([]);
  const pillTap = () =>
    page.locator('.k-sync-pill').evaluate((el) => el.getBoundingClientRect().height - 2 * parseFloat(getComputedStyle(el, '::before').top));
  expect(await pillTap()).toBe(48);
  // The smaller pill on inner screens (36px drawn) keeps the same tap area.
  await page.getByRole('button', { name: /^Open orders/ }).tap();
  await expect(page.locator('.c-topbar.is-compact')).toBeVisible();
  expect(await pillTap()).toBe(48);
});

test('Kiswahili fits: buttons wrap instead of cutting words off', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('kaunta.locale', 'sw'));
  await login(page);
  await page.getByRole('button', { name: 'Tusker Lager' }).tap();

  for (const name of ['Rekodi, amelipa', 'Rekodi (lipa baadaye)']) {
    const button = page.getByRole('button', { name });
    await expect(button).toBeVisible();
    const clipped = await button.evaluate((el) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight);
    expect(clipped, name).toBe(false);
  }
  await expect(page.getByRole('tab', { name: 'Soda na maji' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a wrong PIN counts down and the 5th locks the person', async ({ page }) => {
  await page.goto('/counter/login');
  await page.getByRole('button', { name: demo.name }).click();
  const wrong = demo.demo_pin === '0000' ? '1111' : '0000';
  for (let i = 4; i >= 1; i--) {
    for (const digit of wrong) await page.getByRole('button', { name: digit, exact: true }).click();
    await expect(page.getByText(new RegExp(`Wrong PIN · ${i} tr(y|ies) left`))).toBeVisible();
  }
  for (const digit of wrong) await page.getByRole('button', { name: digit, exact: true }).click();
  await expect(page.getByText('Locked · 5 wrong PINs')).toBeVisible();
  await expect(page.getByRole('timer')).toHaveText(/^[45]:\d\d$/);
});

test('the landing page shows the logo, fits a phone, and leads to the counter', async ({ page }) => {
  await page.goto('/');
  const logo = page.getByRole('img', { name: 'Kaunta Book · Till · Cash · Shelf' });
  await expect(logo).toBeVisible();
  // The artwork loaded (not a broken image).
  expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const counter = page.getByRole('link', { name: /Open the counter/ });
  expect((await counter.boundingBox())!.height).toBeGreaterThanOrEqual(64);
  await counter.click();
  await expect(page.getByRole('button', { name: demo.name })).toBeVisible();
});

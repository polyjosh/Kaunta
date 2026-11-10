import { expect, test } from '@playwright/test';

/**
 * Admin in a real browser on the production build: the demo store (sample
 * night), phone width and desktop, and a decision that survives a reload.
 */

test('Today at 390px: the seed numbers, one column, nothing clipped (screens.md §8)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin');
  await expect(page.getByText('KES 86,450')).toBeVisible();
  await expect(page.getByText('KES 79,970')).toBeVisible();
  await expect(page.getByText('KES 6,480', { exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBe(0);
});

test('Kiswahili Today uses the same layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('kaunta.locale', 'sw'));
  await page.goto('/admin');
  await expect(page.getByText('Je, nimepoteza pesa leo?')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);
});

test('an approval decided in admin stays decided after a reload', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin/approvals');
  const card = page.locator('article', { has: page.getByRole('heading', { name: '#039 Table 2 · Guinness 500ml ×1' }) });
  await card.getByRole('button', { name: 'Approve void' }).click();
  await expect(card.getByText(/Approved void · Njeri/)).toBeVisible();
  await page.reload();
  await expect(page.getByText(/4 waiting/)).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin menu' }).getByLabel('4 waiting')).toBeVisible();
});

test('every admin screen opens without errors and fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const path of ['/admin', '/admin/sales', '/admin/approvals', '/admin/reconcile', '/admin/products', '/admin/products/cane', '/admin/stock/new', '/admin/kegs', '/admin/staff', '/admin/audit']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), path).toBe(0);
  }
  expect(errors).toEqual([]);
});

test('the counter’s “Admin login” opens admin', async ({ page }) => {
  await page.goto('/counter/login');
  await page.getByRole('button', { name: 'Admin login' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByText('Did I lose money today?')).toBeVisible();
});

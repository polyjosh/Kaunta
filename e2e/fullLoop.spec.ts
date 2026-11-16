import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Everything in one browser, with no server (data in browser storage), as a
 * new bar really starts: Kaunta's super admin creates the owner and their
 * first bar (password and bar code); the owner signs in with username +
 * password, adds the menu and a person with the PIN she sets; at the counter
 * the bar code opens that bar and the person sells with that PIN; the sale is
 * in admin and on the platform. Then the owner sells at the counter herself
 * without signing in again, and suspends the person, who is signed out.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function openCounterWithCode(page: Page, code: string) {
  await page.goto('/');
  await page.getByRole('link', { name: /Open the counter/ }).click();
  await expect(page.getByRole('heading', { name: 'Which bar is this counter for?' })).toBeVisible();
  await page.getByLabel('Bar code').fill(code);
  await page.getByRole('button', { name: 'Open the counter' }).click();
}

async function typePin(page: Page, digits: string) {
  for (const d of digits) await page.getByRole('button', { name: d, exact: true }).click();
}

test('Open the counter asks for the bar code; the sample bar’s code opens it', async ({ page }) => {
  await openCounterWithCode(page, 'ZZZZ-ZZZZ');
  await expect(page.getByRole('alert')).toHaveText('That code doesn’t match a bar. Check it with your owner or manager.');
  await page.getByLabel('Bar code').fill('brka-pub2');
  await page.getByRole('button', { name: 'Open the counter' }).click();
  await expect(page.getByRole('heading', { name: 'Who is at the counter?' })).toBeVisible();
  await expect(page.getByText('Baraka Pub', { exact: true })).toBeVisible();
  // Remembered: next time the counter opens straight on the staff list.
  await page.goto('/counter/login');
  await expect(page.getByRole('button', { name: 'Wanjiku' })).toBeVisible();
});

test('owner or manager sign in asks for a username and password (or PIN) first', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Owner or manager sign in/ }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to run your bars' })).toBeVisible();
  await page.getByLabel('Username').fill('njeri');
  await page.getByLabel('Password or PIN').fill('Baraka@2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /: switch bar$/ })).toBeVisible();
});

test('a new bar from start to sale: super admin, owner, staff, counter, admin', async ({ page }) => {
  // Kaunta: the owner and their first bar, with a PIN and a bar code.
  await page.goto('/super');
  await page.getByLabel('Password').fill('Kaunta@2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: '+ Add an owner and their first bar' }).click();
  await page.getByLabel('Owner’s name').fill('Amina');
  await page.getByLabel('Username').fill('amina');
  await page.getByLabel('Password', { exact: true }).fill('amina-2026');
  await page.getByLabel('First bar’s name').fill('Test Bar');
  await page.getByLabel('Bar code for counter phones').fill('test-bar-1');
  await expect(page.getByText('No other bar has this code.')).toBeVisible();
  await page.getByRole('button', { name: 'Create owner and bar' }).click();
  await expect(page.getByRole('heading', { name: 'Amina can start' })).toBeVisible();

  // The owner signs in with username + password; her bar opens on first run.
  await page.goto('/admin');
  await page.getByLabel('Username').fill('amina');
  await page.getByLabel('Password or PIN').fill('amina-2026');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'No products yet' })).toBeVisible();
  await expect(page.locator('.a-barcode-code')).toHaveText('TEST-BAR1');
  await page.getByRole('button', { name: 'Add 12 products' }).click();
  await expect(page.getByRole('region', { name: 'Beer' })).toBeVisible();

  // A person for the counter, with the PIN the owner sets (staff can't change it).
  await page.getByRole('link', { name: 'Staff & devices' }).click();
  await page.getByRole('button', { name: '+ Add person' }).click();
  await page.locator('.a-addperson').getByLabel('Name').fill('Baraka');
  await page.getByLabel('PIN (4 digits)').fill('1357');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'New PIN for Baraka' })).toBeVisible();
  const row = page.getByRole('row', { name: /Baraka/ });
  await row.getByRole('button', { name: /^Show/ }).click();
  await expect(row).toContainText('1357');

  // Counter: the bar code, then Baraka logs in with that PIN and sells.
  await openCounterWithCode(page, 'TEST-BAR1');
  await expect(page.getByText('Test Bar', { exact: true })).toBeVisible();
  await page.locator('.c-staff-tile', { hasText: 'Baraka' }).click();
  await typePin(page, '1357');
  await page.getByRole('button', { name: 'Tusker Lager' }).click();
  await page.getByRole('button', { name: 'Record (pay later)' }).click();
  await expect(page.getByText(/Order #001 recorded/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Synced' })).toBeVisible();

  // The owner sees it.
  await page.goto('/admin');
  await expect(page.getByText('KES 300').first()).toBeVisible();
  await page.getByRole('navigation', { name: 'Admin menu' }).getByRole('link', { name: 'Sales' }).click();
  await expect(page.getByText('#001').first()).toBeVisible();

  // And so does Kaunta, on the platform.
  await page.goto('/super/bars');
  const barRow = page.getByRole('row', { name: /Test Bar/ });
  await expect(barRow).toContainText('TEST-BAR1');
  await expect(barRow).toContainText('Amina (amina)');
  await expect(barRow).toContainText('KES 300');

  // The owner sells at the counter herself: from admin, without signing in again.
  await page.goto('/admin');
  await page.getByRole('button', { name: /Amina’s account/ }).click();
  await page.getByRole('link', { name: 'Sell at the counter' }).click();
  await expect(page.getByRole('button', { name: /Switch user · Amina/ })).toBeVisible();
  await page.getByRole('button', { name: 'Tusker Lager' }).click();
  await page.getByRole('button', { name: 'Record (pay later)' }).click();
  await expect(page.getByText(/Order #002 recorded/)).toBeVisible();

  // Baraka is at the counter (another tab) when the owner suspends him: he is signed out at once.
  const counter = await page.context().newPage();
  await counter.goto('/counter/login');
  await counter.locator('.c-staff-tile', { hasText: 'Baraka' }).click();
  await typePin(counter, '1357');
  await counter.getByRole('button', { name: 'Tusker Lager' }).click();
  await page.goto('/admin/staff');
  const baraka = page.getByRole('row', { name: /Baraka/ });
  await baraka.getByRole('button', { name: 'Suspend' }).click();
  await baraka.getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByRole('heading', { name: 'Suspended' })).toBeVisible();
  await expect(counter.getByText('Baraka’s access was removed, so they were signed out. Everything they recorded is saved.')).toBeVisible();
  await expect(counter.locator('.c-staff-tile', { hasText: 'Baraka' })).toHaveCount(0);
  // The Tusker in his tray was saved as an open order.
  await page.getByRole('navigation', { name: 'Admin menu' }).getByRole('link', { name: 'Sales' }).click();
  await expect(page.getByText('#003').first()).toBeVisible();
});

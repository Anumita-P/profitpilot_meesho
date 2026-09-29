import { expect, test } from '@playwright/test'
import { signInAs } from './helpers'

/** Guardrail behaviour the UI must not let a user talk their way out of:
 *  the market corridor, the 12% step cap, and reasons on rejected options. */

test('prices outside the corridor fail visibly in the simulator', async ({ page }) => {
  await signInAs(page, 'sunita', '/seller/sku/K-101/simulate')
  await expect(page.getByText('outside corridor (never recommended)')).toBeVisible()

  const slider = page.locator('input[type="range"][aria-label="Price"]')
  const max = Number(await slider.getAttribute('max'))
  await slider.fill(String(max))

  await expect(page.locator('[data-constraint="corridor"][data-pass="false"]').first()).toBeVisible()
  await expect(page.locator('[data-constraint="max_price_move"][data-pass="false"]').first()).toBeVisible()
  await expect(page.getByText(/cap 12% of ₹/).first()).toBeVisible()
})

test('the recommendation never jumps more than one 12% step', async ({ page }) => {
  await signInAs(page, 'sunita', '/seller/sku/K-101/recommendation')
  await expect(page.getByText(/Maximum 12% price move|12% of ₹|Step \d of \d/).first()).toBeVisible()
  await expect(page.getByText(/A price change can reach your goal|No price in the current market corridor meets your target/)).toBeVisible()
})

test('rejected options state the constraint they fail', async ({ page }) => {
  await signInAs(page, 'sunita', '/seller/sku/K-207/recommendation')

  await expect(page.getByText('No price in the current market corridor meets your target.')).toBeVisible()
  await expect(page.getByText(/ProfitPilot found (one|\d+) other ways? to improve the economics/)).toBeVisible()
  await expect(page.getByText('Considered and rejected')).toBeVisible()
  await expect(page.getByText(/stays below your ₹60 floor|over the return cap|not on a volumetric slab/).first()).toBeVisible()
  await expect(page.getByText('meets your goal').first()).toBeVisible()
})

test('the no-price verdict is not a dead end: it ranks interventions', async ({ page }) => {
  await signInAs(page, 'sunita', '/seller/sku/K-207/recommendation')
  await expect(page.getByRole('button', { name: 'Save this option' }).first()).toBeVisible()
  await expect(page.locator('.card.card-pad').first()).toBeVisible()
})

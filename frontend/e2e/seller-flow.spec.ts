import { expect, test } from '@playwright/test'
import { signInAs } from './helpers'

/** The seller journey on the built SPA served by the API: sign in → catalog → snapshot →
 *  simulator → recommendation → reverse pricing → diagnosis → model pipeline.
 *  Every number asserted here is recomputed by the backend on the request. */

test.describe('seller journey', () => {
  test('signs in through the real login UI, then walks every seller screen', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: /Pricing that protects the money you actually keep/ })).toBeVisible()
    await expect(page.getByText(/There are no passwords in the demo/)).toBeVisible()
    await page.getByRole('button', { name: /Enter as seller \(Sunita\)/ }).click()

    await expect(page).toHaveURL(/\/seller\/catalog$/)
    await expect(page.getByText(/of \d+ listings may be losing money after returns/)).toBeVisible()

    const row = page.getByRole('row').filter({ has: page.getByText('K-101', { exact: true }) }).first()
    await expect(row).toBeVisible()
    await row.getByRole('link').first().click()

    await expect(page).toHaveURL(/\/seller\/sku\/K-101$/)
    await expect(page.getByText('Today, at your current price')).toBeVisible()
    await expect(page.locator('.metric .range').first()).toBeVisible()
    await expect(page.getByText('Where each ₹ of the price goes')).toBeVisible()
    await expect(page.getByText(/Synthetic/).first()).toBeVisible()

    await page.getByRole('link', { name: /Simulate a price change/ }).click()
    await expect(page).toHaveURL(/\/seller\/sku\/K-101\/simulate$/)
    await expect(page.locator('svg').first()).toBeVisible()
    await expect(page.getByText('outside corridor (never recommended)')).toBeVisible()
    await expect(page.getByText('highest orders', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('highest contribution', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Why this number\?/ })).toBeVisible()

    await page.getByRole('link', { name: /See the recommendation/ }).click()
    await expect(page).toHaveURL(/\/seller\/sku\/K-101\/recommendation$/)
    await expect(page.getByText('A price change can reach your goal')).toBeVisible()
    await expect(page.getByText('What would change this')).toBeVisible()
    await expect(page.getByText('Guardrails.').first()).toBeVisible()

    await page.getByRole('link', { name: 'Reverse pricing' }).click()
    await expect(page).toHaveURL(/\/seller\/sku\/K-101\/reverse$/)
    await expect(page.getByText('The price you would need')).toBeVisible()
    await expect(page.getByText('Ranked ways to hit the goal')).toBeVisible()

    await page.getByRole('link', { name: 'Diagnosis' }).click()
    await expect(page).toHaveURL(/\/seller\/sku\/K-101\/diagnosis$/)
    await expect(page.getByText('The funnel, stage by stage')).toBeVisible()
    await expect(page.getByText('Impressions', { exact: true })).toBeVisible()

    await page.getByRole('link', { name: 'Model pipeline' }).click()
    await expect(page).toHaveURL(/\/seller\/model\/K-101$/)
    await expect(page.locator('.pipe-node')).toHaveCount(10)
    await expect(page.getByText(/Coefficient recovery/)).toBeVisible()
  })

  test('shows the same numbers after a reload (deterministic, server-computed)', async ({ page }) => {
    await signInAs(page, 'sunita', '/seller/catalog')
    await page.goto('/seller/sku/K-101')
    const hero = page.locator('.metric .value').first()
    const first = await hero.textContent()
    expect(first).toMatch(/₹/)
    await page.reload()
    await expect(hero).toHaveText(first ?? '')
  })

  test('degrades honestly when the API is unavailable (no invented fallback numbers)', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: /Enter as seller \(Sunita\)/ }).click()
    await page.route('**/api/skus**', (route) => route.abort())
    await page.goto('/seller/catalog')
    await expect(page.getByRole('alert').first()).toBeVisible()
    await expect(page.locator('.metric')).toHaveCount(0)
  })
})

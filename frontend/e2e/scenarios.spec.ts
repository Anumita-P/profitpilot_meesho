import { expect, test } from '@playwright/test'
import { signInAs, startScenario } from './helpers'

/** Demo Mode: each of the five scenarios must drive the real engine to the story it promises.
 *  The panel switches persona and goal through the API and lands on the screen the story lives on. */

const SCENARIOS = [
  { name: 'Lower price, lower profit', route: /\/seller\/sku\/K-101\/simulate$/, look: 'Highest orders ≠ highest retained contribution.' },
  { name: 'No profitable price', route: /\/seller\/sku\/K-207\/recommendation$/, look: 'No price in the current market corridor meets your target.' },
  { name: 'Packaging beats discounting', route: /\/seller\/sku\/K-330\/reverse$/, look: 'The price you would need' },
  { name: 'Inventory-constrained seller', route: /\/seller\/sku\/K-101R\/recommendation$/, look: 'Recovery floor' },
  { name: "Price isn't the problem", route: /\/seller\/sku\/K-118\/diagnosis$/, look: 'Price is probably NOT your main problem' },
] as const

test.describe('demo scenarios', () => {
  for (const s of SCENARIOS) {
    test(`"${s.name}" lands on its screen with its story visible`, async ({ page }) => {
      await signInAs(page, 'sunita', '/seller/catalog')
      await startScenario(page, s.name)

      await expect(page).toHaveURL(s.route)
      await expect(page.getByText(s.look, { exact: false }).first()).toBeVisible()
    })
  }

  test('scenario the market cannot price shows the shortfall numbers, not a shrug', async ({ page }) => {
    await signInAs(page, 'sunita', '/seller/catalog')
    await startScenario(page, 'No profitable price')
    await expect(page).toHaveURL(/K-207\/recommendation$/)
    await expect(page.getByText(/Best price it could find/)).toBeVisible()
    await expect(page.getByText(/What is actually binding/)).toBeVisible()
  })
})

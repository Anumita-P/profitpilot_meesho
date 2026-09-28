import { expect, test } from '@playwright/test'
import { signInAs } from './helpers'

/** Employee and customer lanes: aggregates only for the marketplace view, and a buyer page that
 *  states the non-personalisation guarantee the pricing engine is built around. */

test.describe('employee lane', () => {
  test('shows the fleet replay, guardrails and model health', async ({ page }) => {
    await signInAs(page, 'employee', '/employee/overview')

    await expect(page).toHaveURL(/\/employee\/overview$/)
    await expect(page.getByRole('heading', { name: /Fleet health, not a seller's books/ })).toBeVisible()
    await expect(page.getByText(/simulated rollout/i).first()).toBeVisible()
    await expect(page.getByText('Recommendations generated')).toBeVisible()
    await expect(page.getByText('Why recommendations get withheld')).toBeVisible()

    await page.getByRole('link', { name: 'Guardrails' }).click()
    await expect(page.getByText('Guardrails: what we refuse to recommend')).toBeVisible()
    await expect(page.getByText('Audit log — action counts')).toBeVisible()

    await page.getByRole('link', { name: 'Model health' }).click()
    await expect(page.getByText(/M1/).first()).toBeVisible()
    await expect(page.getByText('Calibration and discrimination')).toBeVisible()
    await expect(page.getByText(/ECE/).first()).toBeVisible()

    await page.getByRole('link', { name: 'Experiments' }).click()
    await expect(page.getByText('Experiments — designed, never run')).toBeVisible()
    await expect(page.getByText(/never run on real traffic|not real results/i).first()).toBeVisible()
  })

  test('a seller session cannot open the employee lane', async ({ page }) => {
    await signInAs(page, 'sunita', '/employee/overview')
    await expect(page).toHaveURL(/\/seller\/catalog$/)
  })
})

test.describe('customer lane', () => {
  test('one price for everyone, stated on the page', async ({ page }) => {
    await signInAs(page, 'customer', '/customer/listing/K-101')

    await expect(page).toHaveURL(/\/customer\/listing\/K-101$/)
    await expect(page.getByText('Everyone sees the same price for this listing. Prices are not personalised.')).toBeVisible()
    await expect(page.getByText('How you can pay')).toBeVisible()
    await expect(page.getByText(/Prepaid orders are delivered more reliably/)).toBeVisible()
    await expect(page.getByText('no buyer-level pricing anywhere in the system', { exact: false })).toBeVisible()
  })
})

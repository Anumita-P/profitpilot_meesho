import { expect, test, type Page } from '@playwright/test'
import { signInAs, startScenario } from './helpers'

/**
 * Regenerates the screenshots quoted in docs/FINAL_CHECK.md.
 *
 * Run with `SHOTS=1 npm run e2e` (or `make shots`). Skipped by default so the normal e2e run stays
 * fast: these are documentation artefacts, not assertions.
 */
const ENABLED = process.env.SHOTS === '1'
const OUT = '../docs/screenshots'

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
}

test.describe('documentation screenshots', () => {
  test.skip(!ENABLED, 'set SHOTS=1 to regenerate docs/screenshots')

  test('login and seller screens', async ({ page }) => {
    await page.goto('/login')
    await shot(page, '01-login')

    await signInAs(page, 'sunita', '/seller/catalog')
    await expect(page.getByText(/losing money after returns/)).toBeVisible()
    await shot(page, '02-catalog')

    await page.goto('/seller/sku/K-101')
    await expect(page.getByText('Today, at your current price')).toBeVisible()
    await shot(page, '03-snapshot')

    await page.goto('/seller/sku/K-101/simulate')
    await expect(page.locator('svg').first()).toBeVisible()
    await shot(page, '04-simulator')

    await page.goto('/seller/sku/K-101/recommendation')
    await expect(page.getByText('A price change can reach your goal')).toBeVisible()
    await shot(page, '05-recommendation-price-works')

    await page.goto('/seller/sku/K-207/recommendation')
    await expect(page.getByText('No price in the current market corridor meets your target.')).toBeVisible()
    await shot(page, '06-recommendation-no-profitable-price')

    await page.goto('/seller/sku/K-330/reverse')
    await expect(page.getByText('Ranked ways to hit the goal')).toBeVisible()
    await shot(page, '07-reverse-pricing')

    await page.goto('/seller/sku/K-118/diagnosis')
    await expect(page.getByText('Price is probably NOT your main problem')).toBeVisible()
    await shot(page, '08-diagnosis-not-a-price-problem')

    await page.goto('/seller/model/K-101')
    await expect(page.locator('.pipe-node')).toHaveCount(10)
    await shot(page, '09-model-pipeline')

    await page.goto('/seller/goals')
    await expect(page.getByText('What each listing has to deliver')).toBeVisible()
    await shot(page, '10-goals')
  })

  test('demo mode, other roles and a small viewport', async ({ page }) => {
    await signInAs(page, 'sunita', '/seller/catalog')
    await startScenario(page, 'Lower price, lower profit')
    await expect(page).toHaveURL(/\/seller\/sku\/K-101\/simulate$/)
    await shot(page, '11-demo-mode-panel')

    await signInAs(page, 'employee', '/employee/overview')
    await expect(page.getByText(/simulated rollout/i).first()).toBeVisible()
    await shot(page, '12-employee-overview')

    await page.goto('/employee/guardrails')
    await expect(page.getByText('Guardrails: what we refuse to recommend')).toBeVisible()
    await shot(page, '13-employee-guardrails')

    await page.goto('/employee/model-health')
    await expect(page.getByText('Calibration and discrimination')).toBeVisible()
    await shot(page, '14-employee-model-health')

    await page.goto('/employee/experiments')
    await expect(page.getByText('Experiments — designed, never run')).toBeVisible()
    await shot(page, '15-employee-experiments')

    await signInAs(page, 'customer', '/customer/listing/K-101')
    await expect(page.getByText('Everyone sees the same price for this listing. Prices are not personalised.')).toBeVisible()
    await shot(page, '16-customer-listing')

    await page.setViewportSize({ width: 430, height: 900 })
    await signInAs(page, 'sunita', '/seller/sku/K-101/recommendation')
    await expect(page.getByText(/A price change can reach your goal/)).toBeVisible()
    await shot(page, '17-mobile-recommendation')
  })
})

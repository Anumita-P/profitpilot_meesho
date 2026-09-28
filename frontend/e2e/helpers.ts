import { expect, type Page } from '@playwright/test'

/**
 * Session helpers.
 *
 * Demo sign-in is rate limited to 10 requests/minute per IP (SPEC 21) and the limit is part of the
 * product, so the suite does not hammer it: each persona authenticates once over the API, the
 * session cookie is cached and re-injected into later browser contexts. Exactly one test exercises
 * the real login UI end to end.
 */

type CachedCookie = {
  name: string
  value: string
  domain: string
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'Lax' | 'Strict' | 'None'
}

const cookies = new Map<string, CachedCookie>()

export async function sessionCookie(page: Page, persona: string): Promise<CachedCookie> {
  const cached = cookies.get(persona)
  if (cached) return cached
  const res = await page.request.post('/api/auth/demo-login', {
    data: { persona },
    headers: { 'X-Requested-With': 'profitpilot' },
  })
  expect(res.status(), `demo login for ${persona}`).toBe(200)
  const raw = res.headers()['set-cookie'] ?? ''
  const value = /pp_session=([^;]+)/.exec(raw)?.[1]
  expect(value, 'session cookie issued').toBeTruthy()
  const cookie: CachedCookie = {
    name: 'pp_session', value: value as string, domain: '127.0.0.1', path: '/',
    httpOnly: true, secure: false, sameSite: 'Lax',
  }
  cookies.set(persona, cookie)
  return cookie
}

/** Land on `path` already signed in as `persona`, without spending a demo-login request. */
export async function signInAs(page: Page, persona: string, path: string) {
  const cookie = await sessionCookie(page, persona)
  await page.context().addCookies([cookie])
  await page.goto(path)
}

/** The full login UI journey (one per run: the screen and the flow are themselves under test). */
export async function loginThroughUi(page: Page, persona: 'sunita' | 'rahul' | 'employee' | 'customer') {
  const labels: Record<string, RegExp> = {
    sunita: /Enter as seller \(Sunita\)/,
    rahul: /Enter as seller \(Rahul\)/,
    employee: /Enter as employee/,
    customer: /Enter as customer/,
  }
  await page.goto('/login')
  await page.getByRole('button', { name: labels[persona] }).click()
  await expect(page).toHaveURL(/\/seller\/catalog$|\/employee\/overview$|\/customer\/listing\/K-101$/)
}

/** Open the Demo Mode panel and start a scenario, landing on the screen the story lives on.
 *  `name` is the scenario title as the API spells it (pass a string: scenario titles contain
 *  apostrophes, and a string match avoids quoting traps). */
export async function startScenario(page: Page, name: string | RegExp) {
  await page.getByRole('button', { name: /Demo scenarios/ }).click()
  await page.getByRole('button', { name }).first().click()
}

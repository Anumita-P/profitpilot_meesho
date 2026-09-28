import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { Me, Scenario } from '../api/types'

interface SessionValue {
  me: Me | null
  loading: boolean
  error: string | null
  login: (persona: string) => Promise<Me>
  logout: () => Promise<void>
  refresh: () => Promise<void>
  scenarios: Scenario[]
  activeScenario: string | null
  applyScenario: (id: string) => Promise<{ sku_id: string; route: string; name: string }>
  resetDemo: () => Promise<void>
  toast: string | null
  setToast: (msg: string | null) => void
}

const Ctx = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [activeScenario, setActiveScenario] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api.me()
      setMe(data)
      setError(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null)
      else setError(e instanceof Error ? e.message : 'Could not reach the API')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!me) return
    api.scenarios().then((d: { scenarios: Scenario[] }) => setScenarios(d.scenarios)).catch(() => setScenarios([]))
  }, [me])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4200)
    return () => clearTimeout(t)
  }, [toast])

  const login = useCallback(async (persona: string) => {
    await api.login(persona)
    const data = await api.me()
    setMe(data)
    setLoading(false)
    return data
  }, [])

  const logout = useCallback(async () => {
    await api.logout()
    setMe(null)
  }, [])

  const applyScenario = useCallback(async (id: string) => {
    const res = await api.applyScenario(id)
    // A scenario also switches the signed-in persona to the seller the story belongs to, so the
    // screen it opens on is readable by the session that lands there. Only re-authenticate when
    // the persona actually changes — demo logins are rate limited (SPEC 21).
    if (me?.user.persona && me.user.persona !== res.seller_persona) {
      await api.login(res.seller_persona)
    }
    setActiveScenario(id)
    await refresh()
    return res
  }, [refresh, me?.user.persona])

  const resetDemo = useCallback(async () => {
    await api.resetDemo()
    setActiveScenario(null)
    await refresh()
  }, [refresh])

  const value = useMemo<SessionValue>(() => ({
    me, loading, error, login, logout, refresh, scenarios, activeScenario, applyScenario, resetDemo, toast, setToast,
  }), [me, loading, error, login, logout, refresh, scenarios, activeScenario, applyScenario, resetDemo, toast])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession(): SessionValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useSession must be used inside SessionProvider')
  return v
}

/** Small data hook: one request per key, with loading/error/refetch. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    fn().then((d) => { if (alive) { setData(d); setLoading(false) } })
      .catch((e: unknown) => { if (alive) { setError(e instanceof Error ? e.message : 'Request failed'); setLoading(false) } })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const refetch = useCallback(() => setNonce((n) => n + 1), [])
  return { data, error, loading, refetch }
}

import type {
  Band, Catalog, Confidence, CurveResponse, CustomerListing, Diagnosis, EmployeeGuardrails,
  EmployeeInterventions, EmployeeOverview, Experiments, Goal, ModelHealth, Me, Pipeline,
  PointResponse, Recommendation, ReverseResponse, Scenario, SkuDetail, Snapshot, User,
} from './types'

/** Thin fetch wrapper: same-origin /api, credential cookies, the API's error envelope, no retries. */
export class ApiError extends Error {
  code: string
  status: number
  fieldErrors: Record<string, string>
  requestId: string | null

  constructor(status: number, code: string, message: string, fieldErrors = {}, requestId: string | null = null) {
    super(message)
    this.status = status
    this.code = code
    this.fieldErrors = fieldErrors
    this.requestId = requestId
  }
}

const WRITE_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'profitpilot' }

/** In-memory session token. Empty in the normal case: the httpOnly cookie carries the session.
 *  It is only set when the API confirms it issued one for a cookie-less (embedded) context. */
let sessionToken: string | null = null
export function setSessionToken(token: string | null) { sessionToken = token }
function authHeaders(): Record<string, string> {
  return sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}
}

async function parse(res: Response) {
  if (res.status === 204) return null
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const env = (body as { error?: { code: string; message: string; field_errors?: Record<string, string>; request_id?: string } } | null)?.error
    throw new ApiError(res.status, env?.code ?? 'INTERNAL', env?.message ?? `Request failed (${res.status})`,
      env?.field_errors ?? {}, env?.request_id ?? null)
  }
  return body
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json', ...authHeaders() } })
  return (await parse(res)) as T
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...WRITE_HEADERS, ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return (await parse(res)) as T
}

export interface HistoryItem {
  id: number
  sku_id: string
  verdict: string
  intervention: { id: string; price: number; iv?: Record<string, number> | null }
  expected: Record<string, Band>
  confidence: Confidence
  status: string
  note: string | null
  created_at: string
  model_version: string
}

export interface GoalPreview {
  verdict_hint: 'PRICE_WORKS' | 'PRICE_INFEASIBLE'
  best_in_corridor: { price: number; per_kept: number; orders_day: number }
  shortfall: {
    best_in_corridor_price: number; per_kept: number; target: number; orders_day: number
    min_orders: number; contribution_shortfall_abs: number; volume_shortfall_abs: number
    binding: string[]; best_feasible_price: number | null
  }
  label: string
}

export interface SaveResult {
  id: number
  status: string
  created_at: string
  expected: Record<string, Band>
  confidence: Confidence
  label: string
}

/** Endpoint map. Every return type mirrors the FastAPI response schema. */
/** Demo sign-in. Asks for a bearer token as well; if the API issues one (cookie-less context)
 *  the client keeps it in memory and uses it for later calls. */
async function postWithFallback(persona: string): Promise<{ user: User; redirect: string; token?: string }> {
  const res = await fetch('/api/auth/demo-login', {
    method: 'POST', credentials: 'same-origin',
    headers: { ...WRITE_HEADERS, 'X-Session-Transport': 'bearer' },
    body: JSON.stringify({ persona }),
  })
  const body = await parse(res) as { user: User; redirect: string; token?: string }
  if (body?.token) setSessionToken(body.token)
  return body
}

export const api = {
  me: () => get<Me>('/api/me'),
  login: (persona: string) => postWithFallback(persona),
  logout: async () => { await post<void>('/api/auth/logout'); setSessionToken(null) },
  scenarios: () => get<{ scenarios: Scenario[]; label: string }>('/api/demo/scenarios'),
  applyScenario: (id: string) => post<{ scenario: string; name: string; seller_persona: string; sku_id: string; goal: Goal; mode: string; route: string; story: string; look_for: string }>(`/api/demo/scenario/${id}`),
  resetDemo: () => post<{ reset: boolean }>('/api/demo/reset'),
  catalog: (status = 'all', sort = 'contribution') => get<Catalog>(`/api/skus?status=${status}&sort=${sort}`),
  sku: (id: string) => get<SkuDetail>(`/api/skus/${id}`),
  snapshot: (id: string) => get<Snapshot>(`/api/skus/${id}/snapshot`),
  diagnosis: (id: string) => get<Diagnosis>(`/api/skus/${id}/diagnosis`),
  curve: (body: unknown) => post<CurveResponse>('/api/simulate/curve', body),
  point: (body: unknown) => post<PointResponse>('/api/simulate/point', body),
  recommendation: (body: unknown) => post<Recommendation>('/api/recommendation', body),
  reversePricing: (body: unknown) => post<ReverseResponse>('/api/reverse-pricing', body),
  saveRecommendation: (body: unknown) => post<SaveResult>('/api/recommendations', body),
  history: (limit = 20) => get<{ items: HistoryItem[]; label: string }>(`/api/recommendations?limit=${limit}`),
  rollback: (id: number) => post<{ id: number; status: string; note: string }>(`/api/recommendations/${id}/rollback`),
  applySimulated: (id: number) => post<{ id: number; status: string; note: string }>(`/api/recommendations/${id}/apply`),
  saveGoal: (body: unknown) => post<{ saved: boolean; goal_id: number }>('/api/goals', body),
  previewGoal: (body: unknown) => post<GoalPreview>('/api/goals/preview', body),
  pipeline: (skuId: string) => get<Pipeline>(`/api/model/pipeline?sku_id=${encodeURIComponent(skuId)}`),
  explanation: (skuId: string, price: number, comparePrice?: number) =>
    get<import('./types').Explanation>(`/api/model/explanation?sku_id=${encodeURIComponent(skuId)}&price=${price}${comparePrice ? `&compare_price=${comparePrice}` : ''}`),
  employeeOverview: () => get<EmployeeOverview>('/api/employee/overview'),
  employeeInterventions: () => get<EmployeeInterventions>('/api/employee/interventions'),
  employeeGuardrails: () => get<EmployeeGuardrails>('/api/employee/guardrails'),
  employeeModelHealth: () => get<ModelHealth>('/api/employee/model-health'),
  employeeExperiments: () => get<Experiments>('/api/employee/experiments'),
  customerListing: (id: string) => get<CustomerListing>(`/api/customer/listing/${id}`),
}

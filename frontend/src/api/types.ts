/** Response types mirroring the FastAPI schemas (backend/app/api). Keep in step with the API. */

export type Mode = 'margin' | 'growth' | 'cash' | 'clear'
export type Verdict = 'PRICE_WORKS' | 'PRICE_INFEASIBLE' | 'NEEDS_EVIDENCE' | 'NOT_A_PRICE_PROBLEM'
export type Confidence = 'Low' | 'Medium' | 'High'
export type Status = 'FEASIBLE' | 'NEAR_MISS' | 'VIOLATES' | 'STEP_1'

export interface Band { p10: number; p50: number; p90: number }

export interface User {
  id: string
  role: 'seller' | 'employee' | 'customer'
  name: string
  seller_id: string | null
  persona: 'sunita' | 'rahul' | 'employee' | 'customer'
}

export interface Me {
  user: User
  seller: {
    seller_id: string
    name: string
    city: string
    default_mode: Mode
    cash_limit: number
    sku_count: number
  } | null
  env: string
  persona_options: { persona: string; name: string; role: string }[]
}

export interface Goal {
  target_contribution: number
  min_orders: number
  max_return_rto: number
  cash_limit: number | null
  mode: Mode
}

export interface StatusPill { id: 'losing' | 'watch' | 'healthy'; label: string; icon: string }

export interface SkuCard {
  sku_id: string
  name: string
  category: string
  seller_id: string
  price: number
  corridor: [number, number]
  image_quality: number
  pack_quality: number
  rating: number
  inventory: number
  stock_age_days: number
  demo_role: string | null
  flags: Record<string, boolean>
  estimated: Record<string, Band>
  status: StatusPill
  label: string
  goal?: Goal
}

export interface Catalog {
  skus: SkuCard[]
  total: number
  losing: number
  watch: number
  summary: string
  label: string
}

export interface SkuDetail extends SkuCard {
  goal: Goal
  observed: Record<string, number | string>
  label: string
}

export interface Constraint {
  id: string
  label: string
  pass_: boolean
  margin: number
  actual: number
  required: number
  unit: string
  note: string
}

export interface ConfidenceBlock {
  label: Confidence
  n_eff: number
  n_comparable: number
  extrapolation_pct: number
  band_width: number
  drivers: { name: string; share: number }[]
  rule: string
}

export interface WaterfallStep { label: string; value: number; kind: string }

export interface Snapshot {
  sku_id: string
  price: number
  corridor: [number, number]
  hero: { metric: string; value: Band; confidence: ConfidenceBlock; label: string }
  kept_rate: number
  waterfall: WaterfallStep[]
  secondary: Record<string, Band>
  observed: Record<string, number | string>
  footnotes: string[]
  label: string
}

export interface Branch { id: string; label: string; probability: number; value_inr: number; share_of_orders: number }

export interface EventTree {
  price: number
  units_per_order: number
  probabilities: Record<string, number>
  per_order_inr: Record<string, number>
  branches: Branch[]
  label: string
  mode: Mode
}

export interface PointResponse {
  price: number
  sku_id: string
  model_version: string
  label: string
  goal: Goal
  mode: Mode
  intervention: Record<string, number>
  metrics: Record<string, Band>
  constraints: Constraint[]
  confidence: ConfidenceBlock
  event_tree: EventTree
  elasticity: Record<string, number>
}

export interface CurveResponse {
  sku_id: string
  price_current: number
  corridor: [number, number]
  model_version: string
  label: string
  goal: Goal
  mode: Mode
  intervention: Record<string, number>
  prices: number[]
  /** Columnar: one array per quantile, aligned with `prices`. */
  series: Record<string, { p10: number[]; p50: number[]; p90: number[] }>
  /** Columnar constraint masks, aligned with `prices` (AND them for "passes everything"). */
  constraints: Record<string, boolean[]>
  markers: {
    current: { price: number }
    recommended: { price: number; objective: number; confidence: Confidence } | null
    argmax_orders: number
    argmax_contribution: number
    annotation: string | null
  }
  evidence: { n_eff_p50: number; extrapolation_band: { outside_low: number[]; outside_high: number[] } }
  meta: { points: number; max_price_move: number; bootstrap_members: number }
}

export interface Answer { what: string; why: string; expected_impact: string; risk: string; what_would_change_this: string; next_step?: string | null }

export interface RecommendationCard {
  id: string
  label: string
  status: Status
  params: { price: number; iv: Record<string, number>; units_per_order?: number; bundle_price?: number | null; target_price?: number | null; step?: number; steps?: number }
  metrics: Record<string, Band>
  confidence: Confidence
  evidence_n: number
  constraints: Record<string, boolean>
  shortfall?: Record<string, unknown>
  ladder?: { step: number; steps: number; target_price: number } | null
  tradeoffs: string[]
  answer: Answer
  why: string
  objective: number
  label_chip: string
}

export interface Rejected { id: string; label?: string; reason: string; status?: string }

export interface Recommendation {
  sku_id: string
  seller_id: string
  mode: Mode
  goal: Goal
  verdict: Verdict
  title: string
  banner?: string
  model_version: string
  label: string
  current: { price: number; metrics: Record<string, Band>; confidence: Confidence }
  reach: { price: number; metrics: Record<string, Band>; confidence: Confidence; steps: number } | null
  shortfall: {
    best_in_corridor_price: number
    per_kept: number
    target: number
    orders_day: number
    min_orders: number
    contribution_shortfall_abs: number
    volume_shortfall_abs: number
    binding: string[]
    best_feasible_price: number | null
  }
  evidence: { n_comparable: number; n_eff: number; category: string; price: number; min_required: number }
  confidence: ConfidenceBlock
  guardrails: Record<string, string | boolean>
  interventions: RecommendationCard[]
  recommendation: RecommendationCard | null
  considered_and_rejected: Rejected[]
  also_consider: { id: string; label: string; gain_per_day: number; price: number; metrics: Record<string, Band> } | null
  evidence_card?: { message: string; options: string[]; evidence: unknown }
  sensitivity: { robust: boolean; sensitive_to: string[]; statement: string; tested?: unknown[] }
}

export interface StepSolution {
  rank: number
  id: string
  label: string
  price: number
  iv: Record<string, number>
  status: Status
  steps: number
  metrics: Record<string, Band>
  objective: number
  confidence: Confidence
  constraints: Record<string, boolean>
  inventory_need_units: number
  cash_need: number
  why: string
}

export interface ReverseResponse {
  sku_id: string
  mode: Mode
  goal: Goal
  solutions: StepSolution[]
  price_only: { best_price: number; per_kept: number; orders_day: number; leakage: number; feasible: boolean }
  required_price: { found: boolean; price?: number; orders_day?: number; in_corridor?: boolean; ceiling: number; floor: number; meets_volume?: boolean; line: string }
  required_cost_reduction: { found: boolean; note?: string; pct?: number; amount?: number; line?: string }
  elimination: string[]
  objective: { mode: Mode; weights: { name: string; value: number; unit: string; note: string }[] }
  current: { price: number; metrics: Record<string, Band> }
  label: string
}

export interface Bottleneck {
  id: string
  label: string
  strength: number
  evidence: string[]
  action: string
  intervention: string | null
}

export interface Diagnosis {
  sku_id: string
  mode: Mode
  goal: Goal
  funnel: { stage: string; value: number; rate: number | null; benchmark_percentile: number | null; comparable_skus: number; flag: string | null }[]
  bottlenecks: Bottleneck[]
  verdict: { id: string; title: string; subtitle: string; bottleneck: string; action: string; confidence: Confidence }
  expected_effect: {
    action: string
    price: number
    per_kept: Band
    orders_day: Band
    leakage: Band
    contribution_day: Band
    delta_contribution_day: number
    confidence: Confidence
    label: string
  } | null
  price_only: { best_in_corridor_kept: number; target: number; shortfall: number }
  evidence: { comparable_listings: number; category: string }
  label: string
  data_label: string
}

export interface PipelineNode {
  index: number
  label: string
  prediction: string
  inputs: string[]
  output_for_sku: Record<string, number | string>
  confidence: Confidence
  interpretation: string
  drivers: { name: string; value?: number; contribution?: number; note?: string }[]
  model: string
  model_type: string
  n_train: number
  calibration_error: number
}

export interface Pipeline {
  sku_id: string
  version: string
  nodes: PipelineNode[]
  technical: Record<string, unknown>
}

export interface Attribution { block: string; delta_inr: number; share: number }

export interface Explanation {
  sku_id: string
  price: number
  compare_price: number
  attribution: Attribution[]
  current: Record<string, Band>
  comparison: Record<string, Band>
  label: string
}

export interface EmployeeOverview {
  label: string
  data_label: string
  kpis: Record<string, { value: number; unit?: string; note: string }>
  fleet: { sellers: number; skus: number; sample: number }
  guardrails: { blocked: Record<string, number> }
}

export interface EmployeeInterventions {
  rows: { intervention: string; count: number; mean_delta_contribution: number; mean_delta_per_kept: number; mean_delta_leakage: number; share_violating: number }[]
  label: string
}

export interface EmployeeGuardrails {
  counts: Record<string, number>
  audit: Record<string, number>
  blocked_actions: Record<string, string>
  label: string
}

export interface ModelHealth {
  version: string
  trained_at: string
  data_hash: string
  label: string
  registry_present: boolean
  per_model: Record<string, { ece: number; auc: number; log_loss: number; n_train: number }>
  drift: { status: string; method: string; psi: number; threshold: number }
}

export interface Experiments {
  designs: {
    id: number
    name: string
    status: string
    arms: { arms: { id: string; price_delta_pct: number }[]; opt_in?: string; randomisation?: string; primary_metric?: string; guardrail?: string }
    min_sample: number
    rollback_rule: string
    data_label: string
  }[]
  simulated_results: {
    status: string
    label: string
    rows: { arm: string; kept_per_order: number; orders_day: number; leakage: number }[]
    note: string
  }
  label: string
}

export interface CustomerListing {
  listing: {
    sku_id: string
    name: string
    category: string
    seller_city: string
    price: number
    currency: string
    rating: number
    review_count: number
    availability: string
    delivery_estimate: string
    payment_options: { id: string; label: string; note: string }[]
    return_policy: string
    price_notice: string
  }
  label: string
  data_label: string
}

export interface Scenario {
  id: string
  name: string
  persona: string
  sku_id: string
  goal: Goal
  mode: Mode
  route: string
  story: string
  look_for: string
  cap_note?: string
}

export interface ApiErrorBody {
  error: { code: string; message: string; field_errors: Record<string, string>; request_id: string | null }
}

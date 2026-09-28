import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { CurveResponse, Explanation, PointResponse, SkuDetail } from '../api/types'
import { useAsync, useSession } from '../state/session'
import { useGoal, goalPayload } from '../state/useGoal'
import { PageHead, SkuTabs } from '../components/layout'
import { GoalForm, InterventionPanel } from '../components/GoalForm'
import { EventTree, PriceResponseChart, SensitivityBars } from '../components/charts'
import { Card, Chip, ConstraintList, ConfidencePill, ErrorState, Icon, LoadingCard, RangeNumber, TruthLabel } from '../components/ui'
import { inr, num, pct } from '../lib/format'

/** Driver names are model input names; the card shows the business input behind them. */
const DRIVER_LABEL: Record<string, string> = {
  'demand elasticity': 'Demand sensitivity to price',
  freight: 'Freight cost per parcel',
  'return rate': 'Return rate level',
  rto: 'RTO rate level',
  cod: 'COD share',
  'cod slope': 'COD price effect',
  image: 'Listing image quality',
  pack: 'Packaging quality',
}

const IV_IDS = ['none', 'LISTING_IMAGE', 'PACK_PROTECT', 'PARCEL_REDESIGN', 'BUNDLE2', 'PREPAID_INC']

function ivFor(id: string): Record<string, number> {
  switch (id) {
    case 'LISTING_IMAGE': return { img_delta: 0.18 }
    case 'PACK_PROTECT': return { pack_delta: 0.35, pack_cost_delta: 4 }
    case 'PARCEL_REDESIGN': return { fwd_delta: -24 }
    case 'BUNDLE2': return { bundle: 2, bundle_ship_mult: 1.35, demand_mult: 0.72 }
    case 'PREPAID_INC': return { prepaid_inc: 20 }
    default: return {}
  }
}

export default function Simulator() {
  const { skuId = '' } = useParams()
  const { setToast } = useSession()
  const sku = useAsync<SkuDetail>(() => api.sku(skuId), [skuId])
  const [goal, setGoal] = useGoal(sku.data?.goal ?? null)
  const [price, setPrice] = useState<number | null>(null)
  const [ivId, setIvId] = useState('none')
  const [iv, setIv] = useState<Record<string, number>>({})
  const [drawer, setDrawer] = useState(false)

  const activeIv = useMemo(() => (ivId === 'none' ? iv : { ...ivFor(ivId), ...iv }), [ivId, iv])

  const curve = useAsync<CurveResponse>(
    () => api.curve({ sku_id: skuId, goal: goalPayload(goal), intervention: Object.keys(activeIv).length ? activeIv : null }),
    [skuId, JSON.stringify(goal), JSON.stringify(activeIv)],
  )
  const point = useAsync<PointResponse>(
    () => price === null
      ? Promise.resolve(null as unknown as PointResponse)
      : api.point({ sku_id: skuId, price, goal: goalPayload(goal), intervention: Object.keys(activeIv).length ? activeIv : null }),
    [skuId, price, JSON.stringify(goal), JSON.stringify(activeIv)],
  )
  const explanation = useAsync<Explanation>(
    () => price === null || !sku.data
      ? Promise.resolve(null as unknown as Explanation)
      : api.explanation(skuId, price, sku.data.price),
    [skuId, price],
  )

  useEffect(() => { if (sku.data && price === null) setPrice(sku.data.price) }, [sku.data, price])

  if (sku.loading && !sku.data) return <div className="wrap"><LoadingCard title="Simulator" lines={6} /></div>
  if (sku.error) return <div className="wrap"><ErrorState message={sku.error} onRetry={sku.refetch} /></div>
  if (!sku.data) return null
  const s = sku.data
  const c = curve.data
  const pt = point.data

  // The curve arrives columnar (one array per quantile); the chart takes a row per price.
  const toBands = (b: { p10: number[]; p50: number[]; p90: number[] }) =>
    b.p50.map((_, i) => ({ p10: b.p10[i], p50: b.p50[i], p90: b.p90[i] }))
  const series = c ? [
    { key: 'contribution_day', label: 'contribution/day', color: '#7c3aed', values: toBands(c.series.contribution_day), axis: 'left' as const, fmt: (v: number) => inr(v) },
    { key: 'orders_day', label: 'orders/day', color: '#1d4ed8', values: toBands(c.series.orders_day), axis: 'right' as const, fmt: (v: number) => num(v, 1) },
  ] : []

  const save = async () => {
    if (!pt) return
    try {
      await api.saveRecommendation({
        sku_id: s.sku_id, mode: goal.mode, goal: goalPayload(goal), intervention_id: ivId === 'none' ? 'PRICE' : ivId,
        price: pt.price, intervention: Object.keys(activeIv).length ? activeIv : null,
      })
      setToast('Scenario saved to your recommendations')
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not save')
    }
  }

  return (
    <div className="wrap wrap-wide">
      <PageHead sku={s} right={<>
        <Chip kind="ghost">Corridor {inr(s.corridor[0])}–{inr(s.corridor[1])}</Chip>
        <Chip kind="ghost" icon="lock">Max 12% move per step</Chip>
      </>} />
      <SkuTabs skuId={s.sku_id} />

      <div className="grid-2">
        <Card title="Price simulator" right={<TruthLabel kind="estimated" />}
          note={c?.markers.annotation ? `Note — ${c.markers.annotation}` : undefined}>
          {c ? (
            <>
              <PriceResponseChart prices={c.prices} series={series} corridor={c.corridor} markers={c.markers} constraints={c.constraints} />
              <div className="row-tight" style={{ marginTop: 12, justifyContent: 'space-between' }}>
                <div className="row-tight">
                  <strong className="small">Test a price</strong>
                  <span className="mono">{inr(price ?? s.price)}</span>
                </div>
                <div className="row-tight">
                  {c.markers.recommended ? (
                    <button className="btn btn-sm" onClick={() => setPrice(c.markers.recommended!.price)}>
                      Jump to recommended {inr(c.markers.recommended.price)}
                    </button>
                  ) : null}
                  <button className="btn btn-sm" onClick={() => setPrice(s.price)}>Back to today</button>
                </div>
              </div>
              <input type="range" min={c.corridor[0] - 20} max={c.corridor[1] + 20} step={1} value={price ?? s.price}
                onChange={(e) => setPrice(Number(e.target.value))} aria-label="Price" />
              <div className="row-tight" style={{ justifyContent: 'space-between' }} >
                <span className="tiny muted">{inr(c.corridor[0] - 20)}</span>
                <span className="tiny muted">corridor {inr(c.corridor[0])} – {inr(c.corridor[1])}</span>
                <span className="tiny muted">{inr(c.corridor[1] + 20)}</span>
              </div>
              <p className="tiny muted" style={{ marginTop: 10 }}>
                {c.meta.points} prices evaluated across {c.meta.bootstrap_members} bootstrap members in{' '}
                {'<'}1 s. Prices outside the corridor are drawn but never recommended.
              </p>
            </>
          ) : <LoadingCard lines={6} />}
        </Card>

        <div className="col">
          <Card title="At this price" right={pt ? <ConfidencePill label={pt.confidence.label} block={pt.confidence} /> : null}>
            {point.loading && !pt ? <LoadingCard lines={3} /> : pt ? (
              <>
                <RangeNumber value={pt.metrics.per_kept} tone={pt.metrics.per_kept.p50 < goal.target_contribution ? 'bad' : 'good'} />
                <p className="small muted">Contribution per kept order at {inr(pt.price)}. Goal {inr(goal.target_contribution)}.</p>
                <div className="hr" />
                <div className="kpi-strip">
                  <div className="metric"><div className="label">Orders / day</div><div className="value sm">{num(pt.metrics.orders_day.p50, 1)}</div><div className="range">range {num(pt.metrics.orders_day.p10, 1)}–{num(pt.metrics.orders_day.p90, 1)}</div></div>
                  <div className="metric"><div className="label">Return + RTO</div><div className="value sm">{pct(pt.metrics.leakage.p50)}</div><div className="range">cap {pct(goal.max_return_rto, 0)}</div></div>
                  <div className="metric"><div className="label">Contribution / day</div><div className="value sm">{inr(pt.metrics.contribution_day.p50)}</div><div className="range">range {inr(pt.metrics.contribution_day.p10)}–{inr(pt.metrics.contribution_day.p90)}</div></div>
                </div>
                <div className="row-tight" style={{ marginTop: 10 }}>
                  <button className="btn btn-sm" onClick={() => setDrawer(true)}><Icon name="info" /> Why this number?</button>
                  <button className="btn btn-sm" onClick={save}>Save this scenario</button>
                </div>
              </>
            ) : <p className="small muted">Pick a price to see the detail.</p>}
          </Card>

          <Card title="Your constraints at this price" right={<TruthLabel kind="estimated" />}>
            {pt ? <ConstraintList constraints={pt.constraints} /> : <LoadingCard lines={4} />}
          </Card>

          <Card title="Change the operations, not the price" right={<Chip kind="ghost">Prepaid nudge included</Chip>}>
            <InterventionPanel options={IV_IDS} active={ivId} onPick={(id) => { setIvId(id); setIv({}) }} iv={ivId === 'none' ? iv : activeIv} onCustom={setIv} />
          </Card>

          <Card title="Goal" right={<TruthLabel kind="illustrative" />}>
            <GoalForm value={goal} onChange={setGoal} compact />
          </Card>
        </div>
      </div>

      {pt ? (
        <div className="grid-2" style={{ marginTop: 16 }}>
          <Card title="How an order ends, and what each ending costs you" right={<TruthLabel kind="estimated" />}>
            <EventTree branches={pt.event_tree.branches} perOrder={pt.event_tree.per_order_inr} />
          </Card>
          <div className="col">
            <Card title="What drives the uncertainty" right={<TruthLabel kind="estimated" />}
              note="One-at-a-time variance decomposition: how much of the spread in contribution/day each input explains.">
              <SensitivityBars drivers={pt.confidence.drivers.map((d) => ({ ...d, name: DRIVER_LABEL[d.name] ?? d.name }))} />
              <p className="tiny muted" style={{ marginTop: 8 }}>{pt.confidence.rule}</p>
            </Card>
            <Card title="If you move the price" right={<TruthLabel kind="estimated" />}>
              <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                <span className="small">Demand elasticity at this price</span>
                <strong>{num(pt.elasticity.elasticity_p50, 2)}</strong>
              </div>
              <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                <span className="small">Extra contribution from ₹1 more</span>
                <strong>{inr(pt.elasticity.marginal_contribution_p50, { decimals: 2 })}</strong>
              </div>
              <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                <span className="small">Return + RTO at this price</span>
                <strong>{pct(pt.metrics.leakage.p50)}</strong>
              </div>
              <p className="tiny muted" style={{ marginTop: 8 }}>
                Elasticity is estimated at the current price; it is not constant across the curve.
              </p>
            </Card>
          </div>
        </div>
      ) : null}

      <div className="row-tight" style={{ marginTop: 16 }}>
        <Link className="btn btn-primary" to={`/seller/sku/${s.sku_id}/recommendation`}>See the recommendation</Link>
        <Link className="btn" to={`/seller/sku/${s.sku_id}/reverse`}>Reverse: what price do I need?</Link>
      </div>

      {drawer && pt ? (
        <>
          <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label="Why this number">
            <div className="row-tight" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Why {inr(pt.metrics.per_kept.p50)} per kept order?</h2>
              <button className="btn btn-sm" onClick={() => setDrawer(false)}>Close</button>
            </div>
            <p className="small muted">
              At {inr(pt.price)} the model expects {num(pt.metrics.orders_day.p50, 1)} orders/day, of which{' '}
              {pct(pt.event_tree.probabilities.kept)} are delivered and kept. Each branch earns or loses money:
            </p>
            <EventTree branches={pt.event_tree.branches} perOrder={pt.event_tree.per_order_inr} />
            <div className="hr" />
            <h3>What changed versus {inr(s.price)}</h3>
            {explanation.loading && !explanation.data ? <LoadingCard lines={4} /> : explanation.data ? (
              <>
                {explanation.data.attribution.map((a) => (
                  <div key={a.block} className="row-tight" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed var(--line)' }}>
                    <span className="small">{a.block}</span>
                    <span className="small mono" style={{ color: a.delta_inr < 0 ? 'var(--red-700)' : 'var(--green-700)' }}>
                      {a.delta_inr >= 0 ? '+' : '−'}{inr(Math.abs(a.delta_inr))}
                    </span>
                  </div>
                ))}
                <p className="tiny muted" style={{ marginTop: 8 }}>
                  Attribution is a sequential one-block-at-a-time decomposition from the fitted models, not a
                  counterfactual experiment.
                </p>
              </>
            ) : null}
            <div className="hr" />
            <div className="row-tight">
              <TruthLabel kind="estimated" />
              <Chip kind="ghost">Model {c?.model_version ?? ''}</Chip>
            </div>
          </aside>
        </>
      ) : null}
    </div>
  )
}

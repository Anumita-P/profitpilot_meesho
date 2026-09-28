import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { ReverseResponse, SkuDetail } from '../api/types'
import { useAsync, useSession } from '../state/session'
import { useGoal, goalPayload } from '../state/useGoal'
import { PageHead, SkuTabs } from '../components/layout'
import { GoalForm } from '../components/GoalForm'
import { Card, Chip, ConfidencePill, ErrorState, Icon, LoadingCard, RangeNumber, TruthLabel } from '../components/ui'
import { inr, num, pct } from '../lib/format'

export default function ReversePricing() {
  const { skuId = '' } = useParams()
  const { setToast } = useSession()
  const sku = useAsync<SkuDetail>(() => api.sku(skuId), [skuId])
  const [goal, setGoal] = useGoal(sku.data?.goal ?? null)
  const [units, setUnits] = useState<number | ''>('')
  const [age, setAge] = useState<number | ''>('')
  const rev = useAsync<ReverseResponse>(
    () => api.reversePricing({
      sku_id: skuId, goal: goalPayload(goal),
      inventory_units: units === '' ? null : Number(units),
      stock_age_days: age === '' ? null : Number(age),
    }),
    [skuId, JSON.stringify(goal), units, age],
  )

  if (sku.loading && !sku.data) return <div className="wrap"><LoadingCard title="Reverse pricing" lines={6} /></div>
  if (sku.error) return <div className="wrap"><ErrorState message={sku.error} onRetry={sku.refetch} /></div>
  if (!sku.data) return null
  const s = sku.data
  const r = rev.data

  return (
    <div className="wrap wrap-wide">
      <PageHead sku={s} subtitle="start from the goal, work backwards"
        right={<Chip kind="ghost" icon="info">Target-first: no price search needed</Chip>} />
      <SkuTabs skuId={s.sku_id} />

      <div className="grid-2">
        <Card title="What you need to hit" right={<TruthLabel kind="illustrative" />}
          note="Reverse pricing asks: what price (or what cost change) makes this goal true, and is it even possible?">
          <GoalForm value={goal} onChange={setGoal} compact />
          <div className="hr" />
          <div className="field-inline">
            <div className="field">
              <label htmlFor="units">Units to clear (optional)</label>
              <input id="units" type="number" min={0} value={units} placeholder={String(s.inventory)}
                onChange={(e) => setUnits(e.target.value === '' ? '' : Number(e.target.value))} />
              <div className="hint">You hold {num(s.inventory, 0)} units.</div>
            </div>
            <div className="field">
              <label htmlFor="age">Days since the lot was made</label>
              <input id="age" type="number" min={0} value={age} placeholder={String(s.stock_age_days)}
                onChange={(e) => setAge(e.target.value === '' ? '' : Number(e.target.value))} />
              <div className="hint">Ageing stock raises the cost of waiting.</div>
            </div>
          </div>
        </Card>

        <div className="col">
          {rev.loading && !r ? <LoadingCard lines={4} /> : rev.error ? <ErrorState message={rev.error} onRetry={rev.refetch} /> : r ? (
            <>
              <Card title="The price you would need" right={<TruthLabel kind="estimated" />}>
                <RangeNumber
                  value={{ p10: (r.required_price.price ?? 0) * 0.98, p50: r.required_price.price ?? 0, p90: (r.required_price.price ?? 0) * 1.02 }}
                  tone={r.required_price.in_corridor ? 'good' : 'bad'} />
                <p className="small" style={{ marginTop: 6 }}>{r.required_price.line}</p>
                <div className="row-tight" style={{ marginTop: 8 }}>
                  <Chip kind={r.required_price.in_corridor ? 'green' : 'red'} icon={r.required_price.in_corridor ? 'check' : 'alert'}>
                    {r.required_price.in_corridor ? 'inside the market corridor' : `above the ₹${r.required_price.ceiling} market ceiling`}
                  </Chip>
                  {r.required_price.meets_volume === false ? <Chip kind="yellow">would fall below your volume floor</Chip> : null}
                </div>
              </Card>

              <Card title="Or: what would have to change on the cost side" right={<TruthLabel kind="illustrative" />}>
                {r.required_cost_reduction.found ? (
                  <p className="small" style={{ margin: 0 }}>
                    A cost reduction of <strong>{inr(r.required_cost_reduction.amount ?? 0)}</strong> per unit
                    ({pct((r.required_cost_reduction.pct ?? 0))} of product cost) would make the goal reachable inside the corridor.
                  </p>
                ) : (
                  <p className="small" style={{ margin: 0 }}>
                    {r.required_cost_reduction.note ?? 'No realistic cost reduction reaches the goal on its own.'}
                  </p>
                )}
                <p className="tiny muted" style={{ marginTop: 8 }}>
                  This is the number to take to a supplier negotiation — it is the honest answer to &ldquo;your price is too low&rdquo;.
                </p>
              </Card>
            </>
          ) : null}
        </div>
      </div>

      {r ? (
        <>
          <Card title="Ranked ways to hit the goal" right={<TruthLabel kind="estimated" />}
            note="Feasible options first, then the near-misses. Steps show how many guarded price moves it takes.">
            <div className="col">
              {r.solutions.map((sol) => (
                <div key={sol.id} className="card card-pad">
                  <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                    <div>
                      <strong>#{sol.rank} {sol.label}</strong>
                      <div className="tiny muted">
                        {sol.price !== r.current.price ? <>price {inr(sol.price)}</> : <>price unchanged at {inr(sol.price)}</>}
                        {' · '}{sol.steps} step{sol.steps > 1 ? 's' : ''} of max 12%
                        {sol.status !== 'FEASIBLE' ? ' · near miss' : ''}
                      </div>
                    </div>
                    <div className="row-tight">
                      <Chip kind={sol.status === 'FEASIBLE' ? 'green' : 'yellow'} icon={sol.status === 'FEASIBLE' ? 'check' : 'alert'}>
                        {sol.status === 'FEASIBLE' ? 'meets your goal' : 'closest miss'}
                      </Chip>
                      <ConfidencePill label={sol.confidence} compact />
                    </div>
                  </div>
                  <div className="kpi-strip" style={{ marginTop: 10 }}>
                    <div className="metric"><div className="label">Per kept order</div><div className="value sm">{inr(sol.metrics.per_kept.p50)}</div><div className="range">{inr(sol.metrics.per_kept.p10)}–{inr(sol.metrics.per_kept.p90)}</div></div>
                    <div className="metric"><div className="label">Orders / day</div><div className="value sm">{num(sol.metrics.orders_day.p50, 1)}</div><div className="range">floor {num(goal.min_orders, 0)}/day</div></div>
                    <div className="metric"><div className="label">Return + RTO</div><div className="value sm">{pct(sol.metrics.leakage.p50)}</div><div className="range">cap {pct(goal.max_return_rto, 0)}</div></div>
                    <div className="metric"><div className="label">Stock needed</div><div className="value sm">{num(sol.inventory_need_units, 0)}</div><div className="range">units / day</div></div>
                  </div>
                  <p className="small" style={{ marginTop: 8 }}>{sol.why}</p>
                </div>
              ))}
            </div>
          </Card>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <Card title="Why the other options were eliminated" right={<TruthLabel kind="estimated" />}>
              {r.elimination.map((line, i) => (
                <div className="reject-row" key={i}>
                  <Icon name="alert" color="#b45309" />
                  <span>{line}</span>
                </div>
              ))}
            </Card>
            <div className="col">
              <Card title="Today vs the goal" right={<TruthLabel kind="estimated" />}>
                <div className="kpi-strip">
                  <div className="metric"><div className="label">Now — per kept order</div><div className="value sm">{inr(r.current.metrics.per_kept.p50)}</div><div className="range">goal {inr(goal.target_contribution)}</div></div>
                  <div className="metric"><div className="label">Now — orders / day</div><div className="value sm">{num(r.current.metrics.orders_day.p50, 1)}</div><div className="range">floor {num(goal.min_orders, 0)}</div></div>
                  <div className="metric"><div className="label">Now — price</div><div className="value sm">{inr(r.current.price)}</div><div className="range">corridor {inr(s.corridor[0])}–{inr(s.corridor[1])}</div></div>
                </div>
              </Card>
              <Card title={`What '${r.mode}' mode is optimising`} right={<TruthLabel kind="illustrative" />}>
                {r.objective.weights.map((w) => (
                  <div key={w.name} className="row-tight" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
                    <span className="small">{w.name}</span>
                    <span className="small mono">{w.value}{w.unit}</span>
                  </div>
                ))}
                <p className="tiny muted" style={{ marginTop: 6 }}>{r.objective.weights.map((w) => w.note).join(' ')}</p>
              </Card>
            </div>
          </div>

          <div className="row-tight" style={{ marginTop: 16 }}>
            <Link className="btn btn-primary" to={`/seller/sku/${s.sku_id}/recommendation`}>See the full recommendation</Link>
            <button className="btn" onClick={() => { setToast('Reverse pricing recomputed'); rev.refetch() }}>Recompute</button>
          </div>
        </>
      ) : null}
    </div>
  )
}

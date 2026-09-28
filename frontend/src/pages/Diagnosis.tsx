import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Diagnosis as Dx, SkuDetail } from '../api/types'
import { useAsync } from '../state/session'
import { useGoal } from '../state/useGoal'
import { PageHead, SkuTabs } from '../components/layout'
import { FunnelChain } from '../components/charts'
import { Card, Chip, ErrorState, Icon, LoadingCard, RangeNumber, TruthLabel } from '../components/ui'
import { inr, num, pct } from '../lib/format'

const VERDICT_CLASS: Record<string, string> = {
  PRICE_WORKS: 'banner-works',
  PRICE_INFEASIBLE: 'banner-infeasible',
  NEEDS_EVIDENCE: 'banner-evidence',
  NOT_A_PRICE_PROBLEM: 'banner-notprice',
}

export default function Diagnosis() {
  const { skuId = '' } = useParams()
  const sku = useAsync<SkuDetail>(() => api.sku(skuId), [skuId])
  const [goal] = useGoal(sku.data?.goal ?? null)
  const dx = useAsync<Dx>(() => api.diagnosis(skuId), [skuId])

  if (sku.loading && !sku.data) return <div className="wrap"><LoadingCard title="Diagnosis" lines={6} /></div>
  if (sku.error) return <div className="wrap"><ErrorState message={sku.error} onRetry={sku.refetch} /></div>
  if (!sku.data) return null
  const s = sku.data
  const d = dx.data

  return (
    <div className="wrap wrap-wide">
      <PageHead sku={s} subtitle="is price even the problem?"
        right={<Chip kind="ghost" icon="info">Goal: {inr(goal.target_contribution)}/kept order · {num(goal.min_orders, 0)} orders/day</Chip>} />
      <SkuTabs skuId={s.sku_id} />

      {dx.loading && !d ? <LoadingCard title="Reading the funnel" lines={5} /> : dx.error ? (
        <ErrorState message={dx.error} onRetry={dx.refetch} />
      ) : d ? (
        <>
          <div className={`banner ${VERDICT_CLASS[d.verdict.id] ?? ''}`} style={{ marginBottom: 16 }}>
            <div className="row-tight" style={{ justifyContent: 'space-between' }}>
              <div>
                <p className="verdict-title">{d.verdict.title}</p>
                <p className="small muted" style={{ margin: 0 }}>
                  {d.verdict.subtitle} Best price in your corridor keeps{' '}
                  {inr(d.price_only.best_in_corridor_kept)} per kept order against your {inr(d.price_only.target)} floor
                  {d.price_only.shortfall > 0 ? <> — a shortfall of {inr(d.price_only.shortfall)}</> : <> — already above it</>}.
                </p>
              </div>
              <Chip kind={d.verdict.id === 'NOT_A_PRICE_PROBLEM' ? 'blue' : 'yellow'} icon={d.verdict.id === 'NOT_A_PRICE_PROBLEM' ? 'eye' : 'alert'}>
                {d.verdict.bottleneck}
              </Chip>
            </div>
          </div>

          <div className="grid-2">
            <Card title="The funnel, stage by stage" right={<TruthLabel kind="synthetic" />}
              note="Impressions → clicks → orders → kept, over the last 30 days of this listing, with the same-category percentile beside each step.">
              <FunnelChain steps={d.funnel} />
            </Card>

            <div className="col">
              <Card title="What the evidence says" right={<TruthLabel kind="synthetic" />}>
                {d.bottlenecks.length ? d.bottlenecks.map((b) => (
                  <div key={b.id} style={{ marginBottom: 12 }}>
                    <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                      <strong>{b.label}</strong>
                      <Chip kind={b.strength > 0.8 ? 'red' : 'yellow'}>strength {Math.round(b.strength * 100)}%</Chip>
                    </div>
                    <ul className="small" style={{ margin: '6px 0 0 18px' }}>
                      {b.evidence.map((e) => <li key={e}>{e}</li>)}
                    </ul>
                    <p className="small" style={{ marginTop: 6 }}>
                      <Icon name="spark" color="#7c3aed" /> <strong>Fix:</strong> {b.action}
                    </p>
                  </div>
                )) : <p className="small muted">No bottleneck stands out — this listing is broadly in line with its category.</p>}
                <p className="tiny muted" style={{ marginTop: 8 }}>
                  Assessed against {d.evidence.comparable_listings} comparable {d.evidence.category} listings. Strength is a
                  heuristic share of the funnel gap explained, not a model probability.
                </p>
              </Card>

              {d.expected_effect ? (
                <Card title={`If you do this: ${d.expected_effect.action}`} right={<TruthLabel kind="estimated" />}>
                  <RangeNumber value={d.expected_effect.per_kept} />
                  <p className="small muted" style={{ marginTop: 6 }}>
                    Contribution per kept order, at a price of {inr(d.expected_effect.price)} with the fix applied
                    {' '}<Chip kind="green">+{inr(d.expected_effect.delta_contribution_day)}/day</Chip>
                  </p>
                  <div className="kpi-strip" style={{ marginTop: 10 }}>
                    <div className="metric"><div className="label">Orders / day</div><div className="value sm">{num(d.expected_effect.orders_day.p50, 1)}</div><div className="range">{num(d.expected_effect.orders_day.p10, 1)}–{num(d.expected_effect.orders_day.p90, 1)}</div></div>
                    <div className="metric"><div className="label">Return + RTO</div><div className="value sm">{pct(d.expected_effect.leakage.p50)}</div><div className="range">cap {pct(goal.max_return_rto, 0)}</div></div>
                    <div className="metric"><div className="label">Contribution / day</div><div className="value sm">{inr(d.expected_effect.contribution_day.p50)}</div><div className="range">{d.expected_effect.confidence} confidence</div></div>
                  </div>
                  <div className="row-tight" style={{ marginTop: 12 }}>
                    <Link className="btn btn-primary btn-sm" to={`/seller/sku/${s.sku_id}/simulate`}>Model this in the simulator</Link>
                    <Link className="btn btn-sm" to={`/seller/sku/${s.sku_id}/recommendation`}>See the recommendation</Link>
                  </div>
                </Card>
              ) : null}
            </div>
          </div>

          <Card title="Where price sits in the diagnosis" right={<TruthLabel kind="estimated" />}>
            <p className="small" style={{ margin: 0 }}>
              At your listed price of {inr(s.price)} the model already expects{' '}
              <strong>{inr((d.price_only.best_in_corridor_kept))}</strong> per kept order — the best any price in your
              {` ${inr(s.corridor[0])}–${inr(s.corridor[1])} `}corridor would deliver is {inr(d.price_only.best_in_corridor_kept)}.
              {' '}A price move is therefore {d.verdict.id === 'NOT_A_PRICE_PROBLEM' ? 'not the lever that is binding' : 'part of the answer'}.
            </p>
            <p className="tiny muted" style={{ marginTop: 8 }}>
              Diagnosis is computed from {d.evidence.comparable_listings} comparable listings and the same four fitted
              models the simulator uses — no separate rule-of-thumb logic.
            </p>
          </Card>
        </>
      ) : null}
    </div>
  )
}

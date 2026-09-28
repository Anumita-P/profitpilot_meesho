import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Recommendation as Rec, RecommendationCard, SkuDetail } from '../api/types'
import type { HistoryItem } from '../api/client'
import { useAsync, useSession } from '../state/session'
import { useGoal, goalPayload } from '../state/useGoal'
import { PageHead, SkuTabs } from '../components/layout'
import { GoalForm } from '../components/GoalForm'
import { Card, Chip, ConstraintChipRow, ConfidencePill, ErrorState, GuardrailBar, Icon, LoadingCard, TruthLabel } from '../components/ui'
import { inr, num, pct } from '../lib/format'

const VERDICT_CLASS: Record<string, string> = {
  PRICE_WORKS: 'banner-works',
  PRICE_INFEASIBLE: 'banner-infeasible',
  NEEDS_EVIDENCE: 'banner-evidence',
  NOT_A_PRICE_PROBLEM: 'banner-notprice',
}

export default function Recommendation() {
  const { skuId = '' } = useParams()
  const { setToast } = useSession()
  const sku = useAsync<SkuDetail>(() => api.sku(skuId), [skuId])
  const [goal, setGoal] = useGoal(sku.data?.goal ?? null)
  const [applied, setApplied] = useState<string | null>(null)
  const rec = useAsync<Rec>(() => api.recommendation({ sku_id: skuId, goal: goalPayload(goal) }), [skuId, JSON.stringify(goal)])
  const history = useAsync<{ items: HistoryItem[] }>(() => api.history(), [skuId])

  if (sku.loading && !sku.data) return <div className="wrap"><LoadingCard title="Recommendation" lines={6} /></div>
  if (sku.error) return <div className="wrap"><ErrorState message={sku.error} onRetry={sku.refetch} /></div>
  if (!sku.data) return null
  const s = sku.data
  const r = rec.data
  const main = r?.recommendation ?? null

  const pick = async (card: RecommendationCard) => {
    try {
      await api.saveRecommendation({
        sku_id: s.sku_id, mode: goal.mode, goal: goalPayload(goal),
        intervention_id: card.id, price: card.params.price, intervention: card.params.iv,
      })
      setApplied(card.id)
      setToast(`${card.label} saved to your recommendations`)
      history.refetch()
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not save')
    }
  }

  return (
    <div className="wrap wrap-wide">
      <PageHead sku={s} right={<>
        {r ? <Chip kind="ghost">Model {r.model_version}</Chip> : null}
        <Link className="btn btn-sm" to={`/seller/sku/${s.sku_id}/simulate`}>Open simulator</Link>
      </>} />
      <SkuTabs skuId={s.sku_id} />

      {rec.loading && !r ? <LoadingCard title="Working out the recommendation" lines={5} /> : rec.error ? (
        <ErrorState message={rec.error} onRetry={rec.refetch} />
      ) : r ? (
        <>
          <div className={`banner ${VERDICT_CLASS[r.verdict] ?? ''}`} style={{ marginBottom: 16 }}>
            <div className="row-tight" style={{ justifyContent: 'space-between' }}>
              <div>
                <p className="verdict-title">{r.title}</p>
                <p className="small muted" style={{ margin: 0 }}>
                  {r.verdict === 'PRICE_INFEASIBLE' && (
                    <>Best price it could find: <strong>{inr(r.shortfall.best_in_corridor_price)}</strong> — that keeps{' '}
                    <strong>{inr(r.shortfall.per_kept)}</strong> per kept order ({inr(r.shortfall.contribution_shortfall_abs)} short of your {inr(r.shortfall.target)} floor) at{' '}
                    {num(r.shortfall.orders_day, 1)} orders/day ({num(r.shortfall.volume_shortfall_abs, 1)} below your {num(r.shortfall.min_orders, 0)}/day floor).</>
                  )}
                  {r.verdict === 'PRICE_WORKS' && main && (
                    <>Recommended: <strong>{main.id === 'PRICE' ? 'price change' : main.label}</strong>{' '}
                    {main.params.price !== r.current.price ? <>at <strong>{inr(main.params.price)}</strong> </> : 'at your current price '}
                    — {inr(main.metrics.per_kept.p50)} per kept order {main.status === 'FEASIBLE' ? '(feasible)' : '(step 1 of a ladder)'}.</>
                  )}
                  {r.verdict === 'NOT_A_PRICE_PROBLEM' && <>A price cut would cost you more contribution than it recovers. Fix the bottleneck below first.</>}
                  {r.verdict === 'NEEDS_EVIDENCE' && <>We do not have enough comparable observations to recommend a price responsibly. Widen the corridor, pick a similar listing, or run a two-arm test.</>}
                </p>
              </div>
              <div className="right">
                <Chip kind={r.verdict === 'PRICE_WORKS' ? 'green' : r.verdict === 'PRICE_INFEASIBLE' ? 'yellow' : r.verdict === 'NEEDS_EVIDENCE' ? 'yellow' : 'blue'} icon={r.verdict === 'PRICE_WORKS' ? 'check' : 'alert'}>
                  {r.verdict.replace(/_/g, ' ').toLowerCase()}
                </Chip>
                <div style={{ marginTop: 6 }}><ConfidencePill label={r.confidence.label} block={r.confidence} /></div>
              </div>
            </div>
            {r.banner ? <p className="small" style={{ margin: '10px 0 0' }}><strong>{r.banner}</strong></p> : null}
            {r.reach && main?.status !== 'FEASIBLE' ? (
              <div className="note note-info" style={{ marginTop: 12 }}>
                <Icon name="info" color="#1d4ed8" />
                <span className="small">
                  The goal price is <strong>{inr(r.reach.price)}</strong> — {r.reach.steps} guarded steps away.
                  Today&apos;s move is capped at 12% of {inr(r.current.price)}.
                </span>
              </div>
            ) : null}
          </div>

          {main ? (
            <div className="grid-2">
              <Card title={`Recommendation — ${main.label}`} right={<TruthLabel kind="estimated" />}
                note={main.ladder
                  ? `Step ${main.ladder.step} of ${main.ladder.steps} towards ${inr(main.ladder.target_price)}.`
                  : main.id === 'PRICE'
                    ? 'One price move, inside the corridor, above your floor.'
                    : `One operational change, evaluated at ${inr(main.params.price)} — the price itself stays where it is.`}>
                <div className="answer-grid">
                  {([['What', main.answer.what], ['Why', main.answer.why], ['Expected impact', main.answer.expected_impact], ['Risk', main.answer.risk], ['What would change this', main.answer.what_would_change_this]] as const).map(([h, body]) => (
                    <div className="answer" key={h}>
                      <h4>{h}</h4>
                      <p>{body}</p>
                    </div>
                  ))}
                </div>
                {main.answer.next_step ? <p className="small muted" style={{ marginTop: 10 }}>{main.answer.next_step}</p> : null}
                <div className="hr" />
                <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                  <span className="small muted">Compared with today</span>
                  <span className="small">{main.tradeoffs.join(' · ')}</span>
                </div>
                <div style={{ marginTop: 12 }}>
                  <ConstraintChipRow constraints={main.constraints} />
                </div>
                <div className="row-tight" style={{ marginTop: 12 }}>
                  <button className="btn btn-primary" onClick={() => pick(main)} disabled={applied === main.id}>
                    {applied === main.id ? <><Icon name="check" /> Saved</> : 'Save this recommendation'}
                  </button>
                  <Link className="btn" to={`/seller/sku/${s.sku_id}/simulate`}>Test it in the simulator</Link>
                </div>
              </Card>

              <div className="col">
                <Card title="Your goal" right={<TruthLabel kind="illustrative" />}>
                  <GoalForm value={goal} onChange={setGoal} compact />
                  <div className="hr" />
                  <p className="tiny muted">
                    Shortfall is measured against <em>this</em> goal. Relaxing the floor or the volume target is a
                    business decision — ProfitPilot tells you the size of the gap, not what you should accept.
                  </p>
                </Card>

                {r.shortfall.binding.length ? (
                  <Card title="What is actually binding" right={<Chip kind="yellow">relaxing these would unlock a price</Chip>}>
                    {r.shortfall.binding.includes('contribution') ? (
                      <div className="reject-row">
                        <Icon name="alert" color="#b45309" />
                        <span>Contribution floor: lower it from <strong>{inr(r.shortfall.target)}</strong> to{' '}
                          <strong>{inr(Math.floor(r.shortfall.per_kept))}</strong> to make {inr(r.shortfall.best_in_corridor_price)} work.</span>
                      </div>
                    ) : null}
                    {r.shortfall.binding.includes('volume') ? (
                      <div className="reject-row">
                        <Icon name="alert" color="#b45309" />
                        <span>Volume floor: lower it from <strong>{num(r.shortfall.min_orders, 0)}</strong> to{' '}
                          <strong>{num(r.shortfall.orders_day, 1)}</strong> orders/day for the same price to qualify.</span>
                      </div>
                    ) : null}
                    <p className="tiny muted" style={{ marginTop: 8 }}>
                      ProfitPilot never relaxes a seller&apos;s constraints on its own.
                    </p>
                  </Card>
                ) : null}

                <Card title="Sensitivity" right={<Chip kind={r.sensitivity.robust ? 'green' : 'yellow'}>{r.sensitivity.robust ? 'robust' : 'sensitive'}</Chip>}>
                  <p className="small" style={{ margin: 0 }}>{r.sensitivity.statement}</p>
                  <p className="tiny muted" style={{ marginTop: 6 }}>
                    Tested at ±50% on demand elasticity, the COD price effect, the return level and freight cost.
                  </p>
                </Card>
              </div>
            </div>
          ) : null}

          {r.interventions.length ? (
            <Card title="Other ways to fix the economics" right={<TruthLabel kind="estimated" />}
              note="Ranked by expected contribution per day, then by how many changes they need. Every option is priced on the same fitted models as the price recommendation.">
              <div className="col">
                {r.interventions.map((card) => (
                  <div key={card.id} className="card card-pad">
                    <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                      <div>
                        <strong>{card.label}</strong>
                        <div className="tiny muted">
                          {card.params.bundle_price ? <>bundle at {inr(card.params.bundle_price)} ({inr(card.params.price)} per unit equivalent)</> : <>at {inr(card.params.price)}</>}
                          {card.params.units_per_order && card.params.units_per_order > 1 ? <> · {card.params.units_per_order} units per order</> : null}
                        </div>
                      </div>
                      <div className="row-tight">
                        <Chip kind={card.status === 'FEASIBLE' ? 'green' : card.status === 'NEAR_MISS' ? 'yellow' : 'red'} icon={card.status === 'FEASIBLE' ? 'check' : 'alert'}>
                          {card.status === 'FEASIBLE' ? 'meets your goal' : card.status === 'NEAR_MISS' ? 'close — misses by a little' : 'does not meet your goal'}
                        </Chip>
                        <ConfidencePill label={card.confidence} compact />
                      </div>
                    </div>
                    <div className="kpi-strip" style={{ marginTop: 10 }}>
                      <div className="metric"><div className="label">Per kept order</div><div className="value sm">{inr(card.metrics.per_kept.p50)}</div><div className="range">{inr(card.metrics.per_kept.p10)}–{inr(card.metrics.per_kept.p90)}</div></div>
                      <div className="metric"><div className="label">Orders / day</div><div className="value sm">{num(card.metrics.orders_day.p50, 1)}</div><div className="range">{num(card.metrics.orders_day.p10, 1)}–{num(card.metrics.orders_day.p90, 1)}</div></div>
                      <div className="metric"><div className="label">Return + RTO</div><div className="value sm">{pct(card.metrics.leakage.p50)}</div><div className="range">cap {pct(goal.max_return_rto, 0)}</div></div>
                      <div className="metric"><div className="label">Contribution / day</div><div className="value sm">{inr(card.metrics.contribution_day.p50)}</div><div className="range">{card.tradeoffs[0] ?? ''}</div></div>
                    </div>
                    <p className="small" style={{ marginTop: 10 }}>{card.why}</p>
                    <div className="row-tight" style={{ marginTop: 8 }}>
                      <button className="btn btn-sm btn-primary" onClick={() => pick(card)} disabled={applied === card.id}>
                        {applied === card.id ? <><Icon name="check" /> Saved</> : 'Save this option'}
                      </button>
                      <Link className="btn btn-sm" to={`/seller/sku/${s.sku_id}/simulate`}>Test it</Link>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {r.considered_and_rejected.length ? (
            <Card title="Considered and rejected" right={<Chip kind="ghost">with the reason</Chip>}
              note="We never bury a rejected option: if it fails, the constraint it fails is shown.">
              {r.considered_and_rejected.map((rej) => (
                <div className="reject-row" key={rej.id}>
                  <Icon name="alert" color="#b45309" />
                  <span><strong>{rej.label ?? rej.id}</strong> — {rej.reason}</span>
                </div>
              ))}
            </Card>
          ) : null}

          {r.also_consider ? (
            <div className="note note-info" style={{ marginTop: 16 }}>
              <Icon name="spark" color="#1d4ed8" />
              <span className="small">
                Worth a look: <strong>{r.also_consider.label}</strong> adds about {inr(r.also_consider.gain_per_day)}/day beyond
                the price move — {'>'}view it in the simulator with one click.
              </span>
            </div>
          ) : null}

          <div style={{ marginTop: 16 }}><GuardrailBar guardrails={r.guardrails} /></div>
        </>
      ) : null}

      <Card title="Saved recommendations" right={<TruthLabel kind="estimated" />} className="card-pad">
        {history.data?.items.length ? (
          <table>
            <thead><tr><th>When</th><th>Option</th><th className="num">Price</th><th>Confidence</th><th>Status</th><th /></tr></thead>
            <tbody>
              {history.data.items.map((h) => (
                <tr key={h.id}>
                  <td className="small">{new Date(h.created_at).toLocaleString('en-IN')}</td>
                  <td className="small">{h.intervention.id}</td>
                  <td className="num">{inr(h.intervention.price)}</td>
                  <td className="small">{h.confidence}</td>
                  <td className="small">{h.status}</td>
                  <td className="right">
                    {h.status !== 'rolled_back'
                      ? <button className="btn btn-sm" onClick={async () => { await api.rollback(h.id); setToast('Rolled back — nothing was ever changed on the marketplace'); history.refetch() }}>Roll back</button>
                      : <Chip kind="ghost">rolled back</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="small muted">Nothing saved yet. Saving a recommendation is a demo action: ProfitPilot never changes a live price.</p>}
      </Card>
    </div>
  )
}

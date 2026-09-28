import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Goal } from '../api/types'
import type { GoalPreview } from '../api/client'
import { useAsync, useSession } from '../state/session'
import { DEFAULT_GOAL, GoalForm, MODE_COPY } from '../components/GoalForm'
import { Card, Chip, ErrorState, LoadingCard, StatusPill, TruthLabel } from '../components/ui'
import { inr, num } from '../lib/format'

export default function GoalSettings() {
  const { setToast } = useSession()
  const catalog = useAsync(() => api.catalog('all', 'contribution'), [])
  const [skuId, setSkuId] = useState<string | null>(null)
  const [goal, setGoal] = useState<Goal>(DEFAULT_GOAL)
  const [preview, setPreview] = useState<GoalPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [savedFor, setSavedFor] = useState<string | null>(null)

  const rows = catalog.data?.skus ?? []
  const active = skuId ?? rows[0]?.sku_id ?? null
  const activeRow = rows.find((r) => r.sku_id === active) ?? null

  const pick = (id: string, g: Goal) => {
    setSkuId(id)
    setGoal(g)
    setPreview(null)
    setSavedFor(null)
  }

  const runPreview = async () => {
    if (!active) return
    setBusy(true)
    try {
      const res = await api.previewGoal({ sku_id: active, goal, mode: goal.mode })
      setPreview(res)
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Preview failed')
    } finally { setBusy(false) }
  }

  const save = async () => {
    if (!active) return
    setBusy(true)
    try {
      await api.saveGoal({ sku_id: active, goal, mode: goal.mode })
      setSavedFor(active)
      setToast('Goal saved for this listing')
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not save the goal')
    } finally { setBusy(false) }
  }

  const previewLine = preview
    ? preview.verdict_hint === 'PRICE_WORKS'
      ? `A price can reach this goal: ₹${Math.round(preview.best_in_corridor.price)} in your corridor keeps ${inr(preview.best_in_corridor.per_kept)} per kept order at ${num(preview.best_in_corridor.orders_day, 1)} orders/day.`
      : `No price in the corridor reaches this goal on its own. The best is ₹${Math.round(preview.best_in_corridor.price)} — ${inr(preview.shortfall.contribution_shortfall_abs)} short per kept order${preview.shortfall.volume_shortfall_abs > 0 ? ` and ${num(preview.shortfall.volume_shortfall_abs, 1)} orders/day short` : ''}.`
    : null

  return (
    <div className="wrap wrap-wide">
      <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div className="crumbs">Goal settings</div>
          <h1>What each listing has to deliver</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Goals are per listing and per seller. Every verdict, shortfall and recommendation in ProfitPilot is measured
            against the goal you set here.
          </p>
        </div>
        <Chip kind="ghost" icon="lock">ProfitPilot never relaxes your goal on its own</Chip>
      </div>

      <div className="grid-2">
        <Card title="Your listings" right={<TruthLabel kind="estimated" />}
          note="Pick a listing to set its goal. The status shown is computed at your current saved goal.">
          {catalog.loading && !catalog.data ? <LoadingCard lines={5} /> : catalog.error ? (
            <ErrorState message={catalog.error} onRetry={catalog.refetch} />
          ) : (
            <div className="col">
              {rows.map((r) => (
                <button key={r.sku_id} className={`row-tight ${active === r.sku_id ? 'row-active' : ''}`}
                  style={{ justifyContent: 'space-between', width: '100%', padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 8, background: active === r.sku_id ? 'var(--violet-50)' : '#fff', cursor: 'pointer' }}
                  onClick={() => pick(r.sku_id, { target_contribution: 60, min_orders: 20, max_return_rto: 0.15, cash_limit: 75000, mode: 'margin' })}>
                  <span className="left">
                    <strong className="small">{r.name}</strong>
                    <span className="tiny muted">{r.sku_id} · {r.category} · {inr(r.price)}</span>
                  </span>
                  <span className="row-tight">
                    <span className="tiny mono"> {inr(r.estimated.per_kept.p50)}/kept</span>
                    <StatusPill status={r.status} />
                  </span>
                </button>
              ))}
              <p className="tiny muted">
                Starting point is your default goal: {inr(DEFAULT_GOAL.target_contribution)} per kept order,{' '}
                {num(DEFAULT_GOAL.min_orders, 0)} orders/day, {Math.round(DEFAULT_GOAL.max_return_rto * 100)}% return+RTO cap.
              </p>
            </div>
          )}
        </Card>

        <div className="col">
          <Card title={activeRow ? `Goal for ${activeRow.name}` : 'Goal'} right={<TruthLabel kind="illustrative" />}
            note={`Mode: ${MODE_COPY[goal.mode].label} — ${MODE_COPY[goal.mode].note}`}>
            <GoalForm value={goal} onChange={setGoal} onSubmit={save} onPreview={runPreview} submitting={busy}
              previewLine={previewLine} saved={savedFor === active} />
          </Card>

          <Card title="How the goal is used" right={<Chip kind="ghost">no hidden relaxation</Chip>}>
            <ul className="small" style={{ margin: '0 0 0 18px' }}>
              <li><strong>Contribution floor</strong> — the per-kept-order number a candidate price must clear.</li>
              <li><strong>Volume floor</strong> — prices that fall below it are shown, but never recommended.</li>
              <li><strong>Return + RTO cap</strong> — a hard constraint, not a scoring penalty.</li>
              <li><strong>Cash limit</strong> — caps the working capital a plan may tie up; leave it empty for no limit.</li>
              <li><strong>Mode</strong> — changes the objective weights (risk aversion, volume weight, cash penalty).</li>
            </ul>
            <div className="hr" />
            <p className="small" style={{ margin: 0 }}>
              When nothing works, ProfitPilot says so and ranks interventions instead — it never quietly lowers your floor to
              make a price look feasible. You can see the same rule in action on any listing:
            </p>
            <div className="row-tight" style={{ marginTop: 10 }}>
              {activeRow ? <Link className="btn btn-primary btn-sm" to={`/seller/sku/${activeRow.sku_id}/recommendation`}>Open this listing&apos;s recommendation</Link> : null}
              {activeRow ? <Link className="btn btn-sm" to={`/seller/sku/${activeRow.sku_id}/reverse`}>Reverse pricing</Link> : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

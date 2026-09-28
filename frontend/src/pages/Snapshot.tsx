import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { SkuDetail, Snapshot as SnapshotT } from '../api/types'
import { useAsync, useSession } from '../state/session'
import { useGoal, goalPayload } from '../state/useGoal'
import { PageHead, SkuTabs } from '../components/layout'
import { GoalForm } from '../components/GoalForm'
import { Waterfall } from '../components/charts'
import { Card, Chip, ErrorState, Icon, LoadingCard, MetricBlock, RangeNumber, StatusPill, TruthLabel } from '../components/ui'
import { inr, num, pct } from '../lib/format'

export default function Snapshot() {
  const { skuId = '' } = useParams()
  const { setToast } = useSession()
  const sku = useAsync<SkuDetail>(() => api.sku(skuId), [skuId])
  const snap = useAsync<SnapshotT>(() => api.snapshot(skuId), [skuId])
  const [goal, setGoal] = useGoal(sku.data?.goal ?? null)
  const [saved, setSaved] = useState(false)

  if (sku.loading && !sku.data) return <div className="wrap"><LoadingCard title="Listing snapshot" lines={6} /></div>
  if (sku.error) return <div className="wrap"><ErrorState message={sku.error} onRetry={sku.refetch} /></div>
  if (!sku.data) return null
  const s = sku.data

  const saveGoal = async () => {
    try {
      await api.saveGoal({ sku_id: s.sku_id, goal: goalPayload(goal) })
      setSaved(true)
      setToast('Goal saved to your account')
      snap.refetch()
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Could not save the goal')
    }
  }

  const hero = snap.data?.hero
  const sec = snap.data?.secondary ?? {}
  const observed = snap.data?.observed ?? {}

  return (
    <div className="wrap wrap-wide">
      <PageHead sku={s} right={<>
        <StatusPill status={s.status} />
        <Chip kind="ghost">Listed at {inr(s.price)}</Chip>
        <Chip kind="ghost">Corridor {inr(s.corridor[0])}–{inr(s.corridor[1])}</Chip>
      </>} />
      <SkuTabs skuId={s.sku_id} />

      {s.demo_role ? (
        <div className="note note-info" style={{ marginBottom: 16 }}>
          <Icon name="flask" color="#1d4ed8" />
          <span><strong>Demo listing.</strong> {s.demo_role}. Flags: {Object.entries(s.flags).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}.</span>
        </div>
      ) : null}

      <div className="grid-2">
        <Card title="Your goal is the yardstick" right={<TruthLabel kind="illustrative" />}
          note="Saved on your account. Every recommendation, verdict and shortfall number is measured against it.">
          <GoalForm value={goal} onChange={(g) => { setGoal(g); setSaved(false) }} onSubmit={saveGoal} saved={saved} />
        </Card>

        <div className="col">
          <Card title="Today, at your current price" right={hero ? <Chip kind={hero.confidence.label === 'Low' ? 'red' : hero.confidence.label === 'Medium' ? 'yellow' : 'green'}>{hero.confidence.label} confidence</Chip> : null}>
            {snap.loading && !snap.data ? <LoadingCard lines={3} /> : snap.error ? <ErrorState message={snap.error} onRetry={snap.refetch} /> : hero ? (
              <>
                <RangeNumber value={hero.value} tone={hero.value.p50 < goal.target_contribution ? 'bad' : 'good'} />
                <p className="small muted" style={{ marginTop: 6 }}>
                  Contribution per kept order {hero.value.p50 < goal.target_contribution
                    ? <>is <strong>{inr(goal.target_contribution - hero.value.p50)} short</strong> of your {inr(goal.target_contribution)} floor.</>
                    : <>clears your {inr(goal.target_contribution)} floor.</>}
                </p>
                <div className="hr" />
                <div className="kpi-strip">
                  <MetricBlock label="Orders / day" value={sec.orders_day} format={(v) => num(v, 1)} />
                  <MetricBlock label="Kept orders / day" value={sec.kept_orders_day} format={(v) => num(v, 1)} />
                  <MetricBlock label="Return + RTO" value={sec.leakage} format={(v) => pct(v)} tone={(sec.leakage?.p50 ?? 0) > goal.max_return_rto ? 'bad' : 'good'} />
                  <MetricBlock label="Working capital" value={sec.working_capital} format={(v) => inr(v, { compact: true })} />
                </div>
                <div className="row-tight" style={{ marginTop: 12 }}>
                  <TruthLabel kind="estimated" />
                  <Chip kind="ghost" icon="info">{hero.confidence.n_comparable.toLocaleString('en-IN')} comparable SKU-days near {inr(s.price)}</Chip>
                </div>
              </>
            ) : null}
          </Card>

          <div className="row-tight">
            <Link className="btn btn-primary" to={`/seller/sku/${s.sku_id}/simulate`}>Simulate a price change</Link>
            <Link className="btn" to={`/seller/sku/${s.sku_id}/reverse`}>What price do I need?</Link>
            <Link className="btn" to={`/seller/sku/${s.sku_id}/diagnosis`}>Why are sales low?</Link>
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <Card title="Where each ₹ of the price goes" right={<TruthLabel kind="illustrative" />}
          note="Costs are Illustrative prototype inputs — in production they come from the seller's own ledger.">
          {snap.data ? <Waterfall steps={snap.data.waterfall} /> : <LoadingCard lines={6} />}
        </Card>

        <div className="col">
          <Card title="Last observed day" right={<TruthLabel kind="synthetic" />}
            note="One row of the generated 30-day history, so you can compare what the models estimate with what the simulator recorded.">
            {observed.date ? (
              <div className="kpi-strip">
                <MetricBlock label="Orders" value={Number(observed.orders)} format={(v) => num(v, 0)} />
                <MetricBlock label="Kept" value={Number(observed.kept)} format={(v) => num(v, 0)} />
                <MetricBlock label="NM V" value={Number(observed.nmv)} />
                <MetricBlock label="Price that day" value={Number(observed.price)} />
              </div>
            ) : <p className="small muted">{String(observed.note ?? 'No history for this listing yet.')}</p>}
            {observed.date ? <p className="tiny muted" style={{ marginTop: 8 }}>Observed on {String(observed.date)} — the ladder price differs from your listed price because the simulator randomises prices to make the data informative.</p> : null}
          </Card>

          <Card title="Evidence behind these numbers" right={<TruthLabel kind="synthetic" />}>
            <div className="row-tight" style={{ justifyContent: 'space-between' }}>
              <span className="small">Comparable price observations in {s.category}</span>
              <strong className="small">{hero?.confidence.n_eff !== undefined ? hero.confidence.n_eff.toLocaleString('en-IN') : '—'} weighted</strong>
            </div>
            <div className="row-tight" style={{ justifyContent: 'space-between' }}>
              <span className="small">Calibration error (worst model, ECE)</span>
              <strong className="small">{snap.data ? pct(0.0071, 2) : '—'}</strong>
            </div>
            <p className="tiny muted" style={{ marginTop: 8 }}>
              Confidence is {hero?.confidence.label ?? '—'} because of comparable evidence, band width and calibration.
              The full rule is on the tooltip.
            </p>
          </Card>
        </div>
      </div>

      {snap.data ? (
        <ul className="tiny muted" style={{ marginTop: 16 }}>
          {snap.data.footnotes.map((f) => <li key={f}>{f}</li>)}
        </ul>
      ) : null}
    </div>
  )
}

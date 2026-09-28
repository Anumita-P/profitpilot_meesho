import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Catalog } from '../api/types'
import type { HistoryItem } from '../api/client'
import { useAsync, useSession } from '../state/session'
import { Card, Chip, EmptyState, ErrorState, Icon, LoadingCard, TruthLabel } from '../components/ui'
import { inr, num, pct } from '../lib/format'

const STATUS_LABEL: Record<string, string> = {
  saved: 'saved', applied_simulated: 'applied (simulated)', rolled_back: 'rolled back',
}

export default function History() {
  const { setToast } = useSession()
  const history = useAsync<{ items: HistoryItem[] }>(() => api.history(), [])
  const catalog = useAsync<Catalog>(() => api.catalog('all', 'contribution'), [])
  const [sku, setSku] = useState('all')
  const [status, setStatus] = useState('all')
  const [busy, setBusy] = useState<number | null>(null)

  const items = history.data?.items ?? []
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of catalog.data?.skus ?? []) m.set(r.sku_id, r.name)
    return m
  }, [catalog.data])

  const rows = items.filter((r) => (sku === 'all' || r.sku_id === sku) && (status === 'all' || r.status === status))
  const applied = items.filter((r) => r.status === 'applied_simulated').length
  const listings = new Set(items.map((r) => r.sku_id)).size

  const act = async (id: number, kind: 'apply' | 'rollback') => {
    setBusy(id)
    try {
      if (kind === 'apply') { await api.applySimulated(id); setToast('Applied in the simulated rollout — no live price was changed') }
      else { await api.rollback(id); setToast('Rolled back — nothing was ever changed on the marketplace') }
      history.refetch()
    } catch (e) {
      setToast(e instanceof Error ? e.message : 'Action failed')
    } finally { setBusy(null) }
  }

  return (
    <div className="wrap wrap-wide">
      <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div className="crumbs">Recommendation history</div>
          <h1>Everything you have saved or applied</h1>
          <p className="muted small" style={{ margin: 0 }}>
            A record of the advice you generated, with the numbers the server recomputed when it was saved. Applying
            here means applying inside the simulator — ProfitPilot has no write access to any marketplace.
          </p>
        </div>
        <Chip kind="ghost" icon="lock">Audit log carries no request bodies and no buyer data</Chip>
      </div>

      {history.data && items.length ? (
        <div className="kpi-strip" style={{ marginBottom: 16 }}>
          <div className="metric"><div className="label">Saved options</div><div className="value sm">{items.length}</div><div className="range">latest 20 shown</div></div>
          <div className="metric"><div className="label">Applied (simulated)</div><div className="value sm">{applied}</div><div className="range">reversible at any time</div></div>
          <div className="metric"><div className="label">Listings covered</div><div className="value sm">{listings}</div><div className="range">out of {catalog.data?.total ?? '—'} in your catalog</div></div>
          <div className="metric"><div className="label">Model version</div><div className="value sm mono">{items[0]?.model_version ?? '—'}</div><div className="range">recomputed at save time</div></div>
        </div>
      ) : null}

      <div className="row-tight" style={{ marginBottom: 12 }}>
        <label className="small" htmlFor="fsku" style={{ margin: 0 }}>Listing</label>
        <select id="fsku" value={sku} onChange={(e) => setSku(e.target.value)}>
          <option value="all">All listings</option>
          {(catalog.data?.skus ?? []).map((s) => <option key={s.sku_id} value={s.sku_id}>{s.sku_id} — {s.name}</option>)}
        </select>
        <label className="small" htmlFor="fstatus" style={{ margin: 0 }}>Status</label>
        <select id="fstatus" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="saved">Saved</option>
          <option value="applied_simulated">Applied (simulated)</option>
          <option value="rolled_back">Rolled back</option>
        </select>
        <span className="spacer" />
        <Chip kind="ghost">{rows.length} of {items.length}</Chip>
      </div>

      <Card title="Saved recommendations" right={<TruthLabel kind="estimated" />}>
        {history.loading && !history.data ? <LoadingCard lines={5} /> : history.error ? (
          <ErrorState message={history.error} onRetry={history.refetch} />
        ) : rows.length === 0 ? (
          <EmptyState title="Nothing here yet" body="Save a recommendation from any listing and it appears here, with the numbers the server recomputed at that moment."
            action={<Link className="btn btn-primary" to="/seller/catalog">Go to the catalog</Link>} />
        ) : (
          <table>
            <thead>
              <tr><th>Saved</th><th>Listing</th><th>Option</th><th className="num">Price</th><th className="num">₹/kept order</th><th className="num">Orders/day</th><th className="num">Return + RTO</th><th>Confidence</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="small">{new Date(r.created_at).toLocaleString('en-IN')}</td>
                  <td className="small">
                    <Link to={`/seller/sku/${r.sku_id}/recommendation`} className="mono">{r.sku_id}</Link>
                    <div className="tiny muted">{names.get(r.sku_id) ?? ''}</div>
                  </td>
                  <td className="small">{r.intervention.id === 'PRICE' ? 'Price change' : r.intervention.id.replace(/\+/g, ' + ')}</td>
                  <td className="num">{inr(r.intervention.price)}</td>
                  <td className="num">{r.expected?.per_kept ? inr(r.expected.per_kept.p50) : '—'}</td>
                  <td className="num">{r.expected?.orders_day ? num(r.expected.orders_day.p50, 1) : '—'}</td>
                  <td className="num">{r.expected?.leakage ? pct(r.expected.leakage.p50) : '—'}</td>
                  <td><Chip kind={r.confidence === 'High' ? 'green' : r.confidence === 'Medium' ? 'yellow' : 'red'}>{r.confidence}</Chip></td>
                  <td><Chip kind={r.status === 'applied_simulated' ? 'green' : r.status === 'rolled_back' ? 'ghost' : 'blue'}>{STATUS_LABEL[r.status] ?? r.status}</Chip></td>
                  <td className="right">
                    <div className="row-tight" style={{ justifyContent: 'flex-end' }}>
                      {r.status === 'saved' ? <button className="btn btn-sm" disabled={busy === r.id} onClick={() => act(r.id, 'apply')}><Icon name="check" /> Apply (simulated)</button> : null}
                      {r.status !== 'rolled_back' ? <button className="btn btn-sm" disabled={busy === r.id} onClick={() => act(r.id, 'rollback')}>Roll back</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <Card title="Why keep a history at all" right={<Chip kind="ghost">governance</Chip>}>
          <p className="small" style={{ margin: 0 }}>
            Pricing advice is only auditable if you can see what produced it. Each row keeps the option, the price, the
            server-recomputed estimates and the model version, so a later review can ask whether the recommendation was
            reasonable <em>given what was known then</em>.
          </p>
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Audit events record the action, the actor and the entity — never request bodies and never buyer-level data.
          </p>
        </Card>
        <Card title="About the numbers in this table" right={<TruthLabel kind="estimated" />}>
          <p className="small" style={{ margin: 0 }}>
            Every metric is recomputed server-side when you save, from the fitted models — the browser's numbers are
            never trusted. Ranges behind each value are p10–p90 across the 30 bootstrap members.
          </p>
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Applying a recommendation changes only demo state in the database. Rolling it back restores the previous
            status, which is what the guardrail demonstration on the employee view counts.
          </p>
        </Card>
      </div>
    </div>
  )
}

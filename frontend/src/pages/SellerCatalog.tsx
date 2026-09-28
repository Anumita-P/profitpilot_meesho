import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { Band, Catalog } from '../api/types'
import { useAsync, useSession } from '../state/session'
import { Card, Chip, EmptyState, ErrorState, Icon, LoadingCard, MetricBlock, StatusPill, TruthLabel } from '../components/ui'
import { inr, num } from '../lib/format'

const FILTERS = [
  ['all', 'All listings'], ['losing', 'Losing money'], ['watch', 'Watch'], ['healthy', 'Healthy'],
] as const

export default function SellerCatalog() {
  const { me, setToast } = useSession()
  const [status, setStatus] = useState<string>('all')
  const [sort, setSort] = useState<string>('contribution')
  const { data, error, loading, refetch } = useAsync<Catalog>(() => api.catalog(status, sort), [status, sort])

  if (loading && !data) return <div className="wrap"><LoadingCard title="Your catalog" lines={5} /></div>
  if (error) return <div className="wrap"><ErrorState message={error} onRetry={refetch} /></div>
  if (!data) return null

  // Every number below comes from the API response: the floor is the seller's own saved goal,
  // never a constant in the client.
  const floor = data.skus.find((s) => s.goal)?.goal?.target_contribution ?? null
  const contributionDay = data.skus.reduce((a, s) => a + (s.estimated.contribution_day?.p50 ?? 0), 0)
  const belowFloor = data.skus.filter((s) => floor !== null && (s.estimated.per_kept?.p50 ?? 0) < floor)
  const ordersDay = data.skus.reduce((a, s) => a + (s.estimated.orders_day?.p50 ?? 0), 0)

  return (
    <div className="wrap wrap-wide">
      <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>{me?.seller?.name ?? 'Your'} catalog</h1>
          <p className="muted small">{data.summary} · every figure below is the fitted model&apos;s estimate for today&apos;s price.</p>
        </div>
        <div className="row-tight">
          <TruthLabel kind="estimated" />
          <Chip kind="ghost" icon="info">{me?.seller?.city} · {me?.seller?.default_mode} mode</Chip>
        </div>
      </div>

      {/* four primary numbers, no KPI wall */}
      <Card className="card-pad" title="What the catalog adds up to" right={<TruthLabel kind="estimated" />}>
        <div className="kpi-strip">
          <MetricBlock label="Listings" value={data.total} format={(v) => num(v, 0)} note={`${data.losing} losing money · ${data.watch} on watch`} />
          <MetricBlock label="Orders per day" value={ordersDay} format={(v) => num(v, 1)} />
          <MetricBlock label="Contribution per day" value={contributionDay} />
          <MetricBlock label={floor !== null ? `Listings below your ${inr(floor)} floor` : 'Listings below your floor'}
            value={belowFloor.length} format={(v) => num(v, 0)} tone={belowFloor.length ? 'bad' : 'good'} />
        </div>
      </Card>

      <div className="row-tight" style={{ margin: '16px 0 8px' }}>
        {FILTERS.map(([id, label]) => (
          <button key={id} className={`btn btn-sm ${status === id ? 'btn-primary' : ''}`} onClick={() => setStatus(id)} aria-pressed={status === id}>
            {label}{id === 'losing' ? ` (${data.losing})` : id === 'watch' ? ` (${data.watch})` : ''}
          </button>
        ))}
        <span className="spacer" style={{ flex: 1 }} />
        <label className="small muted" htmlFor="sort" style={{ margin: 0 }}>Sort</label>
        <select id="sort" value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 190 }}>
          <option value="contribution">Contribution per day</option>
          <option value="orders">Orders per day</option>
          <option value="name">Name</option>
        </select>
      </div>

      <Card>
        {data.skus.length === 0 ? (
          <EmptyState title="Nothing in this filter" body="Try another status filter — every listing is still there." />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Listing</th>
                <th>Status</th>
                <th className="num">Price</th>
                <th className="num">Contribution / kept order</th>
                <th className="num">Orders / day</th>
                <th className="num">Return + RTO</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.skus.map((s) => {
                const perKept: Band | undefined = s.estimated.per_kept
                const leak: Band | undefined = s.estimated.leakage
                const below = floor !== null && (perKept?.p50 ?? 0) < floor
                return (
                  <tr key={s.sku_id}>
                    <td>
                      <Link to={`/seller/sku/${s.sku_id}`}><strong>{s.name}</strong></Link>
                      <div className="tiny muted">
                        <span className="mono">{s.sku_id}</span> · {s.category}
                        {s.demo_role ? <> · <em>{s.demo_role}</em></> : null}
                      </div>
                    </td>
                    <td><StatusPill status={s.status} /></td>
                    <td className="num">{inr(s.price)}<div className="tiny muted">₹{s.corridor[0]}–₹{s.corridor[1]}</div></td>
                    <td className="num" style={{ color: below ? 'var(--red-700)' : undefined }}>
                      {perKept ? <>{inr(perKept.p50)}<div className="tiny muted">range {inr(perKept.p10)}–{inr(perKept.p90)}</div></> : '—'}
                    </td>
                    <td className="num">{s.estimated.orders_day ? num(s.estimated.orders_day.p50, 1) : '—'}</td>
                    <td className="num">{leak ? `${(leak.p50 * 100).toFixed(1)}%` : '—'}</td>
                    <td className="right nowrap">
                      <Link className="btn btn-sm" to={`/seller/sku/${s.sku_id}/recommendation`}>Recommendation</Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      <div className="row-tight" style={{ marginTop: 16 }}>
        <Link className="btn btn-primary" to="/seller/sku/K-101/simulate">Open the price simulator on K-101</Link>
        <button className="btn" onClick={() => { refetch(); setToast('Catalog refreshed') }}>
          <Icon name="spark" /> Refresh estimates
        </button>
        <Link className="btn btn-ghost" to="/seller/sku/K-207/reverse">Try: “what price do I need?”</Link>
      </div>
    </div>
  )
}

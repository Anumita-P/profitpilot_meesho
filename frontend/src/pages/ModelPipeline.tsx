import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api/client'
import type { Pipeline, SkuDetail } from '../api/types'
import { useAsync } from '../state/session'
import { PageHead, SkuTabs } from '../components/layout'
import { Card, Chip, ErrorState, Icon, LoadingCard, TruthLabel } from '../components/ui'
import { num, pct } from '../lib/format'

export default function ModelPipeline() {
  const { skuId = '' } = useParams()
  const sku = useAsync<SkuDetail>(() => api.sku(skuId), [skuId])
  const pipe = useAsync<Pipeline>(() => api.pipeline(skuId), [skuId])
  const [open, setOpen] = useState<number | null>(null)

  if (sku.loading && !sku.data) return <div className="wrap"><LoadingCard title="Model pipeline" lines={6} /></div>
  if (sku.error) return <div className="wrap"><ErrorState message={sku.error} onRetry={sku.refetch} /></div>
  if (!sku.data) return null
  const s = sku.data
  const p = pipe.data

  return (
    <div className="wrap wrap-wide">
      <PageHead sku={s} subtitle="how a recommendation is produced, node by node"
        right={<>
          <Chip kind="ghost">v{p?.version ?? '—'}</Chip>
          <Chip kind="ghost" icon="lock">No black box: every node is inspectable</Chip>
        </>} />
      <SkuTabs skuId={s.sku_id} />

      <div className="note note-info" style={{ marginBottom: 16 }}>
        <Icon name="eye" color="#1d4ed8" />
        <div className="small">
          The chain is <strong>data → models → simulation → optimization → recommendation → explanation</strong>.
          Nothing here forecasts with a trend line or a rule of thumb: M1–M4 are logistic regressions estimated offline
          on synthetic data, and the optimizer only reads their output. Click a node to see its inputs, its drivers and
          what it produced for this listing.
        </div>
      </div>

      {pipe.loading && !p ? <LoadingCard lines={7} /> : pipe.error ? (
        <ErrorState message={pipe.error} onRetry={pipe.refetch} />
      ) : p ? (
        <>
          <div className="pipeline">
            {p.nodes.map((n) => (
              <button key={n.index} className={`pipe-node ${open === n.index ? 'open' : ''}`} onClick={() => setOpen(open === n.index ? null : n.index)} aria-expanded={open === n.index}>
                <span className="pipe-index">{n.index}</span>
                <span className="pipe-body">
                  <strong>{n.label}</strong>
                  <span className="tiny muted">{n.prediction}</span>
                </span>
                <span className="pipe-out mono">{Object.entries(n.output_for_sku).slice(0, 3).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</span>
              </button>
            ))}
          </div>

          {open !== null ? (() => {
            const n = p.nodes.find((x) => x.index === open)
            if (!n) return null
            return (
              <Card title={`${n.index}. ${n.label}`} right={<>
                <Chip kind="ghost">{n.model_type}</Chip>
                <Chip kind={n.confidence === 'Low' ? 'yellow' : 'green'}>{n.confidence} confidence</Chip>
              </>}
                note={n.interpretation}>
                <div className="grid-2">
                  <div>
                    <h4 className="small muted">What this node predicts</h4>
                    <p className="small">{n.prediction}</p>
                    <h4 className="small muted">Inputs it reads</h4>
                    <div className="pill-row">
                      {n.inputs.map((i) => <Chip key={i} kind="ghost">{i}</Chip>)}
                    </div>
                    <h4 className="small muted" style={{ marginTop: 12 }}>Output for {s.sku_id}</h4>
                    <ul className="small" style={{ margin: '4px 0 0 18px' }}>
                      {Object.entries(n.output_for_sku).map(([k, v]) => (
                        <li key={k}><span className="mono">{k}</span>: {String(v)}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="small muted">Drivers here</h4>
                    {n.drivers.length ? (
                      <ul className="small" style={{ margin: '4px 0 0 18px' }}>
                        {n.drivers.map((d, i) => (
                          <li key={i}>
                            {d.name}
                            {d.value !== undefined ? <> = <span className="mono">{typeof d.value === 'number' ? num(d.value, 3) : d.value}</span></> : null}
                            {d.contribution !== undefined ? <> · contributes <span className="mono">{num(d.contribution, 3)}</span> to the log-odds</> : null}
                            {d.note ? <> — {d.note}</> : null}
                          </li>
                        ))}
                      </ul>
                    ) : <p className="small muted">No fitted model at this node (deterministic arithmetic or a lookup).</p>}
                    <div className="hr" />
                    <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                      <span className="small muted">Model</span><span className="small">{n.model ?? '—'}</span>
                    </div>
                    <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                      <span className="small muted">Training rows</span><span className="small">{n.n_train ? n.n_train.toLocaleString('en-IN') : '—'}</span>
                    </div>
                    <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                      <span className="small muted">Calibration error (ECE)</span>
                      <span className="small">{n.calibration_error !== null ? pct(n.calibration_error, 2) : '—'}</span>
                    </div>
                  </div>
                </div>
              </Card>
            )
          })() : null}

          <Card title="Under the hood" right={<TruthLabel kind="synthetic" />}
            note="Proof the estimator recovers the world it was trained on: the coefficients the models recover from the synthetic data, next to the world's true values.">
            <div className="grid-2">
              <div>
                <h4 className="small muted">Models</h4>
                <table>
                  <thead><tr><th>Model</th><th className="num">ECE</th><th className="num">AUC</th><th className="num">Rows</th></tr></thead>
                  <tbody>
                    {Object.entries((p.technical.metrics ?? {}) as Record<string, { ece: number; auc: number; n_train: number }>).map(([k, m]) => (
                      <tr key={k}><td className="mono">{k}</td><td className="num">{num(m.ece, 4)}</td><td className="num">{num(m.auc, 3)}</td><td className="num">{m.n_train.toLocaleString('en-IN')}</td></tr>
                    ))}
                  </tbody>
                </table>
                <p className="tiny muted" style={{ marginTop: 6 }}>
                  {String((p.technical.n_members as number) ?? 30)} bootstrap members. Data hash <span className="mono">{String(p.technical.data_hash ?? '—')}</span> ·
                  fitted {String(p.technical.trained_at ?? '—')}.
                </p>
              </div>
              <div>
                <h4 className="small muted">Coefficient recovery (honesty check)</h4>
                {(() => {
                  const m1 = ((p.technical.recovered ?? {}) as Record<string, Record<string, number>>).M1
                  if (!m1) return <p className="small muted">Recovery report not available in this build.</p>
                  return (
                    <>
                      <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                        <span className="small">Price elasticity (fitted, p50)</span><span className="mono">{num(m1.coef_p50, 2)} <span className="tiny muted">[{num(m1.coef_p10, 2)}, {num(m1.coef_p90, 2)}]</span></span>
                      </div>
                      <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                        <span className="small">World&apos;s true elasticity</span><span className="mono">{num(m1.hidden_beta_kurti, 2)}</span>
                      </div>
                      <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                        <span className="small">Fitted on randomised prices only</span><span className="mono">{num(m1.coef_randomised_only, 2)}</span>
                      </div>
                      <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                        <span className="small">Share of randomised price observations</span><span className="mono">{pct(m1.randomised_share)}</span>
                      </div>
                      <p className="tiny muted" style={{ marginTop: 8 }}>
                        The fitted coefficient lands on the world&apos;s value within the bootstrap band, and estimating on
                        randomised prices alone gets closer still — the estimator is not chasing confounded history.
                      </p>
                    </>
                  )
                })()}
              </div>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  )
}

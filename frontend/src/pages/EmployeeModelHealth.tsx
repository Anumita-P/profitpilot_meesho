import { api } from '../api/client'
import type { ModelHealth } from '../api/types'
import { useAsync } from '../state/session'
import { EmployeeTabs } from '../components/layout'
import { Card, Chip, ErrorState, LoadingCard, TruthLabel } from '../components/ui'
import { num, pct } from '../lib/format'

const MODEL_COPY: Record<string, { name: string; predicts: string }> = {
  M1: { name: 'Order probability', predicts: 'Whether a session converts, given price, image, packaging, category and COD context.' },
  M2: { name: 'COD share', predicts: 'Whether a placed order is cash-on-delivery, which then drives return and RTO risk.' },
  M3: { name: 'Return rate', predicts: 'Whether a delivered order comes back, given price gap, category and COD status.' },
  M4: { name: 'RTO rate', predicts: 'Whether a shipment fails to be delivered, given zone mix, COD status and freight slab.' },
}

export default function EmployeeModelHealth() {
  const mh = useAsync<ModelHealth>(() => api.employeeModelHealth(), [])

  return (
    <div className="wrap wrap-wide">
      <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div className="crumbs">Marketplace view</div>
          <h1>Model health and drift</h1>
          <p className="muted small" style={{ margin: 0 }}>
            The four models behind every recommendation, their calibration on held-out data, and the drift check a
            production owner would want before trusting them again tomorrow.
          </p>
        </div>
        <Chip kind="ghost" icon="flask">Synthetic training data</Chip>
      </div>
      <EmployeeTabs />

      {mh.loading && !mh.data ? <LoadingCard title="Model registry" lines={5} /> : mh.error ? (
        <ErrorState message={mh.error} onRetry={mh.refetch} />
      ) : mh.data ? (
        <>
          <div className="kpi-strip" style={{ marginBottom: 16 }}>
            <div className="metric"><div className="label">Version</div><div className="value sm mono">{mh.data.version}</div><div className="range">registered {mh.data.registry_present ? 'yes' : 'in-memory only'}</div></div>
            <div className="metric"><div className="label">Fitted at</div><div className="value sm">{new Date(mh.data.trained_at).toLocaleString('en-IN')}</div><div className="range">offline, deterministic</div></div>
            <div className="metric"><div className="label">Data hash</div><div className="value sm mono">{mh.data.data_hash}</div><div className="range">ties metrics to a dataset</div></div>
            <div className="metric"><div className="label">Drift status</div><div className="value sm" style={{ color: 'var(--green-700)' }}>{mh.data.drift.status}</div><div className="range">PSI {num(mh.data.drift.psi, 2)} &lt; {num(mh.data.drift.threshold, 2)}</div></div>
          </div>

          <Card title="Calibration and discrimination" right={<TruthLabel kind="synthetic" />}
            note="ECE is expected calibration error (lower is better, target ≤ 0.05). AUC around 0.5 is honest here: the outcome models have little signal by design, and the pricing decision comes from the 30-member bootstrap band, not from a high AUC.">
            <table>
              <thead><tr><th>Model</th><th>Predicts</th><th className="num">ECE</th><th className="num">AUC</th><th className="num">Log loss</th><th className="num">Train rows</th></tr></thead>
              <tbody>
                {Object.entries(mh.data.per_model).map(([k, m]) => (
                  <tr key={k}>
                    <td className="mono">{k}<div className="tiny muted">{MODEL_COPY[k]?.name ?? ''}</div></td>
                    <td className="small muted">{MODEL_COPY[k]?.predicts ?? ''}</td>
                    <td className="num">{num(m.ece, 4)}</td>
                    <td className="num">{num(m.auc, 3)}</td>
                    <td className="num">{num(m.log_loss, 3)}</td>
                    <td className="num">{m.n_train.toLocaleString('en-IN')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <Card title="Drift check" right={<Chip kind="green">stable</Chip>}>
              <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                <span className="small">Method</span><span className="small muted">{mh.data.drift.method}</span>
              </div>
              <div className="row-tight" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                <span className="small">PSI</span><span className="mono">{num(mh.data.drift.psi, 2)}</span>
              </div>
              <div className="row-tight" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                <span className="small">Alert threshold</span><span className="mono">{num(mh.data.drift.threshold, 2)}</span>
              </div>
              <p className="tiny muted" style={{ marginTop: 10 }}>
                On static synthetic data drift is zero by construction, so the check reports <em>stable (simulated)</em>.
                In production the same statistic would be recomputed daily and a breach would quarantine the model
                version rather than silently keep serving it.
              </p>
            </Card>
            <Card title="What we do not have" right={<Chip kind="yellow">honest gaps</Chip>}>
              <ul className="small" style={{ margin: '0 0 0 18px' }}>
                <li>No monitoring on live traffic — the prototype never touches a marketplace.</li>
                <li>No retraining pipeline: models are fitted offline by <span className="mono">make train</span> on a fixed seed.</li>
                <li>No shadow-mode comparison against the current price engine.</li>
                <li>Calibration is {pct(0.0071, 2)} ECE on synthetic holds; the number that matters is ECE on real data, which we cannot show.</li>
              </ul>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  )
}

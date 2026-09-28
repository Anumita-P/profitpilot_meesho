import { api } from '../api/client'
import type { Experiments as Exps } from '../api/types'
import { useAsync } from '../state/session'
import { EmployeeTabs } from '../components/layout'
import { Card, Chip, ErrorState, Icon, LoadingCard, TruthLabel } from '../components/ui'
import { inr, num, pct } from '../lib/format'

export default function EmployeeExperiments() {
  const ex = useAsync<Exps>(() => api.employeeExperiments(), [])
  const designs = ex.data?.designs ?? []

  return (
    <div className="wrap wrap-wide">
      <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div className="crumbs">Marketplace view</div>
          <h1>Experiments — designed, never run</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Bandits and live experiments are deliberately out of scope for this prototype. What is in scope: the test we
            would run to replace a model estimate with a measurement.
          </p>
        </div>
        <Chip kind="ghost" icon="flask">No live traffic</Chip>
      </div>
      <EmployeeTabs />

      {ex.loading && !ex.data ? <LoadingCard title="Experiment designs" lines={5} /> : ex.error ? (
        <ErrorState message={ex.error} onRetry={ex.refetch} />
      ) : ex.data ? (
        <>
          {designs.map((d) => (
            <Card key={d.id} title={d.name} right={<>
              <Chip kind="blue">{d.status === 'design' ? 'design only' : d.status}</Chip>
              <TruthLabel kind="synthetic" />
            </>}>
              <div className="grid-2">
                <div>
                  <h4 className="small muted">Arms</h4>
                  <table>
                    <thead><tr><th>Arm</th><th className="num">Price change</th><th className="num">Price on K-101</th></tr></thead>
                    <tbody>
                      {d.arms.arms.map((a) => (
                        <tr key={a.id}>
                          <td className="mono">{a.id}</td>
                          <td className="num">{a.price_delta_pct > 0 ? '+' : ''}{a.price_delta_pct}%</td>
                          <td className="num">{inr(399 * (1 + a.price_delta_pct / 100))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="tiny muted" style={{ marginTop: 6 }}>
                    Minimum sample per arm: <strong>{num(d.min_sample, 0)}</strong> observations. {d.arms.randomisation}
                  </p>
                </div>
                <div>
                  <h4 className="small muted">Design</h4>
                  <div className="row-tight" style={{ justifyContent: 'space-between' }}>
                    <span className="small">Primary metric</span><span className="small muted">{d.arms.primary_metric}</span>
                  </div>
                  <div className="row-tight" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                    <span className="small">Guardrail</span><span className="small muted">{d.arms.guardrail}</span>
                  </div>
                  <div className="row-tight" style={{ justifyContent: 'space-between', marginTop: 6 }}>
                    <span className="small">Consent</span><span className="small muted">{d.arms.opt_in}</span>
                  </div>
                  <div className="note note-info" style={{ marginTop: 10 }}>
                    <Icon name="alert" color="#b45309" />
                    <span className="small"><strong>Stop rule.</strong> {d.rollback_rule}</span>
                  </div>
                </div>
              </div>
            </Card>
          ))}

          <Card title={ex.data.simulated_results.label} right={<Chip kind="yellow">not real results</Chip>}
            note={ex.data.simulated_results.note}>
            <table>
              <thead><tr><th>Arm</th><th className="num">₹ per kept order</th><th className="num">Orders / day</th><th className="num">Return + RTO</th></tr></thead>
              <tbody>
                {ex.data.simulated_results.rows.map((r) => (
                  <tr key={r.arm}>
                    <td className="small">{r.arm}</td>
                    <td className="num">{inr(r.kept_per_order)}</td>
                    <td className="num">{num(r.orders_day, 1)}</td>
                    <td className="num">{pct(r.leakage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="tiny muted" style={{ marginTop: 10 }}>
              These three rows are the reference world&apos;s own values for K-101 — they are what the test would
              <em> have</em> to detect, and they are used to size the sample. They are not observations, and no arm was
              ever exposed to a buyer.
            </p>
          </Card>

          <Card title="Why not just run a bandit" right={<Chip kind="ghost">roadmap</Chip>}>
            <ul className="small" style={{ margin: '0 0 0 18px' }}>
              <li><strong>Attribution first.</strong> A mis-specified model learns the wrong thing faster when it is automated; we want a clean randomised read-out before any adaptive allocation.</li>
              <li><strong>Guardrails before automation.</strong> Adaptive pricing needs hard stop rules on return and RTO drift — those exist here as refusal logic, not as a running controller.</li>
              <li><strong>Seller consent.</strong> Price experiments are opt-in per listing, which is hard to honour inside a bandit that reallocates continuously.</li>
              <li><strong>Scope.</strong> The prototype is explicit that no RL, no bandit and no LLM is used anywhere in a shipped path.</li>
            </ul>
          </Card>
        </>
      ) : null}
    </div>
  )
}

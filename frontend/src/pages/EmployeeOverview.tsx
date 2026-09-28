import { Link } from 'react-router-dom'
import { api } from '../api/client'
import type { EmployeeOverview as Ov } from '../api/types'
import { useAsync } from '../state/session'
import { EmployeeTabs } from '../components/layout'
import { Card, Chip, ErrorState, Icon, LoadingCard, TruthLabel } from '../components/ui'
import { inr, num, pct } from '../lib/format'

export default function EmployeeOverview() {
  const ov = useAsync<Ov>(() => api.employeeOverview(), [])

  return (
    <div className="wrap wrap-wide">
      <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div className="crumbs">Marketplace view · category operations</div>
          <h1>Fleet health, not a seller&apos;s books</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Aggregates only. Seller-level and buyer-level detail is never shown here, and every figure is recomputed by
            replaying the fitted models over the synthetic fleet.
          </p>
        </div>
        <Chip kind="ghost" icon="eye">No seller secrets, no PII</Chip>
      </div>
      <EmployeeTabs />

      {ov.loading && !ov.data ? <LoadingCard title="Fleet replay" lines={5} /> : ov.error ? (
        <ErrorState message={ov.error} onRetry={ov.refetch} />
      ) : ov.data ? (
        <>
          <div className="note note-info" style={{ marginBottom: 16 }}>
            <Icon name="flask" color="#1d4ed8" />
            <div className="small">
              <strong>{ov.data.label}.</strong> A simulated rollout: {ov.data.fleet.sample} of {ov.data.fleet.skus}{' '}
              listings across {ov.data.fleet.sellers} sellers are replayed through the same optimizer a seller sees, and
              the accept/apply decisions are simulated. Nothing here was run on real traffic.
            </div>
          </div>

          <div className="grid-2">
            <Card title="What the rollout found" right={<TruthLabel kind="synthetic" />}
              note="Uplift is the difference between today's contribution/day and the contribution/day of the recommendation the optimizer picked, summed over the sample.">
              <div className="answer-grid">
                <div className="answer">
                  <h4>Recommendations generated</h4>
                  <p className="big">{num(ov.data.kpis.recommendations_generated.value, 0)}</p>
                  <p className="tiny muted">{ov.data.kpis.recommendations_generated.note}</p>
                </div>
                <div className="answer">
                  <h4>Simulated adoption</h4>
                  <p className="big">{pct(ov.data.kpis.adoption_pct.value)}</p>
                  <p className="tiny muted">{ov.data.kpis.adoption_pct.note}</p>
                </div>
                <div className="answer">
                  <h4>Contribution lift</h4>
                  <p className="big">{inr(ov.data.kpis.contribution_uplift_day.value)}<span className="small muted">/day</span></p>
                  <p className="tiny muted">{ov.data.kpis.contribution_uplift_day.note}</p>
                </div>
                <div className="answer">
                  <h4>NM V effect</h4>
                  <p className="big">{inr(ov.data.kpis.nmv_uplift_day.value)}<span className="small muted">/day</span></p>
                  <p className="tiny muted">{ov.data.kpis.nmv_uplift_day.note}</p>
                </div>
              </div>
              <p className="tiny muted" style={{ marginTop: 10 }}>
                An adoption rate of zero is a real result, not a bug: over this fleet sample most listings have no price
                that clears every constraint at once, so the guardrails withheld a recommendation instead of guessing.
              </p>
            </Card>

            <div className="col">
              <Card title="Why recommendations get withheld" right={<TruthLabel kind="estimated" />}>
                {Object.entries(ov.data.guardrails.blocked).map(([k, v]) => (
                  <div key={k} className="row-tight" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px dashed var(--line)' }}>
                    <span className="small">{k.replace(/_/g, ' ')}</span>
                    <span className="mono">{v}</span>
                  </div>
                ))}
                <div className="row-tight" style={{ marginTop: 12 }}>
                  <Link className="btn btn-sm" to="/employee/guardrails">See the guardrail detail</Link>
                </div>
              </Card>
              <Card title="How the sample is chosen" right={<Chip kind="ghost">deterministic</Chip>}>
                <ul className="small" style={{ margin: '0 0 0 18px' }}>
                  <li>{ov.data.fleet.sellers} sellers, {ov.data.fleet.skus} listings in the seeded catalogue.</li>
                  <li>The first {ov.data.fleet.sample} non-demo listings are replayed, in catalogue order.</li>
                  <li>Same fixed seed every run — the numbers do not drift between demo runs.</li>
                  <li>Demo listings are excluded so the five demo stories cannot bias the fleet view.</li>
                </ul>
              </Card>
            </div>
          </div>

          <div className="note note-info" style={{ marginTop: 16 }}>
            <Icon name="info" color="#1d4ed8" />
            <div className="small">
              This view is deliberately thin. An operations team would also want adoption by category, guardrail
              frequency by price band, and a live A/B read-out — those are roadmap items in
              the build plan, not simulated features pretending to be real ones.
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

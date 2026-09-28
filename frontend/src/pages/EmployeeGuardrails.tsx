import { api } from '../api/client'
import type { EmployeeGuardrails as Gr } from '../api/types'
import { useAsync } from '../state/session'
import { EmployeeTabs } from '../components/layout'
import { Card, Chip, ErrorState, Icon, LoadingCard, TruthLabel } from '../components/ui'
import { num } from '../lib/format'

const COUNT_COPY: Record<string, string> = {
  below_floor: 'Contribution stayed under the seller\u2019s floor',
  price_move: 'The move needed to work was larger than the 12% step cap',
  low_confidence: 'Not enough comparable observations (or too wide a band)',
  corridor: 'The best economics sat outside the market corridor',
}

const AUDIT_COPY: Record<string, string> = {
  login: 'Demo sign-ins',
  logout: 'Sign-outs',
  demo_reset: 'Demo data resets',
  demo_scenario: 'Scenario switches',
  goal_saved: 'Goals saved',
  recommendation_generated: 'Recommendations generated',
  intervention_selected: 'Recommendations saved',
  recommendation_rolled_back: 'Recommendations rolled back',
  authorization_denied: 'Denied authorisation attempts',
  rate_limited: 'Rate-limit trips',
  model_unavailable: 'Model-unavailable responses',
}

export default function EmployeeGuardrails() {
  const gr = useAsync<Gr>(() => api.employeeGuardrails(), [])

  return (
    <div className="wrap wrap-wide">
      <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div className="crumbs">Marketplace view</div>
          <h1>Guardrails: what we refuse to recommend</h1>
          <p className="muted small" style={{ margin: 0 }}>
            The interesting number in a pricing system is not how many recommendations it makes, but how many it
            withholds and why. These counts come from the same fleet replay and from the audit log.
          </p>
        </div>
        <Chip kind="ghost" icon="lock">Deny by default</Chip>
      </div>
      <EmployeeTabs />

      {gr.loading && !gr.data ? <LoadingCard title="Guardrails" lines={5} /> : gr.error ? (
        <ErrorState message={gr.error} onRetry={gr.refetch} />
      ) : gr.data ? (
        <>
          <div className="grid-2">
            <Card title="Recommendations withheld, by reason" right={<TruthLabel kind="synthetic" />}
              note="Each sampled listing contributes at most one reason: the constraint that blocked the closest candidate.">
              {Object.entries(gr.data.counts).map(([k, v]) => (
                <div key={k} className="row-tight" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px dashed var(--line)' }}>
                  <span className="small">
                    <Icon name="alert" color={v > 0 ? '#b45309' : '#9ca3af'} />
                    {' '}{COUNT_COPY[k] ?? k}
                  </span>
                  <span className="mono">{num(v, 0)}</span>
                </div>
              ))}
              <p className="tiny muted" style={{ marginTop: 8 }}>
                A listing can be blocked by a hard constraint even when its <em>numbers</em> look close. That is the
                point: ProfitPilot prefers saying nothing to recommending something that violates the seller&apos;s goal.
              </p>
            </Card>

            <div className="col">
              <Card title="What each block means" right={<Chip kind="ghost">policy, not tuning</Chip>}>
                {Object.entries(gr.data.blocked_actions).map(([k, v]) => (
                  <div key={k} style={{ marginBottom: 10 }}>
                    <strong className="small">{k.replace(/_/g, ' ')}</strong>
                    <div className="small muted">{v}</div>
                  </div>
                ))}
              </Card>
              <Card title="Other guardrails in force" right={<Chip kind="ghost">enforced in code</Chip>}>
                <ul className="small" style={{ margin: '0 0 0 18px' }}>
                  <li>Maximum 12% price move per step — a ladder is built instead of one leap.</li>
                  <li>Prices outside the market corridor are plotted but never recommended.</li>
                  <li>Low-confidence estimates never surface as a recommendation.</li>
                  <li>No buyer-level or personalised pricing anywhere in the system.</li>
                  <li>ProfitPilot writes no prices to any marketplace — recommendation only.</li>
                </ul>
              </Card>
            </div>
          </div>

          <Card title="Audit log — action counts" right={<TruthLabel kind="synthetic" />}
            note="Events record the action, the actor and the entity. Request bodies are never written, and no buyer identifiers exist in the system.">
            <div className="pill-row">
              {Object.entries(gr.data.audit).map(([k, v]) => (
                <span key={k} className="chip chip-ghost" title={AUDIT_COPY[k] ?? k}>
                  {AUDIT_COPY[k] ?? k}: <strong style={{ marginLeft: 4 }}>{num(v, 0)}</strong>
                </span>
              ))}
            </div>
            <p className="tiny muted" style={{ marginTop: 10 }}>
              A non-zero <em>denied authorisation attempts</em> count is expected in a security demo: the acceptance
              tests deliberately probe another seller&apos;s listing and are refused with a 404.
            </p>
          </Card>
        </>
      ) : null}
    </div>
  )
}

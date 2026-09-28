import { api } from '../api/client'
import type { EmployeeInterventions as Ivs } from '../api/types'
import { useAsync } from '../state/session'
import { EmployeeTabs } from '../components/layout'
import { Card, Chip, EmptyState, ErrorState, LoadingCard, TruthLabel } from '../components/ui'
import { MiniBars } from '../components/charts'
import { inr, num } from '../lib/format'

export default function EmployeeInterventions() {
  const ivs = useAsync<Ivs>(() => api.employeeInterventions(), [])
  const rows = ivs.data?.rows ?? []

  return (
    <div className="wrap wrap-wide">
      <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div className="crumbs">Marketplace view</div>
          <h1>Which interventions actually pay</h1>
          <p className="muted small" style={{ margin: 0 }}>
            The fleet replay also ranks the recommendation the optimizer picked for each sampled listing. Today the
            optimizer only proposes price moves, so there is a single row — operational levers appear here as soon as
            sellers adopt them.
          </p>
        </div>
        <Chip kind="ghost" icon="flask">Simulated rollout</Chip>
      </div>
      <EmployeeTabs />

      {ivs.loading && !ivs.data ? <LoadingCard title="Intervention table" lines={5} /> : ivs.error ? (
        <ErrorState message={ivs.error} onRetry={ivs.refetch} />
      ) : rows.length === 0 ? (
        <Card title="Interventions" right={<TruthLabel kind="synthetic" />}>
          <EmptyState title="No intervention rows in this replay"
            body="The sample produced price-only recommendations, so there is nothing to aggregate across operational levers yet." />
        </Card>
      ) : (
        <>
          <Card title="By intervention type" right={<TruthLabel kind="synthetic" />}
            note="Means over the sampled listings where that intervention was the optimizer's choice. Delta columns are versus the listing's current price.">
            <table>
              <thead>
                <tr><th>Intervention</th><th className="num">Count</th><th className="num">Δ contribution/day</th><th className="num">Δ ₹/kept order</th><th className="num">Δ return + RTO</th><th className="num">Share violating</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.intervention}>
                    <td className="small">{r.intervention === 'PRICE' ? 'Price change' : r.intervention.replace(/\+/g, ' + ')}</td>
                    <td className="num">{num(r.count, 0)}</td>
                    <td className="num">{inr(r.mean_delta_contribution)}</td>
                    <td className="num">{inr(r.mean_delta_per_kept)}</td>
                    <td className="num">{num(r.mean_delta_leakage * 100, 2)}pp</td>
                    <td className="num">{num(r.share_violating * 100, 1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="grid-2" style={{ marginTop: 16 }}>
            <Card title="Mean contribution lift per picked recommendation" right={<TruthLabel kind="synthetic" />}>
              <MiniBars values={rows.map((r) => r.mean_delta_contribution)} labels={rows.map((r) => r.intervention === 'PRICE' ? 'Price' : r.intervention)} />
            </Card>
            <Card title="How to read this" right={<Chip kind="ghost">caveats first</Chip>}>
              <ul className="small" style={{ margin: '0 0 0 18px' }}>
                <li><strong>This is a simulation.</strong> The accept/apply rule is a heuristic, so the mix of chosen levers reflects the rule as much as the market.</li>
                <li><strong>Means hide failures.</strong> A positive mean can sit next to a large <em>share violating</em>; the guardrail column is the honest half of the story.</li>
                <li><strong>Not causal.</strong> Levers are chosen by the optimizer, not assigned randomly. Only a randomised test (see the Experiments tab) supports a causal claim.</li>
              </ul>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

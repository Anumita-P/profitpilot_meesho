import { useNavigate } from 'react-router-dom'
import { useSession } from '../state/session'
import { Card, Chip, Icon, TruthLabel } from '../components/ui'

const PERSONAS = [
  { id: 'sunita', name: 'Sunita', role: 'Seller · kurti', blurb: '8 listings, thin margins, high returns. The seller view with the full toolkit.', cta: 'Enter as seller (Sunita)', route: '/seller/catalog' },
  { id: 'rahul', name: 'Rahul', role: 'Seller · bulk lot', blurb: 'Sitting on 900 units of a 75-day-old lot. Cash is the problem, not growth.', cta: 'Enter as seller (Rahul)', route: '/seller/catalog' },
  { id: 'employee', name: 'Priya', role: 'Meesho · category ops', blurb: 'Marketplace aggregates only: adoption, blocked recommendations, guardrails.', cta: 'Enter as employee', route: '/employee/overview' },
  { id: 'customer', name: 'A buyer', role: 'Customer', blurb: 'The buyer side of the same listing. One price for everyone, no personalisation.', cta: 'Enter as customer', route: '/customer/listing/K-101' },
] as const

export default function Login() {
  const { login, setToast } = useSession()
  const nav = useNavigate()

  return (
    <div className="wrap" style={{ maxWidth: 980 }}>
      <div style={{ paddingTop: 28, paddingBottom: 8 }}>
        <div className="row-tight" style={{ marginBottom: 6 }}>
          <TruthLabel kind="synthetic" />
          <Chip kind="ghost" icon="lock">No Meesho data or systems</Chip>
        </div>
        <h1>Pricing that protects the money you actually keep</h1>
        <p className="muted" style={{ maxWidth: 680 }}>
          ProfitPilot tells a marketplace seller which price (and which operational change) reaches their profit
          goal — and when no price can, why not. Pick a persona to explore the prototype. There are no passwords
          in the demo; every persona is a seeded account.
        </p>
      </div>

      <div className="grid-3">
        {PERSONAS.map((p) => (
          <Card key={p.id} title={p.name} right={<Chip kind="ghost">{p.role}</Chip>}>
            <p className="small" style={{ minHeight: 62 }}>{p.blurb}</p>
            <button
              className="btn btn-primary"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={async () => {
                try {
                  const me = await login(p.id)
                  setToast(`Signed in as ${me.user.name}`)
                  nav(p.route)
                } catch (e) {
                  setToast(e instanceof Error ? e.message : 'Login failed')
                }
              }}
            >
              <Icon name="up" /> {p.cta}
            </button>
          </Card>
        ))}
      </div>

      <div className="note note-info" style={{ marginTop: 20 }}>
        <Icon name="info" color="#1d4ed8" />
        <div className="small">
          <strong>Honesty first.</strong> Every listing, order, cost and customer here is synthetic, produced by an
          offline simulator. Costs are Illustrative inputs; model outputs are Estimated with p10–p90 ranges. The
          only real figure quoted anywhere in this product is Meesho&apos;s company-reported FY26 NMV/GMV ratio
          (≈58.8%), used once to explain why margin — not headline sales — is the thing worth optimising.
        </div>
      </div>
    </div>
  )
}

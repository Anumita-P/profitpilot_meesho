import { useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useSession } from '../state/session'
import { AboutFootnote, Chip, Icon, TruthLabel } from './ui'

const PERSONA_LABEL: Record<string, string> = {
  sunita: 'Sunita · seller', rahul: 'Rahul · seller', employee: 'Employee · category ops', customer: 'Customer · buyer',
}

export function AppShell({ children }: { children: ReactNode }) {
  const { me, scenarios, activeScenario, applyScenario, resetDemo, logout, toast, setToast } = useSession()
  const [panelOpen, setPanelOpen] = useState(false)
  const nav = useNavigate()

  const isSeller = me?.user.role === 'seller'
  const isEmployee = me?.user.role === 'employee'

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" style={{ textDecoration: 'none' }}>
          <span>ProfitPilot<span className="dot">.</span></span>
          <small>profit-aware pricing · prototype</small>
        </Link>
        <span className="spacer" />
        {me ? (
          <div className="row-tight">
            {isSeller && me.seller ? (
              <Chip kind="ghost" icon="dot">{me.seller.name} · {me.seller.sku_count} listings</Chip>
            ) : null}
            <Chip kind="ghost" icon="info">{PERSONA_LABEL[me.user.persona] ?? me.user.name}</Chip>
            <button className="btn btn-sm" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen}>
              <Icon name="flask" /> Demo scenarios
            </button>
            {isSeller ? (
              <>
                <NavLink className="btn btn-sm" to="/seller/catalog">Catalog</NavLink>
                <NavLink className="btn btn-sm" to="/seller/goals">Goals</NavLink>
                <NavLink className="btn btn-sm" to="/seller/history">History</NavLink>
              </>
            ) : null}
            {isEmployee ? <NavLink className="btn btn-sm" to="/employee/overview">Marketplace view</NavLink> : null}
            <button className="btn btn-sm btn-ghost" onClick={async () => { await logout(); nav('/login') }}>Sign out</button>
          </div>
        ) : null}
      </header>

      {panelOpen ? (
        <div className="scenario-panel">
          <div className="wrap wrap-wide" style={{ paddingBottom: 16 }}>
            <div className="row-tight" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <strong>Demo Mode — five scenarios, one backend</strong>
              <div className="row-tight">
                <TruthLabel kind="synthetic" />
                <button className="btn btn-sm" onClick={async () => { await resetDemo(); setToast('Demo state reset to the seeded catalogue'); setPanelOpen(false) }}>
                  Reset demo data
                </button>
              </div>
            </div>
            <p className="small muted" style={{ marginBottom: 10 }}>
              Each card switches the signed-in persona and the scenario goal, then drops you on the screen the
              story happens on. Every number is recomputed by the models — nothing is pre-baked.
            </p>
            <div className="scenario-grid">
              {scenarios.map((s) => (
                <button key={s.id} className="scenario-card" aria-pressed={activeScenario === s.id}
                  onClick={async () => {
                    await applyScenario(s.id)
                    setToast(`Scenario: ${s.name}`)
                    setPanelOpen(false)
                    nav(s.route)
                  }}>
                  <strong>{s.name}</strong>
                  <div className="tiny muted" style={{ margin: '4px 0' }}>{s.sku_id} · {s.mode} mode</div>
                  <div className="tiny">{s.story}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <main>{children}</main>
      <AboutFootnote />
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </>
  )
}

export function SkuTabs({ skuId }: { skuId: string }) {
  const tabs = [
    ['Snapshot', `/seller/sku/${skuId}`],
    ['Simulator', `/seller/sku/${skuId}/simulate`],
    ['Recommendation', `/seller/sku/${skuId}/recommendation`],
    ['Reverse pricing', `/seller/sku/${skuId}/reverse`],
    ['Diagnosis', `/seller/sku/${skuId}/diagnosis`],
    ['Model pipeline', `/seller/model/${skuId}`],
  ] as const
  return (
    <nav className="tabs">
      {tabs.map(([label, to]) => (
        <NavLink key={to} to={to} end className="tab">{label}</NavLink>
      ))}
    </nav>
  )
}

export function EmployeeTabs() {
  const tabs = [
    ['Overview', '/employee/overview'],
    ['Interventions', '/employee/interventions'],
    ['Guardrails', '/employee/guardrails'],
    ['Model health', '/employee/model-health'],
    ['Experiments', '/employee/experiments'],
  ] as const
  return (
    <nav className="tabs">
      {tabs.map(([label, to]) => (
        <NavLink key={to} to={to} end className="tab">{label}</NavLink>
      ))}
    </nav>
  )
}

export function PageHead({ title, sku, right, subtitle }: { title?: string; sku?: { sku_id: string; name: string; category: string }; right?: ReactNode; subtitle?: string }) {
  return (
    <div className="row-tight" style={{ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
      <div>
        <div className="crumbs">
          <Link to="/seller/catalog">Catalog</Link>{sku ? <>{' · '}<span className="mono">{sku.sku_id}</span></> : null}
        </div>
        <h1>{sku ? sku.name : title}</h1>
        <p className="muted small" style={{ margin: 0 }}>
          {sku ? <><span className="mono">{sku.sku_id}</span> · {sku.category}</> : null}{subtitle ? <> · {subtitle}</> : null}
        </p>
      </div>
      <div className="row-tight">{right}</div>
    </div>
  )
}

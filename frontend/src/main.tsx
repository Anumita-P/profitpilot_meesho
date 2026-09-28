import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AppShell } from './components/layout'
import { SessionProvider, useSession } from './state/session'
import Login from './pages/Login'
import SellerCatalog from './pages/SellerCatalog'
import Snapshot from './pages/Snapshot'
import Simulator from './pages/Simulator'
import Recommendation from './pages/Recommendation'
import ReversePricing from './pages/ReversePricing'
import Diagnosis from './pages/Diagnosis'
import ModelPipeline from './pages/ModelPipeline'
import GoalSettings from './pages/GoalSettings'
import History from './pages/History'
import EmployeeOverview from './pages/EmployeeOverview'
import EmployeeInterventions from './pages/EmployeeInterventions'
import EmployeeGuardrails from './pages/EmployeeGuardrails'
import EmployeeModelHealth from './pages/EmployeeModelHealth'
import EmployeeExperiments from './pages/EmployeeExperiments'
import CustomerListing from './pages/CustomerListing'
import './styles/tokens.css'
import './styles/app.css'

function Landing() {
  const { me, loading } = useSession()
  if (loading) return null
  if (!me) return <Navigate to="/login" replace />
  if (me.user.role === 'employee') return <Navigate to="/employee/overview" replace />
  if (me.user.role === 'customer') return <Navigate to="/customer/listing/K-101" replace />
  return <Navigate to="/seller/catalog" replace />
}

function Guard({ role, children }: { role: 'seller' | 'employee' | 'customer'; children: React.ReactNode }) {
  const { me, loading } = useSession()
  if (loading) return null
  if (!me) return <Navigate to="/login" replace />
  if (me.user.role !== role) return <Navigate to="/" replace />
  return <AppShell>{children}</AppShell>
}

/** Keeps the API's scenario route names (`.../levers`, `.../diagnose`) working in the SPA. */
function RedirectTo({ suffix }: { suffix: string }) {
  const { skuId } = useParams()
  return <Navigate to={`/seller/sku/${skuId}/${suffix}`} replace />
}

function NotFound() {
  return (
    <div className="wrap">
      <h1>Not found</h1>
      <p className="muted">That screen does not exist in this prototype.</p>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<AppShell><Login /></AppShell>} />

      <Route path="/seller/catalog" element={<Guard role="seller"><SellerCatalog /></Guard>} />
      <Route path="/seller/sku/:skuId" element={<Guard role="seller"><Snapshot /></Guard>} />
      <Route path="/seller/sku/:skuId/simulate" element={<Guard role="seller"><Simulator /></Guard>} />
      <Route path="/seller/sku/:skuId/recommendation" element={<Guard role="seller"><Recommendation /></Guard>} />
      <Route path="/seller/sku/:skuId/reverse" element={<Guard role="seller"><ReversePricing /></Guard>} />
      <Route path="/seller/sku/:skuId/diagnosis" element={<Guard role="seller"><Diagnosis /></Guard>} />
      {/* The API's demo-scenario routes use the shorter names — keep both working. */}
      <Route path="/seller/sku/:skuId/diagnose" element={<RedirectTo suffix="diagnosis" />} />
      <Route path="/seller/sku/:skuId/levers" element={<RedirectTo suffix="recommendation" />} />
      <Route path="/seller/model/:skuId" element={<Guard role="seller"><ModelPipeline /></Guard>} />
      <Route path="/seller/goals" element={<Guard role="seller"><GoalSettings /></Guard>} />
      <Route path="/seller/history" element={<Guard role="seller"><History /></Guard>} />

      <Route path="/employee/overview" element={<Guard role="employee"><EmployeeOverview /></Guard>} />
      <Route path="/employee/interventions" element={<Guard role="employee"><EmployeeInterventions /></Guard>} />
      <Route path="/employee/guardrails" element={<Guard role="employee"><EmployeeGuardrails /></Guard>} />
      <Route path="/employee/model-health" element={<Guard role="employee"><EmployeeModelHealth /></Guard>} />
      <Route path="/employee/experiments" element={<Guard role="employee"><EmployeeExperiments /></Guard>} />

      <Route path="/customer/listing/:skuId" element={<Guard role="customer"><CustomerListing /></Guard>} />

      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </React.StrictMode>,
)

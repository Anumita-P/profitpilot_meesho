import { useEffect, useState } from 'react'
import type { Goal, Mode } from '../api/types'
import { Chip, Icon, TruthLabel } from './ui'
import { inr } from '../lib/format'

export const DEFAULT_GOAL: Goal = {
  target_contribution: 60, min_orders: 20, max_return_rto: 0.15, cash_limit: 75000, mode: 'margin',
}

export const MODE_COPY: Record<Mode, { label: string; note: string }> = {
  margin: { label: 'Protect margin', note: 'Maximise retained contribution per day, with risk aversion.' },
  growth: { label: 'Grow volume', note: 'Weight volume more heavily — orders/day counts 4× in the objective.' },
  cash: { label: 'Free up cash', note: 'Maximise contribution per rupee of working capital tied up.' },
  clear: { label: 'Clear stock', note: 'Move units before the lot ages; the recovery floor replaces your target.' },
}

export function GoalForm({
  value, onChange, onSubmit, onPreview, submitting, previewLine, saved, compact,
}: {
  value: Goal
  onChange: (g: Goal) => void
  onSubmit?: () => void
  onPreview?: () => void
  submitting?: boolean
  previewLine?: string | null
  saved?: boolean
  compact?: boolean
}) {
  const [noLimit, setNoLimit] = useState(value.cash_limit === null)
  useEffect(() => { setNoLimit(value.cash_limit === null) }, [value.cash_limit])

  const set = (patch: Partial<Goal>) => onChange({ ...value, ...patch })

  return (
    <div>
      <div className="row-tight" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <strong className="small">Your goal for this listing</strong>
        <TruthLabel kind="illustrative" />
      </div>

      <div className="field-inline">
        <div className="field">
          <label htmlFor="target">Contribution per kept order (₹)</label>
          <input id="target" type="number" min={0} max={1000} step={5} value={value.target_contribution}
            onChange={(e) => set({ target_contribution: Number(e.target.value) })} />
          <div className="hint">What one order must leave you after every cost and return.</div>
        </div>
        <div className="field">
          <label htmlFor="minorders">Minimum orders per day</label>
          <input id="minorders" type="number" min={1} max={500} value={value.min_orders}
            onChange={(e) => set({ min_orders: Number(e.target.value) })} />
          <div className="hint">Volume floor — price rises that break this are not recommended.</div>
        </div>
      </div>

      <div className="field-inline">
        <div className="field">
          <label htmlFor="cap">Return + RTO cap</label>
          <input id="cap" type="number" min={5} max={40} step={1} value={Math.round(value.max_return_rto * 100)}
            onChange={(e) => set({ max_return_rto: Number(e.target.value) / 100 })} />
          <div className="hint">Share of orders you accept losing to returns and RTO.</div>
        </div>
        <div className="field">
          <label htmlFor="cash">Working-capital limit (₹)</label>
          <input id="cash" type="number" min={0} step={5000} disabled={noLimit}
            value={value.cash_limit ?? 0}
            onChange={(e) => set({ cash_limit: Number(e.target.value) })} />
          <div className="hint">Cash tied up in stock and returns in transit.</div>
        </div>
      </div>

      <div className="switch" style={{ marginBottom: 12 }}>
        <input id="nolimit" type="checkbox" checked={noLimit} onChange={(e) => { setNoLimit(e.target.checked); set({ cash_limit: e.target.checked ? null : 75000 }) }} />
        <label htmlFor="nolimit" style={{ margin: 0, fontWeight: 500 }}>No working-capital limit</label>
      </div>

      <label>What are you optimising for?</label>
      <div className="pill-row" style={{ marginBottom: 6 }}>
        {(Object.keys(MODE_COPY) as Mode[]).map((m) => (
          <button key={m} className={`btn btn-sm ${value.mode === m ? 'btn-primary' : ''}`} onClick={() => set({ mode: m })} aria-pressed={value.mode === m}>
            {MODE_COPY[m].label}
          </button>
        ))}
      </div>
      <p className="tiny muted">{MODE_COPY[value.mode].note}</p>

      {!compact ? (
        <div className="row-tight" style={{ marginTop: 10 }}>
          {onSubmit ? <button className="btn btn-primary" onClick={onSubmit} disabled={submitting}>{submitting ? 'Working…' : 'Save goal'}</button> : null}
          {onPreview ? <button className="btn" onClick={onPreview} disabled={submitting}>Check feasibility</button> : null}
          {saved ? <Chip kind="green">Goal saved</Chip> : null}
        </div>
      ) : null}

      {previewLine ? (
        <div className="note note-info" style={{ marginTop: 10 }}>
          <Icon name="info" color="#1d4ed8" />
          <span>{previewLine}</span>
        </div>
      ) : null}

      {value.cash_limit !== null ? (
        <p className="tiny muted" style={{ marginTop: 8 }}>Cash limit {inr(value.cash_limit)} — matching the demo seller&apos;s working-capital ceiling.</p>
      ) : null}
    </div>
  )
}

export const INTERVENTION_LABELS: Record<string, string> = {
  none: 'No other change',
  PACK_PROTECT: 'Upgrade protective packaging',
  PARCEL_REDESIGN: 'Lighter, right-sized parcel',
  LISTING_IMAGE: 'Improve primary image / size chart',
  LISTING_IMAGE_SEVERE: 'Rebuild primary image (major fix)',
  BUNDLE2: 'Bundle of 2 units',
  PREPAID_INC: 'Prepaid incentive',
}

export function InterventionPanel({
  options, active, onPick, iv, onCustom,
}: {
  options: string[]
  active: string
  onPick: (id: string) => void
  iv: Record<string, number>
  onCustom: (iv: Record<string, number>) => void
}) {
  return (
    <div>
      <div className="row-tight" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <strong className="small">Add an operational change</strong>
        <TruthLabel kind="illustrative" />
      </div>
      <div className="pill-row">
        {options.map((id) => (
          <button key={id} className={`btn btn-sm ${active === id ? 'btn-primary' : ''}`} aria-pressed={active === id} onClick={() => onPick(id)}>
            {INTERVENTION_LABELS[id] ?? id}
          </button>
        ))}
      </div>
      <div className="hr" />
      <details>
        <summary className="small" style={{ cursor: 'pointer' }}>Fine-tune the assumption</summary>
        <div className="field-inline" style={{ marginTop: 10 }}>
          <div className="field">
            <label htmlFor="img">Image quality {iv.img_delta ? `(+${iv.img_delta})` : ''}</label>
            <input id="img" type="range" min={0} max={0.5} step={0.05} value={iv.img_delta ?? 0}
              onChange={(e) => onCustom({ ...iv, img_delta: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label htmlFor="pack">Packaging quality {iv.pack_delta ? `(+${iv.pack_delta})` : ''}</label>
            <input id="pack" type="range" min={0} max={0.5} step={0.05} value={iv.pack_delta ?? 0}
              onChange={(e) => onCustom({ ...iv, pack_delta: Number(e.target.value), pack_cost_delta: 4 })} />
          </div>
          <div className="field">
            <label htmlFor="prepaid">Prepaid incentive ₹{iv.prepaid_inc ?? 0}</label>
            <input id="prepaid" type="range" min={0} max={40} step={5} value={iv.prepaid_inc ?? 0}
              onChange={(e) => onCustom({ ...iv, prepaid_inc: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label htmlFor="fwd">Freight change ₹{iv.fwd_delta ?? 0}</label>
            <input id="fwd" type="range" min={-40} max={0} step={4} value={iv.fwd_delta ?? 0}
              onChange={(e) => onCustom({ ...iv, fwd_delta: Number(e.target.value) })} />
          </div>
        </div>
        <p className="tiny muted">
          These are what-if assumptions, not promises. Freight and packaging changes are Illustrative costs the
          seller would negotiate with their own suppliers.
        </p>
      </details>
    </div>
  )
}

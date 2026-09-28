import { useMemo, useState } from 'react'
import type { Band, Branch, WaterfallStep } from '../api/types'
import { inr, num, pct } from '../lib/format'

const W = 720
const H = 300
const PAD = { l: 54, r: 18, t: 18, b: 34 }

interface Series { key: string; label: string; color: string; values: Band[]; axis: 'left' | 'right'; fmt: (v: number) => string }

/** Dual-axis price response chart: orders/day and contribution/day against price, with corridor
 *  shading, a hatched out-of-corridor region and the marker set the spec asks for. */
export function PriceResponseChart({
  prices, series, corridor, markers, constraints, height = H,
}: {
  prices: number[]
  series: Series[]
  corridor: [number, number]
  markers: { current: { price: number }; recommended: { price: number } | null; argmax_orders: number; argmax_contribution: number; annotation: string | null }
  constraints?: Record<string, boolean[]>
  height?: number
}) {
  const [hover, setHover] = useState<number | null>(null)
  const svgH = height
  const innerW = W - PAD.l - PAD.r
  const innerH = svgH - PAD.t - PAD.b
  const xMin = prices[0]
  const xMax = prices[prices.length - 1]

  const scales = useMemo(() => {
    const out: Record<string, { min: number; max: number; y: (v: number) => number }> = {}
    for (const s of series) {
      const vals = s.values.flatMap((b) => [b.p10, b.p90])
      const min = s.axis === 'right' ? Math.min(0, ...vals) : 0
      const max = Math.max(...vals) * 1.05 || 1
      out[s.key] = { min, max, y: (v: number) => PAD.t + innerH - ((v - min) / (max - min || 1)) * innerH }
    }
    return out
  }, [series, innerH])

  const x = (p: number) => PAD.l + ((p - xMin) / (xMax - xMin || 1)) * innerW
  const path = (s: Series, key: 'p10' | 'p50' | 'p90') =>
    prices.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p).toFixed(1)},${scales[s.key].y(s.values[i][key]).toFixed(1)}`).join(' ')
  const bandArea = (s: Series) =>
    `${path(s, 'p50')} ${[...prices].reverse().map((p, i) => {
      const idx = prices.length - 1 - i
      return `L${x(p).toFixed(1)},${scales[s.key].y(s.values[idx].p90).toFixed(1)}`
    }).join(' ')} ${[...prices].reverse().map((p, i) => {
      const idx = prices.length - 1 - i
      return `L${x(p).toFixed(1)},${scales[s.key].y(s.values[idx].p10).toFixed(1)}`
    }).join(' ')} Z`

  const ticks = useMemo(() => {
    const step = Math.max(20, Math.round((xMax - xMin) / 6 / 10) * 10)
    const out: number[] = []
    for (let p = Math.ceil(xMin / step) * step; p <= xMax; p += step) out.push(p)
    return out.slice(0, 8)
  }, [xMin, xMax])

  // The API sends one boolean array per constraint, aligned with `prices`. A price "passes"
  // only if every constraint passes; the 12% step cap is tracked separately so those ticks can
  // be drawn greyed out (they are inside the market corridor but outside today's allowed move).
  const constraintKeys = constraints ? Object.keys(constraints) : []
  const failures = constraints && constraintKeys.length
    ? prices.map((_, i) => constraintKeys.some((k) => !constraints[k][i]))
    : null
  const hidden = constraints?.max_price_move ?? null

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${svgH}`} width="100%" height={svgH} role="img"
        aria-label={`Price response between ${xMin} and ${xMax} rupees`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const rel = ((e.clientX - rect.left) / rect.width) * W
          const t = (rel - PAD.l) / innerW
          const idx = Math.round(t * (prices.length - 1))
          setHover(Math.max(0, Math.min(prices.length - 1, idx)))
        }}>
        <defs>
          <pattern id="hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
            <line x1="0" y1="0" x2="0" y2="7" stroke="#e5e7eb" strokeWidth="3" />
          </pattern>
        </defs>

        {/* out-of-corridor shading + corridor band */}
        <rect x={PAD.l} y={PAD.t} width={Math.max(0, x(corridor[0]) - PAD.l)} height={innerH} fill="url(#hatch)" />
        <rect x={x(corridor[1])} y={PAD.t} width={Math.max(0, PAD.l + innerW - x(corridor[1]))} height={innerH} fill="url(#hatch)" />
        <rect x={x(corridor[0])} y={PAD.t} width={Math.max(0, x(corridor[1]) - x(corridor[0]))} height={innerH} fill="#f5f3ff" />

        {/* gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={PAD.l} x2={PAD.l + innerW} y1={PAD.t + innerH * f} y2={PAD.t + innerH * f} stroke="#eef0f3" />
        ))}
        <line x1={PAD.l} x2={PAD.l + innerW} y1={PAD.t + innerH} y2={PAD.t + innerH} stroke="#d1d5db" />
        <line x1={PAD.l} x2={PAD.l} y1={PAD.t} y2={PAD.t + innerH} stroke="#d1d5db" />

        {/* failing-price ticks: the guardrail story in one strip */}
        {failures ? prices.map((p, i) => (failures[i] ? (
          <line key={p} x1={x(p)} x2={x(p)} y1={PAD.t + innerH} y2={PAD.t + innerH + 5}
            stroke={hidden && hidden[i] ? '#d1d5db' : '#b91c1c'} strokeWidth="2" />
        ) : null)) : null}

        {series.map((s) => (
          <g key={s.key}>
            <path d={bandArea(s)} fill={s.color} opacity="0.14" />
            <path d={path(s, 'p50')} fill="none" stroke={s.color} strokeWidth="2.4" />
          </g>
        ))}

        {/* markers */}
        <Marker x={x(markers.current.price)} label={`now ₹${num(markers.current.price, 0)}`} color="#111827" y={PAD.t + 12} />
        {markers.recommended ? <Marker x={x(markers.recommended.price)} label={`recommended ₹${num(markers.recommended.price, 0)}`} color="#15803d" y={PAD.t + 30} /> : null}
        <Marker x={x(markers.argmax_orders)} label="highest orders" color="#1d4ed8" y={PAD.t + innerH - 6} dashed />
        <Marker x={x(markers.argmax_contribution)} label="highest contribution" color="#5b21b6" y={PAD.t + innerH - 24} dashed />

        {/* hover */}
        {hover !== null ? (
          <g>
            <line x1={x(prices[hover])} x2={x(prices[hover])} y1={PAD.t} y2={PAD.t + innerH} stroke="#9ca3af" strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.key} cx={x(prices[hover])} cy={scales[s.key].y(s.values[hover].p50)} r="3.5" fill="#fff" stroke={s.color} strokeWidth="2" />
            ))}
          </g>
        ) : null}

        {/* axes */}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={svgH - 12} fontSize="11" fill="#6b7280" textAnchor="middle">₹{t}</text>
        ))}
        <text x={PAD.l - 8} y={PAD.t + 10} fontSize="11" fill={series[0]?.color} textAnchor="end">{series[0]?.label}</text>
        {series[1] ? <text x={PAD.l + innerW + 8} y={PAD.t + 10} fontSize="11" fill={series[1]?.color} textAnchor="start">{series[1]?.label}</text> : null}
        <text x={PAD.l + innerW / 2} y={svgH - 1} fontSize="11" fill="#6b7280" textAnchor="middle">price per unit (₹)</text>
      </svg>

      <div className="legend" style={{ marginTop: 4 }}>
        <span><i style={{ background: '#7c3aed' }} />contribution/day (left)</span>
        <span><i style={{ background: '#1d4ed8' }} />orders/day (right)</span>
        <span><i style={{ background: '#f5f3ff', border: '1px solid #ddd6fe' }} />market corridor ₹{corridor[0]}–₹{corridor[1]}</span>
        <span><i style={{ background: 'repeating-linear-gradient(45deg,#e5e7eb,#e5e7eb 3px,#fff 3px,#fff 6px)' }} />outside corridor (never recommended)</span>
      </div>

      {hover !== null ? (
        <div className="card card-pad" style={{ marginTop: 8 }}>
          <div className="row-tight" style={{ justifyContent: 'space-between' }}>
            <strong>₹{num(prices[hover], 0)}</strong>
            <span className="tiny muted">{markers.annotation && hover === prices.indexOf(markers.argmax_contribution) ? markers.annotation : ''}</span>
          </div>
          {series.map((s) => (
            <div key={s.key} className="row-tight" style={{ justifyContent: 'space-between' }}>
              <span className="small muted">{s.label}</span>
              <span className="small">{s.fmt(s.values[hover].p50)} <span className="muted tiny">({s.fmt(s.values[hover].p10)}–{s.fmt(s.values[hover].p90)})</span></span>
            </div>
          ))}
        </div>
      ) : (
        <p className="tiny muted" style={{ margin: '6px 0 0' }}>Hover the chart for exact values at any price.</p>
      )}
    </div>
  )
}

function Marker({ x, label, color, y, dashed }: { x: number; label: string; color: string; y: number; dashed?: boolean }) {
  return (
    <g>
      <line x1={x} x2={x} y1={PAD.t} y2={PAD.t + (H - PAD.t - PAD.b)} stroke={color} strokeWidth="1.5" strokeDasharray={dashed ? '4 3' : undefined} opacity="0.85" />
      <rect x={x + 3} y={y - 11} width={label.length * 5.6 + 8} height={15} rx="4" fill="#fff" stroke={color} opacity="0.95" />
      <text x={x + 7} y={y} fontSize="10.5" fill={color}>{label}</text>
    </g>
  )
}

/* ------------------------------------------------------------------ waterfall */
export function Waterfall({ steps }: { steps: WaterfallStep[] }) {
  const max = Math.max(...steps.map((s) => Math.abs(s.value)))
  const color = (k: string) => (k === 'start' ? '#5b21b6' : k === 'total' ? '#111827' : k === 'loss' ? '#b91c1c' : k === 'adjust' ? '#1d4ed8' : '#6b7280')
  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} className={`waterfall-row ${s.kind === 'total' ? 'total' : ''}`}>
          <div>
            <div>{s.label}</div>
            <div className="bar" style={{ marginTop: 4, maxWidth: 260, background: '#f3f4f6' }}>
              <span style={{ width: `${(Math.abs(s.value) / max) * 100}%`, background: color(s.kind) }} />
            </div>
          </div>
          <div className="mono" style={{ color: s.value < 0 ? 'var(--red-700)' : undefined }}>
            {s.value < 0 ? '−' : ''}{inr(Math.abs(s.value), { decimals: 0 })}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ event tree */
export function EventTree({ branches, perOrder }: { branches: Branch[]; perOrder: Record<string, number> }) {
  return (
    <div>
      {branches.map((b) => {
        const good = b.value_inr > 0
        return (
          <div key={b.id} className="row-tight" style={{ justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px dashed var(--line)' }}>
            <div style={{ minWidth: 210 }}>
              <div className="small">{b.label}</div>
              <div className="bar" style={{ marginTop: 4, maxWidth: 190 }}>
                <span style={{ width: `${Math.min(100, b.probability * 100)}%`, background: good ? '#15803d' : '#b91c1c' }} />
              </div>
            </div>
            <div className="right small">
              <div>{pct(b.probability, 1)} of orders</div>
              <div className="mono" style={{ color: good ? 'var(--green-700)' : 'var(--red-700)' }}>
                {b.value_inr < 0 ? '−' : ''}{inr(Math.abs(b.value_inr))} per order
              </div>
            </div>
          </div>
        )
      })}
      <div className="row-tight" style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <strong className="small">Expected contribution per placed order</strong>
        <strong>{inr(perOrder.expected)}</strong>
      </div>
      <p className="tiny muted" style={{ marginTop: 6 }}>
        Probabilities come from the four fitted models; the ₹ beside each branch is the contribution of one
        order that ends that way (Illustrative costs).
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ funnel */
export function FunnelChain({ steps }: { steps: { stage: string; value: number; rate: number | null; benchmark_percentile: number | null; flag: string | null; comparable_skus?: number }[] }) {
  const max = Math.max(...steps.map((s) => s.value)) || 1
  return (
    <div>
      {steps.map((s, i) => (
        <div key={s.stage} className="funnel-step">
          <div className="small muted">{s.stage}</div>
          <div className="bar"><span style={{ width: `${(s.value / max) * 100}%`, background: i === 0 ? '#7c3aed' : '#a78bfa' }} /></div>
          <div className="right small">
            <div>{num(s.value, 0)}</div>
            {s.rate !== null ? <div className="tiny muted">{i === 0 ? '' : `${pct(s.rate)} of previous · `}{s.benchmark_percentile !== null ? `${Math.round(s.benchmark_percentile * 100)}th pct of category` : ''}</div> : <div className="tiny muted">{s.comparable_skus} comparable listings</div>}
            {s.flag ? <div className="tiny" style={{ color: 'var(--red-700)' }}>{s.flag}</div> : null}
          </div>
        </div>
      ))}
      <p className="tiny muted" style={{ marginTop: 6 }}>
        Last 30 days of this listing (Synthetic) against the same-category fleet percentiles.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ misc charts */
export function SensitivityBars({ drivers }: { drivers: { name: string; share: number }[] }) {
  return (
    <div>
      {drivers.map((d) => (
        <div key={d.name} className="row-tight" style={{ justifyContent: 'space-between', padding: '4px 0' }}>
          <span className="small">{d.name}</span>
          <span className="row-tight" style={{ width: '55%' }}>
            <span className="bar" style={{ width: '100%' }}><span style={{ width: `${Math.min(100, d.share * 100)}%`, background: d.share > 0.5 ? '#b45309' : '#7c3aed' }} /></span>
            <span className="tiny muted nowrap">{Math.round(d.share * 100)}%</span>
          </span>
        </div>
      ))}
    </div>
  )
}

export function MiniBars({ values, labels, color = '#7c3aed' }: { values: number[]; labels: string[]; color?: string }) {
  const max = Math.max(...values.map(Math.abs)) || 1
  return (
    <div className="row-tight" style={{ alignItems: 'flex-end', gap: 10, height: 90 }}>
      {values.map((v, i) => (
        <div key={i} className="center" style={{ flex: 1 }}>
          <div style={{ height: 56, display: 'flex', alignItems: 'flex-end' }}>
            <div style={{ width: '100%', height: `${(Math.abs(v) / max) * 100}%`, background: v < 0 ? '#b91c1c' : color, borderRadius: 4 }} title={String(v)} />
          </div>
          <div className="tiny muted">{labels[i]}</div>
        </div>
      ))}
    </div>
  )
}

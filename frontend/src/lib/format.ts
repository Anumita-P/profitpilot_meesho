/** Indian digit grouping and the display helpers every screen shares. */
export function inr(value: number, opts: { decimals?: number; compact?: boolean } = {}): string {
  if (!isFinite(value)) return '—'
  const { decimals = 0, compact = false } = opts
  const abs = Math.abs(value)
  if (compact && abs >= 100000) {
    return `₹${(value / 100000).toFixed(abs >= 1000000 ? 1 : 2)} L`
  }
  const s = abs.toFixed(decimals)
  const [whole, frac] = s.split('.')
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3
  return `${value < 0 ? '−' : ''}₹${grouped}${frac ? '.' + frac : ''}`
}

export function num(value: number, decimals = 1): string {
  if (!isFinite(value)) return '—'
  return value.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export function pct(value: number, decimals = 1): string {
  if (!isFinite(value)) return '—'
  return `${(value * 100).toFixed(decimals)}%`
}

export function pp(value: number, decimals = 1): string {
  if (!isFinite(value)) return '—'
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(decimals)}pp`
}

export function signed(value: number, decimals = 0): string {
  if (!isFinite(value)) return '—'
  return `${value >= 0 ? '+' : '−'}${inr(Math.abs(value), { decimals })}`
}

export function kRange(v: { p10: number; p50: number; p90: number }, f: (x: number) => string): string {
  return `${f(v.p10)}–${f(v.p90)}`
}

export function titleCase(s: string): string {
  return s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function dayStamp(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

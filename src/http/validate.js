/**
 * PAYLOAD VALIDATION - standard library only.
 *
 * Every write endpoint validates before it touches the store. The rules here are
 * deliberately boring: a validator either returns the coerced value or throws a
 * 400 whose `detail.field` names exactly what was wrong, because "invalid input"
 * with no field is useless to the person holding the API reference.
 *
 * No schema library, no dependencies: numbers, strings, enums, booleans, arrays
 * and objects, plus the domain odds and ends (ISO timestamps, money, ids).
 */

import { httpError } from '../store/db.js';

const MAX_STRING = 20000;

const bad = (field, message, detail = {}) => httpError(400, message, { field, ...detail });

/** Generic assertion: throw a 400 unless `cond` holds. */
export function assert(cond, field, message, detail = {}) {
  if (!cond) throw bad(field, message, detail);
  return true;
}

export function number(value, field, { min = -Infinity, max = Infinity, integer = false, required = true, default: dflt = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return dflt === undefined ? null : dflt;
    throw bad(field, `${field} is required`);
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw bad(field, `${field} must be a finite number`, { got: value });
  if (integer && !Number.isInteger(n)) throw bad(field, `${field} must be a whole number`, { got: n });
  if (n < min || n > max) throw bad(field, `${field} must be between ${min} and ${max}`, { got: n, min, max });
  return integer ? Math.round(n) : n;
}

export function money(value, field, opts = {}) {
  return number(value, field, { min: opts.min ?? 0, max: opts.max ?? 10_000_000, ...opts });
}

export function text(value, field, { min = 0, max = 240, required = true, default: dflt = null, trim = true, pattern = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return dflt;
    throw bad(field, `${field} is required`);
  }
  if (typeof value !== 'string') throw bad(field, `${field} must be a string`, { got: typeof value });
  const v = trim ? value.trim() : value;
  if (v.length < min) throw bad(field, `${field} must be at least ${min} characters`);
  if (v.length > max) throw bad(field, `${field} must be at most ${max} characters`, { got: v.length });
  if (pattern && !pattern.test(v)) throw bad(field, `${field} has an unexpected format`, { pattern: String(pattern) });
  return v;
}

export function boolean(value, field, { required = false, default: dflt = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(field, `${field} is required`);
    return dflt;
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  throw bad(field, `${field} must be true or false`, { got: value });
}

export function enumValue(value, field, allowed, { required = true, default: dflt = null, normalise = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return dflt;
    throw bad(field, `${field} is required`, { allowed });
  }
  const raw = String(value);
  const candidates = normalise ? [raw, raw.toLowerCase(), raw.toUpperCase(), raw.toLowerCase().replace(/[\s-]+/g, '_')] : [raw];
  for (const c of candidates) if (allowed.includes(c)) return c;
  throw bad(field, `${field} must be one of: ${allowed.join(', ')}`, { got: value, allowed });
}

export function id(value, field, { required = true, pattern = /^[A-Za-z0-9._:-]{1,80}$/ } = {}) {
  const v = text(value, field, { required, max: 80 });
  if (v == null) return v;
  if (!pattern.test(v)) throw bad(field, `${field} must be an id (letters, digits, . _ : -)`, { got: v });
  return v;
}

export function timestamp(value, field, { required = true, default: dflt = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return dflt;
    throw bad(field, `${field} is required (ISO 8601)`);
  }
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) throw bad(field, `${field} must be an ISO 8601 timestamp`, { got: value });
  return t.toISOString();
}

export function array(value, field, { min = 0, max = 1000, required = true, default: dflt = [] } = {}) {
  if (value === undefined || value === null) {
    if (!required) return dflt;
    throw bad(field, `${field} is required`);
  }
  if (!Array.isArray(value)) throw bad(field, `${field} must be an array`, { got: typeof value });
  if (value.length < min) throw bad(field, `${field} must have at least ${min} item(s)`);
  if (value.length > max) throw bad(field, `${field} must have at most ${max} items`, { got: value.length });
  return value;
}

export function object(value, field, { required = true, default: dflt = {} } = {}) {
  if (value === undefined || value === null) {
    if (!required) return dflt;
    throw bad(field, `${field} is required`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw bad(field, `${field} must be an object`, { got: Array.isArray(value) ? 'array' : typeof value });
  return value;
}

/**
 * Validate an object against a shape map: `validate(body, { price: (v) => money(v, 'price') })`.
 * Collects the FIRST failure (fail fast) and returns the cleaned object.
 */
export function validate(input, shape, { allowUnknown = true } = {}) {
  const src = object(input, 'body', { required: false, default: {} });
  const out = {};
  for (const [key, rule] of Object.entries(shape)) {
    out[key] = typeof rule === 'function' ? rule(src[key], key) : rule;
  }
  if (!allowUnknown) {
    const unknown = Object.keys(src).filter((k) => !(k in shape));
    if (unknown.length) throw bad(unknown[0], `unknown field: ${unknown[0]}`, { unknown });
  }
  return out;
}

/** Trim a string, never throwing: for display/log fields. */
export function softText(value, max = 240) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export { MAX_STRING };

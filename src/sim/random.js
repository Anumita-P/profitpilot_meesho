/**
 * DETERMINISTIC RANDOMNESS (v2 phase 1).
 *
 * The simulator must produce the SAME stream for the same seed, in this process
 * or the next, on any machine. So: no Math.random, no wall clock, no ordering
 * dependence on object keys.
 *
 * `rng(seed)` is mulberry32 - 32 bits of state, uniform in [0,1), fast, and
 * trivially reproducible (a reviewer can re-implement it in ten lines).
 * `sub(seed, ...parts)` derives an independent stream from a seed and a few
 * labels, so each listing/day draws from its own stream instead of sharing a
 * cursor: adding a new draw for day 3 cannot silently change day 2.
 */

/** FNV-1a over a string -> unsigned 32-bit int. */
export function hashSeed(...parts) {
  const s = parts.filter((p) => p !== undefined && p !== null).join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: deterministic uniform stream in [0, 1). */
export function rng(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An independent stream for one label combination. */
export function sub(seed, ...parts) {
  return rng(hashSeed(seed, ...parts));
}

/** Deterministic helpers built on a stream. */
export const pick = (rand, list) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
export const bernoulli = (rand, p) => rand() < p;
/** Jitter in [1 - spread, 1 + spread]. */
export const jitter = (rand, spread) => 1 + (rand() * 2 - 1) * spread;
/**
 * Round a count without introducing a systematic bias: 12.4 -> 12 four times in
 * ten, 13 six times in ten. Keeps long-run volumes honest.
 */
export const roundCount = (rand, x) => {
  const base = Math.floor(x);
  return base + (rand() < (x - base) ? 1 : 0);
};

/** A short, stable fingerprint of a parameter object - for "is this the same run?". */
export function fingerprintOf(obj) {
  return hashSeed(JSON.stringify(obj)).toString(16).padStart(8, '0');
}

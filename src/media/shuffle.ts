/**
 * Ported from embed-anything (MIT).
 * A deterministic, seeded shuffle.
 *
 * The reference shuffles the catalog with `Math.random()`, which makes visual
 * regression tests impossible. This implementation uses the same Fisher-Yates
 * algorithm with a seeded PRNG so the initial composition is reproducible while
 * still looking random.
 */

/** mulberry32 — a small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hashes a string into a 32-bit seed (FNV-1a). */
export function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

/**
 * Fisher-Yates shuffle with a seeded PRNG.
 *
 * @param items The array to shuffle. It is **not** modified.
 * @param seed The seed. The same seed always yields the same order.
 *   `USE_MATH_RANDOM` shuffles with `Math.random()` instead, which reproduces
 *   the reference Space's non-deterministic ordering (useful when comparing
 *   against the original bundle).
 */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = seed === USE_MATH_RANDOM ? Math.random : mulberry32(seed);
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** The seed value that selects `Math.random()` as the shuffle source. */
export const USE_MATH_RANDOM = -1;

/**
 * Reads the seed from the URL (`?seed=…`), falling back to a fixed default.
 *
 * The default seed is intentionally fixed so screenshots are reproducible.
 */
export function resolveSeed(search = typeof location === 'undefined' ? '' : location.search): number {
  try {
    const params = new URLSearchParams(search);
    const raw = params.get('seed');
    if (raw === null) return DEFAULT_SEED;
    if (raw === 'math') return USE_MATH_RANDOM;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed >>> 0 : hashSeed(raw);
  } catch {
    return DEFAULT_SEED;
  }
}

/** The default shuffle seed. */
export const DEFAULT_SEED = 0x656d6265;

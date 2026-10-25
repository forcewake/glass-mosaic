/**
 * Bounded Damerau-Levenshtein (optimal string alignment) distance.
 * Returns `max + 1` as soon as the distance is known to exceed `max`.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let current = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prev2[j - 2] + 1);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, current] = [prev, current, prev2];
  }
  return Math.min(prev[n], max + 1);
}

/** The edit budget for a query term: none for short words, 2 for long ones. */
export function fuzzBudget(term: string): number {
  if (term.length < 4) return 0;
  return term.length >= 7 ? 2 : 1;
}

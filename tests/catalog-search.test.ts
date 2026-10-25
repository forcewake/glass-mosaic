import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeCatalog } from '../src/media/catalog';
import { buildIndex } from '../src/search/indexer';
import { Ranker } from '../src/search/ranker';

const items = normalizeCatalog(JSON.parse(readFileSync(new URL('../public/data/catalog.json', import.meta.url), 'utf8')));
const byId = new Map(items.map((i) => [i.id, i]));
const ranker = new Ranker(buildIndex(items));
const top = (q: string, n = 5) => ranker.search(q).hits.slice(0, n).map((h) => byId.get(h.id)!);

describe('search over the shipped catalog', () => {
  it('"mountains" returns mountain photos first', () => {
    const result = ranker.search('mountains');
    expect(result.hits.length).toBeGreaterThan(10);
    expect(result.hits[0].relevance).toBe(1);
    for (const item of top('mountains')) expect(item.topic).toBe('Mountains');
  });

  it('typos still find mountains', () => {
    expect(top('montains', 3).every((i) => i.topic === 'Mountains')).toBe(true);
  });

  it('"rain sounds" prefers audio', () => {
    const [first] = top('rain sounds', 1);
    expect(first.type).toBe('audio');
    expect(first.topic).toBe('Rain');
  });

  it('"ocean video" prefers video', () => {
    expect(top('ocean video', 3).every((i) => i.type === 'video')).toBe(true);
  });

  it('is fast enough for every keystroke', () => {
    const queries = ['m', 'mo', 'mou', 'moun', 'mount', 'mounta', 'mountai', 'mountain', 'snowy peaks', 'citty lights at nigth'];
    const start = performance.now();
    for (let r = 0; r < 10; r++) for (const q of queries) ranker.search(q);
    expect((performance.now() - start) / (10 * queries.length)).toBeLessThan(20);
  });
});

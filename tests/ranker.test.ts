import { describe, expect, it } from 'vitest';
import { buildIndex, isSearchIndex } from '../src/search/indexer';
import { Ranker } from '../src/search/ranker';
import { DOCS } from './fixtures';

const index = buildIndex(DOCS);
const ranker = new Ranker(index);
const ids = (query: string) => ranker.search(query).hits.map((hit) => hit.id);

describe('indexer', () => {
  it('produces a valid, sorted, JSON-safe index', () => {
    expect(isSearchIndex(index)).toBe(true);
    expect(index.ids).toHaveLength(DOCS.length);
    expect([...index.terms].sort()).toEqual(index.terms);
    expect(isSearchIndex(JSON.parse(JSON.stringify(index)))).toBe(true);
    expect(isSearchIndex({ version: 99 })).toBe(false);
  });

  it('stores postings in ascending doc order', () => {
    for (const list of index.postings) {
      for (let i = 2; i < list.length; i += 2) expect(list[i]).toBeGreaterThan(list[i - 2]);
    }
  });
});

describe('ranker', () => {
  it('ranks exact matches first with full relevance', () => {
    const result = ranker.search('mountains');
    expect(result.hits.slice(0, 2).map((h) => h.id).sort()).toEqual(['alps', 'andes']);
    expect(result.hits[0].relevance).toBe(1);
    expect(result.tokens).toEqual(['mountain']);
  });

  it('keeps synonym-only matches below exact ones', () => {
    const hits = ranker.search('mountains').hits;
    const massif = hits.findIndex((h) => h.id === 'massif');
    if (massif !== -1) {
      expect(massif).toBeGreaterThan(1);
      expect(hits[massif].relevance).toBeLessThan(1);
    }
  });

  it('matches prefixes while typing', () => {
    expect(ids('mount')[0]).toMatch(/alps|andes/);
    expect(ids('oce')).toEqual(expect.arrayContaining(['ocean-video', 'ocean-photo']));
  });

  it('tolerates typos with fuzzy matching and lower relevance', () => {
    const result = ranker.search('montains');
    expect(result.hits[0].id).toMatch(/alps|andes/);
    expect(result.hits[0].relevance).toBeLessThan(1);
    expect(result.hits[0].relevance).toBeGreaterThan(0.3);
    expect(ids('mountian')[0]).toMatch(/alps|andes/);
  });

  it('expands synonyms', () => {
    expect(ids('sea')).toEqual(expect.arrayContaining(['ocean-video', 'ocean-photo']));
    expect(ids('kitty')).toContain('cat');
    expect(ids('feline')).toContain('cat');
  });

  it('uses media type words as intent', () => {
    const rain = ranker.search('rain sounds');
    expect(rain.typeIntent).toBe('audio');
    expect(rain.hits[0].id).toBe('rain-audio');
    const ocean = ranker.search('ocean video');
    expect(ocean.typeIntent).toBe('video');
    expect(ocean.hits[0].id).toBe('ocean-video');
  });

  it('returns every item of a type for a type-only query', () => {
    const result = ranker.search('sounds');
    expect(result.hits.map((h) => h.id).sort()).toEqual(['birdsong', 'rain-audio']);
  });

  it('rewards documents that cover more query terms', () => {
    expect(ids('wolves snow')[0]).toBe('wolf');
  });

  it('returns nothing for empty, stopword-only or unknown queries', () => {
    expect(ranker.search('').hits).toEqual([]);
    expect(ranker.search('   the of ').hits).toEqual([]);
    expect(ranker.search('zzzzqx').hits).toEqual([]);
  });

  it('respects the limit and keeps relevance within 0..1, sorted by score', () => {
    const result = ranker.search('a', { limit: 3 });
    expect(result.hits.length).toBeLessThanOrEqual(3);
    const all = ranker.search('rain ocean forest');
    for (let i = 1; i < all.hits.length; i++) expect(all.hits[i].score).toBeLessThanOrEqual(all.hits[i - 1].score);
    for (const hit of all.hits) {
      expect(hit.relevance).toBeGreaterThanOrEqual(0);
      expect(hit.relevance).toBeLessThanOrEqual(1);
    }
  });

  it('is diacritic and case insensitive', () => {
    expect(ids('MATTERHÖRN')[0]).toBe('alps');
  });
});

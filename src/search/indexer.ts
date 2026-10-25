/**
 * Builds the inverted index (BM25F) over captions and metadata.
 *
 * Runs at build time (`scripts/build-index.ts` writes
 * `public/data/search-index.json`) and, as a fallback, in the browser when the
 * prebuilt file is missing or stale. Field-normalised term frequencies are
 * pre-computed, so the browser only has to do idf × saturation per posting.
 */
import { tokenize } from './text';

export const INDEX_VERSION = 1;

/** Field weights of the BM25F combination. */
export const FIELD_WEIGHTS = { title: 3, topic: 2.5, tags: 2, description: 1, artist: 0.5 } as const;
export type Field = keyof typeof FIELD_WEIGHTS;
const FIELDS = Object.keys(FIELD_WEIGHTS) as Field[];

export const BM25 = { k1: 1.2, b: 0.75 } as const;

/** The minimal document shape the indexer needs. */
export interface IndexableDoc {
  id: string;
  type: 'image' | 'video' | 'audio';
  title: string;
  topic: string;
  tags: readonly string[];
  description: string;
  artist: string;
}

export interface SearchIndex {
  version: typeof INDEX_VERSION;
  /** Document ids, by internal doc number. */
  ids: string[];
  /** Media type per document: 0 image, 1 video, 2 audio. */
  types: number[];
  /** Sorted vocabulary. */
  terms: string[];
  /**
   * Postings per term, flattened as `[doc, weightedTf × 100, doc, …]`
   * (ascending doc numbers).
   */
  postings: number[][];
}

export const TYPE_CODE = { image: 0, video: 1, audio: 2 } as const;

function fieldText(doc: IndexableDoc, field: Field): string {
  switch (field) {
    case 'tags':
      return doc.tags.join(' ; ');
    default:
      return doc[field];
  }
}

/** Builds the index. Deterministic for a given input order. */
export function buildIndex(docs: readonly IndexableDoc[]): SearchIndex {
  const tokens = docs.map((doc) => FIELDS.map((field) => tokenize(fieldText(doc, field))));
  const averages = FIELDS.map((_, f) => {
    const total = tokens.reduce((sum, fields) => sum + fields[f].length, 0);
    return Math.max(1, total / Math.max(1, docs.length));
  });

  const table = new Map<string, Map<number, number>>();
  tokens.forEach((fields, doc) => {
    const weighted = new Map<string, number>();
    fields.forEach((list, f) => {
      if (!list.length) return;
      const counts = new Map<string, number>();
      for (const term of list) counts.set(term, (counts.get(term) ?? 0) + 1);
      const norm = 1 - BM25.b + (BM25.b * list.length) / averages[f];
      const weight = FIELD_WEIGHTS[FIELDS[f]];
      for (const [term, tf] of counts) weighted.set(term, (weighted.get(term) ?? 0) + (weight * tf) / norm);
    });
    for (const [term, tfw] of weighted) {
      let postings = table.get(term);
      if (!postings) table.set(term, (postings = new Map()));
      postings.set(doc, tfw);
    }
  });

  const terms = [...table.keys()].sort();
  const postings = terms.map((term) => {
    const flat: number[] = [];
    for (const [doc, tfw] of [...table.get(term)!].sort((a, b) => a[0] - b[0])) {
      flat.push(doc, Math.max(1, Math.round(tfw * 100)));
    }
    return flat;
  });
  return {
    version: INDEX_VERSION,
    ids: docs.map((doc) => doc.id),
    types: docs.map((doc) => TYPE_CODE[doc.type]),
    terms,
    postings,
  };
}

/** Light structural validation of a parsed index file. */
export function isSearchIndex(value: unknown): value is SearchIndex {
  const v = value as SearchIndex;
  return (
    !!v &&
    v.version === INDEX_VERSION &&
    Array.isArray(v.ids) &&
    Array.isArray(v.types) &&
    Array.isArray(v.terms) &&
    Array.isArray(v.postings) &&
    v.terms.length === v.postings.length &&
    v.ids.length === v.types.length
  );
}

/**
 * The in-browser ranker: BM25F over the prebuilt inverted index, with
 * per-token query expansion (exact → synonyms → prefix → fuzzy).
 *
 * For each query token the best-scoring expansion is kept per document, and
 * the token scores are summed. Documents that match more of the query rank
 * higher (coverage factor) and an explicit media-type word ("video", "sound",
 * "photo") acts as a type intent.
 */
import { BM25, TYPE_CODE, type SearchIndex } from './indexer';
import { synonymsOf } from './synonyms';
import { editDistance, fuzzBudget } from './fuzzy';
import { stem, TYPE_WORDS, tokenize, words } from './text';

export interface SearchHit {
  /** Document id. */
  id: string;
  /** Raw BM25F score (unbounded). */
  score: number;
  /**
   * A 0..1 relevance used in the UI: how well the query terms were matched
   * (exact 1, prefix/synonym/fuzzy less, missing 0) × the score relative to
   * the best hit.
   */
  relevance: number;
  /** Fraction of the content tokens this document matched. */
  coverage: number;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** Content tokens after normalisation. */
  tokens: string[];
  /** Media type implied by the query, if any. */
  typeIntent: 'image' | 'video' | 'audio' | null;
  /** Wall-clock time spent ranking, in milliseconds. */
  elapsedMs: number;
}

export interface RankOptions {
  limit?: number;
}

const WEIGHT = { exact: 1, synonym: 0.6, prefix: 0.8, fuzzy: 0.55 } as const;
const MAX_PREFIX = 12;
const MAX_FUZZY = 6;
const TYPE_BOOST = 1.35;
const TYPE_PENALTY = 0.7;
/** Nominal score of a type-only query ("videos"). */
const TYPE_ONLY_SCORE = 1;

interface Expansion {
  term: number;
  weight: number;
}

export class Ranker {
  private readonly idf: Float64Array;
  private readonly termIndex: Map<string, number>;

  constructor(private readonly index: SearchIndex) {
    const n = index.ids.length;
    this.idf = new Float64Array(index.terms.length);
    this.termIndex = new Map();
    index.terms.forEach((term, i) => {
      const df = index.postings[i].length / 2;
      this.idf[i] = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      this.termIndex.set(term, i);
    });
  }

  get size(): number {
    return this.index.ids.length;
  }

  /** Index of the first term >= `prefix` (binary search on the sorted vocabulary). */
  private lowerBound(prefix: string): number {
    const terms = this.index.terms;
    let low = 0;
    let high = terms.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (terms[mid] < prefix) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  /** Candidate index terms for one (stemmed) query token, with their weights. */
  expand(token: string, raw = token): Expansion[] {
    const out = new Map<number, number>();
    const add = (term: number, weight: number) => {
      if ((out.get(term) ?? 0) < weight) out.set(term, weight);
    };
    const exact = this.termIndex.get(token);
    if (exact !== undefined) add(exact, WEIGHT.exact);
    for (const synonym of synonymsOf(token)) {
      const i = this.termIndex.get(synonym);
      if (i !== undefined) add(i, WEIGHT.synonym);
    }
    // Prefix matches (typing "mount" finds "mountain"), from the raw form so a
    // half-typed word is not mangled by the stemmer.
    const terms = this.index.terms;
    for (const prefix of new Set([raw, token])) {
      if (prefix.length < 2) continue;
      let count = 0;
      for (let i = this.lowerBound(prefix); i < terms.length && count < MAX_PREFIX; i++) {
        const term = terms[i];
        if (!term.startsWith(prefix)) break;
        if (term === token) continue;
        add(i, WEIGHT.prefix * Math.min(1, prefix.length / term.length + 0.25));
        count++;
      }
    }
    // Fuzzy matches only when nothing else matched: typo tolerance without
    // diluting good queries.
    if (out.size === 0) {
      const budget = fuzzBudget(token);
      if (budget > 0) {
        const found: Array<[number, number]> = [];
        for (let i = 0; i < terms.length; i++) {
          const term = terms[i];
          if (Math.abs(term.length - token.length) > budget || term[0] !== token[0]) continue;
          const distance = editDistance(token, term, budget);
          if (distance <= budget) found.push([i, distance]);
        }
        found.sort((a, b) => a[1] - b[1] || this.idf[b[0]] - this.idf[a[0]]);
        for (const [i, distance] of found.slice(0, MAX_FUZZY)) add(i, distance === 1 ? WEIGHT.fuzzy : WEIGHT.fuzzy * 0.55);
      }
    }
    return [...out].map(([term, weight]) => ({ term, weight }));
  }

  /** Ranks the catalog for a free-text query. */
  search(query: string, options: RankOptions = {}): SearchResult {
    const started = performance.now();
    const limit = options.limit ?? 60;
    let typeIntent: SearchResult['typeIntent'] = null;
    const contentRaw: string[] = [];
    for (const word of words(query)) {
      const type = TYPE_WORDS[word];
      if (type) typeIntent = type;
      else contentRaw.push(word);
    }
    const tokens: string[] = [];
    const raws: string[] = [];
    for (const word of contentRaw) {
      const [token] = tokenize(word);
      if (!token || tokens.includes(token)) continue;
      tokens.push(token);
      raws.push(word);
    }

    const n = this.index.ids.length;
    const scores = new Float64Array(n);
    const matched = new Uint16Array(n);
    const best = new Float64Array(n);
    const bestWeight = new Float64Array(n);
    const quality = new Float64Array(n);
    tokens.forEach((token, t) => {
      best.fill(0);
      bestWeight.fill(0);
      const expansions = this.expand(token, raws[t]);
      // All expansions of a token share one idf: the exact term's when it
      // exists, else the best-weighted expansion's. Otherwise a rare synonym
      // or a rare typo neighbour would outrank the word the user typed.
      let reference = expansions[0];
      for (const e of expansions) {
        if (e.weight > reference.weight || (e.weight === reference.weight && this.idf[e.term] < this.idf[reference.term])) {
          reference = e;
        }
      }
      for (const { term, weight } of expansions) {
        const idf = this.idf[reference.term];
        const postings = this.index.postings[term];
        for (let p = 0; p < postings.length; p += 2) {
          const doc = postings[p];
          const tfw = postings[p + 1] / 100;
          const value = weight * idf * ((tfw * (BM25.k1 + 1)) / (tfw + BM25.k1));
          if (value > best[doc]) {
            best[doc] = value;
            bestWeight[doc] = weight;
          }
        }
      }
      for (let doc = 0; doc < n; doc++) {
        if (best[doc] > 0) {
          scores[doc] += best[doc];
          quality[doc] += bestWeight[doc];
          matched[doc]++;
        }
      }
    });

    const intentCode = typeIntent ? TYPE_CODE[typeIntent] : -1;
    const hits: SearchHit[] = [];
    for (let doc = 0; doc < n; doc++) {
      let score: number;
      let coverage: number;
      let match = 1;
      if (tokens.length) {
        if (!matched[doc]) continue;
        coverage = matched[doc] / tokens.length;
        match = quality[doc] / tokens.length;
        score = scores[doc] * (0.5 + 0.5 * coverage);
        if (intentCode >= 0) score *= this.index.types[doc] === intentCode ? TYPE_BOOST : TYPE_PENALTY;
      } else if (intentCode >= 0) {
        // Only a type word ("videos"): every item of that type, catalog order.
        if (this.index.types[doc] !== intentCode) continue;
        coverage = 1;
        score = TYPE_ONLY_SCORE;
      } else {
        continue;
      }
      hits.push({ id: this.index.ids[doc], score, coverage, relevance: match });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const top = hits.slice(0, limit);
    const topScore = top[0]?.score ?? 1;
    for (const hit of top) {
      hit.relevance = Math.round(Math.min(1, hit.relevance) * Math.sqrt(hit.score / topScore) * 100) / 100;
    }
    return { query, hits: top, tokens, typeIntent, elapsedMs: performance.now() - started };
  }
}

/** Convenience used by tests: the stemmed form of a single word. */
export const queryTerm = (word: string): string => stem(word.toLowerCase());

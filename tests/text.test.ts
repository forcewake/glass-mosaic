import { describe, expect, it } from 'vitest';
import { normalize, stem, tokenize, words, TYPE_WORDS } from '../src/search/text';
import { editDistance, fuzzBudget } from '../src/search/fuzzy';
import { synonymsOf } from '../src/search/synonyms';

describe('text', () => {
  it('normalizes case and diacritics', () => {
    expect(normalize('Sète Crème BRÛLÉE')).toBe('sete creme brulee');
  });

  it('stems plurals and common suffixes without mangling short words', () => {
    expect(stem('mountains')).toBe('mountain');
    expect(stem('wolves')).toBe('wolf');
    expect(stem('cities')).toBe('city');
    expect(stem('beaches')).toBe('beach');
    expect(stem('glass')).toBe('glass');
    expect(stem('waves')).toBe('wave');
    expect(stem('sing')).toBe('sing');
  });

  it('tokenizes into stemmed content words and drops stopwords', () => {
    expect(tokenize('The mountains of the Alps')).toEqual(['mountain', 'alp']);
    expect(words('Rain, falling!')).toEqual(['rain', 'falling']);
  });

  it('knows media type words', () => {
    expect(TYPE_WORDS.video).toBe('video');
    expect(TYPE_WORDS.sounds ?? TYPE_WORDS.sound).toBe('audio');
    expect(TYPE_WORDS.photo).toBe('image');
  });
});

describe('fuzzy', () => {
  it('computes bounded edit distance with transpositions', () => {
    expect(editDistance('mountain', 'mountain')).toBe(0);
    expect(editDistance('montain', 'mountain')).toBe(1);
    expect(editDistance('mountian', 'mountain')).toBe(1);
    expect(editDistance('ocaen', 'ocean')).toBe(1);
    expect(editDistance('cat', 'forest', 2)).toBeGreaterThan(2);
  });

  it('allows more typos in longer words', () => {
    expect(fuzzBudget('cat')).toBe(0);
    expect(fuzzBudget('rain')).toBe(1);
    expect(fuzzBudget('mountain')).toBe(2);
  });
});

describe('synonyms', () => {
  it('is bidirectional and stemmed', () => {
    const sea = synonymsOf('sea');
    expect(sea).toContain('ocean');
    expect(synonymsOf('ocean')).toContain('sea');
    expect(synonymsOf('zzzz')).toEqual([]);
  });
});

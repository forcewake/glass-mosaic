/**
 * Text normalisation shared by the build-time indexer and the in-browser ranker.
 *
 * Both sides must produce identical terms, so everything here is pure and
 * deterministic: lower-casing, Unicode decomposition with diacritics removed,
 * tokenisation on anything that is not a letter or digit, a short stop-word
 * list and a deliberately light English stemmer (plurals and -ing/-ed).
 */

const STOPWORDS = new Set(
  (
    'a an and are as at be by for from has have in into is it its of on or that the this to was were with ' +
    'de del la le les el los das der die und von du des en et y il di da file jpg jpeg png webm ogg mp3 wav ' +
    'image images photo photos picture pictures video videos audio sound sounds'
  ).split(' '),
);

/** Media-type words: they are indexed in a separate "type" field, never as text. */
export const TYPE_WORDS: Record<string, 'image' | 'video' | 'audio'> = {
  photo: 'image',
  photos: 'image',
  photograph: 'image',
  image: 'image',
  images: 'image',
  picture: 'image',
  pictures: 'image',
  pic: 'image',
  video: 'video',
  videos: 'video',
  clip: 'video',
  clips: 'video',
  footage: 'video',
  film: 'video',
  movie: 'video',
  audio: 'audio',
  sound: 'audio',
  sounds: 'audio',
  recording: 'audio',
  recordings: 'audio',
  soundscape: 'audio',
  noise: 'audio',
};

/** Lower-case, strip diacritics and fold a few typographic characters. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'o')
    .replace(/[ł]/g, 'l');
}

const IRREGULAR: Record<string, string> = {
  wolves: 'wolf',
  leaves: 'leaf',
  knives: 'knife',
  shelves: 'shelf',
  calves: 'calf',
  halves: 'half',
  hooves: 'hoof',
  geese: 'goose',
  mice: 'mouse',
  children: 'child',
  people: 'person',
  men: 'man',
  women: 'woman',
  teeth: 'tooth',
  feet: 'foot',
  oxen: 'ox',
  cacti: 'cactus',
  fungi: 'fungus',
};

const KEEP = new Set(['news', 'glass', 'grass', 'moss', 'bus', 'gas', 'lens', 'chess', 'canvas', 'virus', 'cactus', 'iris', 'axis', 'oasis', 'series', 'species', 'swiss', 'bass']);

/** A light, predictable English stemmer: plurals, -ing and -ed. */
export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  const irregular = IRREGULAR[word];
  if (irregular) return irregular;
  if (KEEP.has(word)) return word;
  let w = word;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (/(ches|shes|xes|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('oes') && w.length > 5) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  else if (w.endsWith('ing') && w.length >= 7) w = undouble(w.slice(0, -3));
  else if (w.endsWith('ed') && w.length >= 6 && !w.endsWith('eed')) w = undouble(w.slice(0, -2));
  return w;
}

function undouble(w: string): string {
  return /([bdgmnprt])\1$/.test(w) ? w.slice(0, -1) : w;
}

/** Splits text into raw (unstemmed) normalised words. */
export function words(text: string): string[] {
  return normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Text -> index terms (normalised, stop words removed, stemmed). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of words(text)) {
    if (word.length < 2 && !/\d/.test(word)) continue;
    if (STOPWORDS.has(word)) continue;
    out.push(stem(word));
  }
  return out;
}

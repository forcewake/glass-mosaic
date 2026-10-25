/**
 * Cheap, hand-written synonym groups. Every word of a group expands to the
 * others (stemmed), with a reduced weight in the ranker. Keep them tight:
 * a synonym that is too loose ruins precision faster than it helps recall.
 */
import { stem } from './text';

const GROUPS: string[][] = [
  ['mountain', 'peak', 'summit', 'alps', 'alpine', 'massif', 'ridge'],
  ['ocean', 'sea', 'marine', 'seascape', 'waves'],
  ['beach', 'coast', 'shore', 'seaside'],
  ['forest', 'woods', 'woodland', 'jungle', 'rainforest'],
  ['tree', 'oak', 'pine', 'birch'],
  ['city', 'urban', 'skyline', 'downtown', 'metropolis', 'town'],
  ['street', 'road', 'avenue', 'alley'],
  ['car', 'automobile', 'vehicle'],
  ['dog', 'puppy', 'canine', 'hound'],
  ['cat', 'kitten', 'kitty', 'feline'],
  ['bird', 'avian', 'songbird'],
  ['birdsong', 'chirp', 'tweet', 'birdcall'],
  ['flower', 'blossom', 'bloom', 'floral', 'petal'],
  ['night', 'nocturnal', 'nighttime', 'stars'],
  ['snow', 'winter', 'snowy', 'blizzard'],
  ['ice', 'glacier', 'frozen'],
  ['river', 'stream', 'creek', 'brook'],
  ['lake', 'pond', 'reservoir'],
  ['waterfall', 'cascade', 'falls'],
  ['desert', 'dune', 'sand', 'arid'],
  ['sunset', 'sunrise', 'dusk', 'dawn', 'twilight'],
  ['rain', 'rainfall', 'shower', 'drizzle', 'storm'],
  ['thunder', 'lightning', 'thunderstorm'],
  ['space', 'galaxy', 'cosmos', 'nebula', 'astronomy', 'universe'],
  ['moon', 'lunar'],
  ['food', 'dish', 'meal', 'cuisine'],
  ['fruit', 'berry', 'apple', 'orange'],
  ['train', 'railway', 'railroad', 'locomotive', 'tram'],
  ['boat', 'ship', 'vessel', 'sailboat', 'yacht'],
  ['aircraft', 'airplane', 'aeroplane', 'plane', 'jet', 'aviation'],
  ['castle', 'fortress', 'palace', 'citadel'],
  ['architecture', 'building', 'facade', 'cathedral', 'church'],
  ['bridge', 'viaduct', 'aqueduct'],
  ['cave', 'cavern', 'grotto'],
  ['volcano', 'volcanic', 'lava', 'eruption'],
  ['island', 'isle', 'atoll'],
  ['underwater', 'reef', 'coral', 'diving'],
  ['market', 'bazaar', 'stall'],
  ['music', 'musician', 'concert', 'instrument'],
  ['piano', 'keyboard'],
  ['violin', 'fiddle'],
  ['drum', 'percussion'],
  ['guitar', 'strum'],
  ['bell', 'chime', 'carillon'],
  ['horse', 'pony', 'equine', 'stallion', 'mare'],
  ['insect', 'bug', 'beetle', 'butterfly', 'bee'],
  ['frog', 'toad', 'amphibian'],
  ['owl', 'hoot'],
  ['wolf', 'howl'],
  ['whale', 'cetacean', 'humpback'],
  ['mammal', 'animal', 'wildlife'],
  ['sky', 'cloud', 'clouds'],
  ['fire', 'flame', 'blaze', 'campfire'],
  ['sport', 'athlete', 'game', 'match'],
  ['wind', 'breeze', 'gust'],
];

function buildMap(): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const group of GROUPS) {
    const stems = [...new Set(group.map(stem))];
    for (const s of stems) {
      const set = map.get(s) ?? new Set<string>();
      for (const other of stems) if (other !== s) set.add(other);
      map.set(s, set);
    }
  }
  return new Map([...map].map(([k, v]) => [k, [...v]]));
}

const SYNONYMS = buildMap();

/** Stemmed synonyms of a stemmed term (never includes the term itself). */
export function synonymsOf(term: string): readonly string[] {
  return SYNONYMS.get(term) ?? [];
}

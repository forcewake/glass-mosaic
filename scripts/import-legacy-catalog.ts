/**
 * OPTIONAL, ISOLATED: converts a *local copy* of an embed-anything
 * `public/local/catalog.json` into this app's catalog format.
 *
 * Why this exists: embed-anything's catalog is extracted from the deployed
 * JavaScript bundle of the Hugging Face Space
 * `webml-community/embeddinggemma-2-webgpu` (its `scripts/build-catalog.mjs`
 * parses manifests out of that bundle). Glass Mosaic does NOT depend on that:
 * its default catalog is built from the public Wikimedia Commons API
 * (`npm run catalog:build`). This converter is only for someone who already
 * has that legacy file and accepts its licensing (Unsplash, Pexels, Pixabay
 * and Wikimedia items, each under its own terms; the Space bundle itself has
 * no known open-source license).
 *
 * It never downloads anything: no bundle, no embeddings, no model. Embedding
 * rows/indices are dropped. Items without an https media URL are skipped.
 *
 * Usage:
 *   npm run catalog:import-legacy -- <legacy-catalog.json> [out.json]
 *   (default out: public/data/catalog.legacy.json; rename to catalog.json to use)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Raw = Record<string, unknown>;

const [input, output = 'public/data/catalog.legacy.json'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: npm run catalog:import-legacy -- <legacy-catalog.json> [out.json]');
  process.exit(2);
}

const https = (v: unknown): string | undefined => (typeof v === 'string' && /^https:\/\//.test(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function licenseFor(page: string): string {
  if (/unsplash\.com/.test(page)) return 'Unsplash License';
  if (/pexels\.com/.test(page)) return 'Pexels License';
  if (/pixabay\.com/.test(page)) return 'Pixabay Content License';
  return 'See source page';
}

const legacy = JSON.parse(readFileSync(resolve(input), 'utf8')) as { collections?: Record<string, { items?: Raw[] }> };
const items: Raw[] = [];
let skipped = 0;

for (const [type, collection] of Object.entries(legacy.collections ?? {})) {
  if (!['image', 'video', 'audio'].includes(type)) continue;
  for (const raw of collection.items ?? []) {
    const page = https(raw.photoPage) ?? https(raw.source) ?? '';
    const imageUrl = https(raw.unsplashId);
    const src = type === 'image' ? imageUrl : https(raw.url);
    const thumb = type === 'image' ? imageUrl : https(raw.poster);
    if (!src || (type !== 'audio' && !thumb)) {
      skipped++;
      continue;
    }
    items.push({
      id: `legacy-${type}-${str(raw.id) || items.length}`,
      type,
      title: str(raw.title),
      description: str(raw.description),
      topic: str(raw.topic),
      tags: [],
      license: licenseFor(page),
      licenseUrl: null,
      artist: 'See source page',
      page,
      aspectRatio: Number(raw.aspectRatio) || undefined,
      thumb,
      src,
      poster: https(raw.poster),
      durationSeconds: Number(raw.durationSeconds) || undefined,
      waveform: Array.isArray(raw.waveform) ? raw.waveform : undefined,
    });
  }
}

writeFileSync(
  resolve(output),
  JSON.stringify({
    version: 1,
    source: 'Converted from a local embed-anything catalog (legacy, see scripts/import-legacy-catalog.ts)',
    generatedAt: new Date().toISOString(),
    notice: 'Each item keeps its own license. Check every item before publishing.',
    items,
  }),
);
console.log(`[import-legacy] ${items.length} items written to ${output} (${skipped} skipped: no https media URL)`);

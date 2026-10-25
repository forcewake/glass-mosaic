/**
 * Build step: catalog.json -> search-index.json (BM25F inverted index).
 * No network access and no models: pure text processing over the captions.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeCatalog } from '../src/media/catalog';
import { buildIndex } from '../src/search/indexer';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalogPath = `${root}public/data/catalog.json`;
const indexPath = `${root}public/data/search-index.json`;

const started = performance.now();
const items = normalizeCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')));
const index = buildIndex(items);
const json = JSON.stringify(index);
writeFileSync(indexPath, json);
const postings = index.postings.reduce((sum, list) => sum + list.length / 2, 0);
console.log(
  `[index] ${items.length} docs, ${index.terms.length} terms, ${postings} postings, ` +
    `${(json.length / 1024).toFixed(0)} KiB in ${(performance.now() - started).toFixed(0)} ms -> ${indexPath}`,
);

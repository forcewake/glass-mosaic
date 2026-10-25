#!/usr/bin/env node
/**
 * Builds `public/data/catalog.json` from the public Wikimedia Commons API.
 *
 * Why Commons: the original embed-anything catalog was extracted from the
 * deployed bundle of a third-party Hugging Face Space (reverse engineering).
 * Glass Mosaic does not depend on that bundle. Every item here comes from a
 * documented public API, carries its own license and attribution, and is served
 * from upload/thumb.wikimedia.org, which send `Access-Control-Allow-Origin: *`
 * (required to use the bitmaps as WebGL textures).
 *
 * The script is run rarely (the generated catalog is committed). It needs the
 * network and, for audio waveforms, `ffmpeg` on PATH (without it, audio items
 * are skipped).
 *
 * Usage: node scripts/build-catalog.mjs [--images-per-topic 16] [--out public/data/catalog.json]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const OUT = resolve(root, arg('--out', 'public/data/catalog.json'));
const IMAGES_PER_TOPIC = Number(arg('--images-per-topic', '16'));
const VIDEOS_PER_TOPIC = Number(arg('--videos-per-topic', '4'));
const AUDIO_PER_TOPIC = Number(arg('--audio-per-topic', '4'));
const API = 'https://commons.wikimedia.org/w/api.php';
const UA = 'GlassMosaicCatalogBuilder/1.0 (https://github.com/forcewake; build-time only)';
const THUMB = 330; // a standard Commons thumbnail step; plenty for a ~200 px card on a 600 px display
const LARGE = 960; // viewer size

const IMAGE_TOPICS = [
  ['Mountains', 'mountain'], ['Lakes', 'lake'], ['Ocean', 'ocean'], ['Beaches', 'beach'],
  ['Forests', 'forest'], ['Deserts', 'desert'], ['Snow', 'snow winter landscape'], ['Waterfalls', 'waterfall'],
  ['Rivers', 'river'], ['Islands', 'island'], ['Volcanoes', 'volcano'], ['Caves', 'cave'],
  ['Cities', 'city skyline'], ['Streets', 'street'], ['Bridges', 'bridge'], ['Architecture', 'church interior'],
  ['Castles', 'castle'], ['Night', 'night'], ['Sky', 'clouds sky'], ['Sunsets', 'sunset'],
  ['Flowers', 'flower'], ['Trees', 'tree'], ['Insects', 'butterfly'], ['Birds', 'bird'],
  ['Mammals', 'fox'], ['Cats', 'cat'], ['Dogs', 'dog'], ['Horses', 'horse'],
  ['Underwater', 'fish underwater'], ['Food', 'food dish'], ['Fruit', 'fruit'], ['Trains', 'train'],
  ['Boats', 'boat'], ['Cars', 'car'], ['Aircraft', 'aircraft'], ['Space', 'nebula'],
  ['Moon', 'moon'], ['Music', 'musical instrument'], ['Sports', 'sport'], ['Markets', 'market'],
];
const VIDEO_TOPICS = [
  ['Ocean', 'ocean waves'], ['Waterfalls', 'waterfall'], ['Rivers', 'river'], ['Clouds', 'clouds timelapse'],
  ['Cities', 'city traffic'], ['Birds', 'bird'], ['Animals', 'animal'], ['Fire', 'fire'],
  ['Rain', 'rain'], ['Snow', 'snow'], ['Trains', 'train'], ['Space', 'earth from space'],
  ['Flowers', 'flower'], ['Insects', 'insect'],
];
const AUDIO_TOPICS = [
  ['Birdsong', 'bird song'], ['Rain', 'rain'], ['Thunder', 'thunder'], ['Ocean', 'sea waves'],
  ['Wind', 'wind'], ['Rivers', 'stream water'], ['Piano', 'piano'], ['Guitar', 'guitar'],
  ['Violin', 'violin'], ['Drums', 'drum'], ['Frogs', 'frog'], ['Owls', 'owl'],
  ['Bells', 'bells'], ['Trains', 'train'], ['Cities', 'street ambience'], ['Whales', 'whale'],
  ['Wolves', 'wolf howl'], ['Insects', 'cricket'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(`Commons API failed: ${url}`);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function stripHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
const clean = (url) => (url ? url.split('?')[0] : null);

const CATEGORY_NOISE =
  /(self-published|own work|photographs taken|photos by|taken with|cc-|cc by|gfdl|pd-|license|quality images|featured pictures|valued images|pictures of the day|media needing|files (by|from|with|uploaded)|uploaded|wiki loves|panoramio|flickr|images with|videos (by|from)|audio files|ogg|webm|categories|\d{4}|lossless|stub|user:|template|location|exif|supported by|commons|wikidata|meta)/i;
export function tagsFrom(categories = '') {
  const seen = new Set();
  const tags = [];
  for (const raw of String(categories).split('|')) {
    const t = raw.replace(/_/g, ' ').trim();
    if (!t || t.length > 48 || CATEGORY_NOISE.test(t)) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(key);
    if (tags.length >= 8) break;
  }
  return tags;
}

function titleFrom(page, meta) {
  const object = stripHtml(meta.ObjectName?.value ?? '');
  const file = page.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
  return cap((object || file).replace(/\s*\((?:cropped|edited)\)\s*/gi, ' ').trim(), 90);
}

function base(page, info, type, topic) {
  const meta = info.extmetadata ?? {};
  return {
    id: `wm-${page.pageid}`,
    type,
    title: titleFrom(page, meta),
    description: cap(stripHtml(meta.ImageDescription?.value ?? ''), 260),
    topic,
    tags: tagsFrom(meta.Categories?.value),
    license: stripHtml(meta.LicenseShortName?.value ?? '') || 'See source page',
    licenseUrl: meta.LicenseUrl?.value ?? null,
    artist: cap(stripHtml(meta.Artist?.value ?? ''), 80) || 'Unknown',
    page: info.descriptionurl,
  };
}

async function search(query, kind, limit, offset = 0) {
  const prop = kind === 'image' ? 'imageinfo' : 'videoinfo';
  const p = kind === 'image' ? 'ii' : 'vi';
  const data = await api({
    action: 'query',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: query,
    gsrlimit: String(limit),
    gsroffset: String(offset),
    prop,
    [`${p}prop`]: kind === 'image' ? 'url|size|mime|extmetadata' : 'url|size|mime|extmetadata|derivatives',
    [`${p}urlwidth`]: String(THUMB),
    [`${p}extmetadatafilter`]: 'ImageDescription|LicenseShortName|LicenseUrl|Artist|ObjectName|Categories',
    [`${p}extmetadatalanguage`]: 'en',
  });
  const pages = data.query?.pages ?? [];
  return pages.sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((page) => ({ page, info: page[prop]?.[0] }));
}

const seen = new Set();
const items = [];

async function collectImages() {
  for (const [topic, q] of IMAGE_TOPICS) {
    let got = 0;
    for (const scope of ['incategory:Quality_images', 'incategory:Featured_pictures_on_Wikimedia_Commons', '']) {
      if (got >= IMAGES_PER_TOPIC) break;
      const results = await search(`${q} filetype:bitmap ${scope}`.trim(), 'image', 40);
      for (const { page, info } of results) {
        if (got >= IMAGES_PER_TOPIC) break;
        if (!info || seen.has(page.pageid) || !/image\/(jpeg|png)/.test(info.mime)) continue;
        const aspect = info.width / info.height;
        if (!(aspect > 0.45 && aspect < 2.4) || !info.thumburl) continue;
        const thumb = clean(info.thumburl);
        const large = info.width > LARGE ? thumb.replace(`/${THUMB}px-`, `/${LARGE}px-`) : clean(info.url);
        seen.add(page.pageid);
        items.push({ ...base(page, info, 'image', topic), aspectRatio: +aspect.toFixed(4), thumb, src: large });
        got++;
      }
      await sleep(250);
    }
    console.log(`[catalog] image ${topic.padEnd(12)} ${got}`);
  }
}

/** WebM only (VP9 preferred, then VP8): Chromium cannot play the MPEG-4 Part 2 `.mov` transcodes. */
export function pickDerivatives(info) {
  const list = (info.derivatives ?? []).filter((d) => d.transcodekey && /^video\/webm/.test(d.type));
  const find = (h) =>
    list.find((d) => d.transcodekey.startsWith(`${h}p.vp9`)) ?? list.find((d) => d.transcodekey.startsWith(`${h}p.`));
  const src = find(360) ?? find(480) ?? find(240);
  const preview = find(240) ?? find(360) ?? src;
  return src ? { src, preview } : null;
}

async function collectVideos() {
  for (const [topic, q] of VIDEO_TOPICS) {
    let got = 0;
    const results = await search(`${q} filetype:video`, 'video', 30);
    for (const { page, info } of results) {
      if (got >= VIDEOS_PER_TOPIC) break;
      if (!info || seen.has(page.pageid) || !info.thumburl) continue;
      const duration = Number(info.duration ?? 0);
      if (!(duration >= 3 && duration <= 240) || !info.width || !info.height) continue;
      const derivative = pickDerivatives(info);
      if (!derivative) continue;
      const aspect = info.width / info.height;
      if (!(aspect > 0.5 && aspect < 2.4)) continue;
      seen.add(page.pageid);
      items.push({
        ...base(page, info, 'video', topic),
        aspectRatio: +aspect.toFixed(4),
        thumb: clean(info.thumburl),
        poster: clean(info.thumburl),
        src: clean(derivative.src.src),
        preview: clean(derivative.preview.src),
        mime: derivative.src.type,
        durationSeconds: +duration.toFixed(1),
      });
      got++;
    }
    console.log(`[catalog] video ${topic.padEnd(12)} ${got}`);
    await sleep(250);
  }
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
/**
 * Loudness waveform (64 bars, 0..1) decoded with ffmpeg at 4 kHz mono, first
 * 90 s. Each bar is the 95th percentile of |sample| in its bucket and the
 * bars are normalised by their own 90th percentile, so a single click or an
 * encoder pop at the end of a file cannot flatten the rest of the shape.
 */
function waveformOf(url) {
  if (!hasFfmpeg) return null;
  const run = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-user_agent', UA, '-t', '90', '-i', url, '-ac', '1', '-ar', '4000', '-f', 's16le', '-'],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  if (run.status !== 0 || !run.stdout?.length) return null;
  const samples = new Int16Array(run.stdout.buffer, run.stdout.byteOffset, Math.floor(run.stdout.length / 2));
  return waveformFromSamples(samples);
}

function waveformFromSamples(samples, bars = 64) {
  const size = Math.max(1, Math.floor(samples.length / bars));
  const levels = [];
  for (let b = 0; b < bars; b++) {
    const bucket = [];
    for (let i = b * size; i < Math.min(samples.length, (b + 1) * size); i++) bucket.push(Math.abs(samples[i]));
    bucket.sort((x, y) => x - y);
    levels.push(bucket.length ? bucket[Math.floor(bucket.length * 0.95)] / 32768 : 0);
  }
  const sorted = [...levels].sort((x, y) => x - y);
  const reference = Math.max(sorted[Math.floor(sorted.length * 0.9)], 1e-6);
  return levels.map((v) => +Math.min(1, Math.max(0.04, (v / reference) * 0.9)).toFixed(3));
}

function pickAudio(info) {
  const list = info.derivatives ?? [];
  const mp3 = list.find((d) => /mpeg|mp3/.test(d.type));
  const ogg = list.find((d) => /ogg|opus|vorbis/.test(d.type));
  return mp3 ?? ogg ?? list[0] ?? { src: info.url, type: info.mime };
}

async function collectAudio() {
  for (const [topic, q] of AUDIO_TOPICS) {
    let got = 0;
    const results = await search(`${q} filetype:audio`, 'audio', 30);
    for (const { page, info } of results) {
      if (got >= AUDIO_PER_TOPIC) break;
      if (!info || seen.has(page.pageid)) continue;
      const duration = Number(info.duration ?? 0);
      if (!(duration >= 2 && duration <= 300) || /midi/.test(info.mime)) continue;
      const derivative = pickAudio(info);
      const src = clean(derivative.src);
      if (!src) continue;
      const waveform = waveformOf(src);
      if (!waveform) continue;
      seen.add(page.pageid);
      items.push({
        ...base(page, info, 'audio', topic),
        aspectRatio: 1.5,
        src,
        mime: derivative.type,
        durationSeconds: +duration.toFixed(1),
        waveform,
      });
      got++;
    }
    console.log(`[catalog] audio ${topic.padEnd(12)} ${got}`);
    await sleep(250);
  }
}

await collectImages();
await collectVideos();
await collectAudio();

const counts = items.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] ?? 0) + 1 }), {});
const catalog = {
  version: 1,
  source: 'Wikimedia Commons (https://commons.wikimedia.org) via the public MediaWiki API',
  generatedAt: new Date().toISOString(),
  notice:
    'Each item keeps its own license, author and source page. Media are hotlinked from Wikimedia servers, not redistributed.',
  counts,
  items,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(catalog)}\n`);
console.log(`[catalog] wrote ${OUT}: ${items.length} items ${JSON.stringify(counts)}`);

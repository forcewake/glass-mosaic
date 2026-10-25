/**
 * Catalog loading and normalization.
 *
 * Every item is validated before it reaches the renderer: unknown types,
 * non-HTTPS media URLs and broken aspect ratios are dropped or repaired, so a
 * hand-edited or regenerated catalog can never crash the field.
 */
import type { Catalog, MediaItem, MediaType } from './types';
import { seededShuffle } from './shuffle';

const TYPES: ReadonlySet<string> = new Set<MediaType>(['image', 'video', 'audio']);

const isHttps = (value: unknown): value is string => typeof value === 'string' && /^https:\/\//.test(value);
const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Formats a duration in seconds as `m:ss` (or `h:mm:ss`). Ported verbatim. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, '0');
  return minutes < 60
    ? `${minutes}:${rest}`
    : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`;
}

/** Validates and repairs one raw catalog entry. Returns `null` when unusable. */
export function normalizeItem(raw: unknown): MediaItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (typeof type !== 'string' || !TYPES.has(type) || typeof r.id !== 'string' || !r.id) return null;
  if (!isHttps(r.src)) return null;
  if (type !== 'audio' && !isHttps(r.thumb) && !isHttps(r.poster)) return null;
  const ratio = Number(r.aspectRatio);
  const aspectRatio = Number.isFinite(ratio) && ratio > 0.2 && ratio < 5 ? ratio : type === 'video' ? 16 / 9 : 3 / 2;
  const item: MediaItem = {
    id: r.id,
    type: type as MediaType,
    title: text(r.title, 120) || (type === 'audio' ? 'Untitled sound' : type === 'video' ? 'Untitled video' : 'Untitled photo'),
    description: text(r.description, 400),
    topic: text(r.topic, 40),
    tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase().slice(0, 60)).slice(0, 12) : [],
    aspectRatio,
    src: r.src,
    license: text(r.license, 60) || 'See source page',
    licenseUrl: isHttps(r.licenseUrl) || (typeof r.licenseUrl === 'string' && /^http:\/\//.test(r.licenseUrl)) ? (r.licenseUrl as string) : null,
    artist: text(r.artist, 100) || 'Unknown',
    page: isHttps(r.page) ? r.page : '',
  };
  if (isHttps(r.thumb)) item.thumb = r.thumb;
  if (isHttps(r.poster)) item.poster = r.poster;
  if (isHttps(r.preview)) item.preview = r.preview;
  if (typeof r.mime === 'string') item.mime = r.mime;
  const duration = Number(r.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) item.durationSeconds = duration;
  if (Array.isArray(r.waveform)) {
    item.waveform = r.waveform.map(Number).filter(Number.isFinite).map((v) => Math.max(0, Math.min(1, v)));
  }
  if (item.type === 'video' && !item.thumb && item.poster) item.thumb = item.poster;
  return item;
}

/** Normalizes a parsed catalog file and drops duplicates. */
export function normalizeCatalog(raw: unknown): MediaItem[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as Catalog).items) ? (raw as Catalog).items : [];
  const seen = new Set<string>();
  const out: MediaItem[] = [];
  for (const entry of list) {
    const item = normalizeItem(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Downloads and normalizes the catalog shipped next to the app. */
export async function loadCatalog(url: URL, signal?: AbortSignal): Promise<MediaItem[]> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The catalog could not be loaded (${response.status}).`);
  return normalizeCatalog(await response.json());
}

/** The initial display order: a seeded (reproducible) shuffle. */
export function displayOrder(items: readonly MediaItem[], seed: number): MediaItem[] {
  return seededShuffle(items, seed);
}

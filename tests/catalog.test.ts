import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { displayOrder, formatDuration, normalizeCatalog, normalizeItem } from '../src/media/catalog';
import { downsampleWaveform } from '../src/media/audio';

describe('catalog normalization', () => {
  it('accepts a complete item and keeps optional fields', () => {
    const item = normalizeItem({
      id: 'a', type: 'audio', title: ' Rain ', src: 'https://upload.wikimedia.org/a.mp3',
      license: 'CC0', artist: 'X', page: 'https://commons.wikimedia.org/wiki/File:A', durationSeconds: 22.4,
      waveform: [0.2, 3, -1, 'x'], tags: ['Weather', 4],
    });
    expect(item).toMatchObject({ id: 'a', type: 'audio', title: 'Rain', durationSeconds: 22.4, tags: ['weather'] });
    expect(item?.waveform).toEqual([0.2, 1, 0]);
  });

  it('rejects unusable items', () => {
    expect(normalizeItem(null)).toBeNull();
    expect(normalizeItem({ id: 'x', type: 'model', src: 'https://a/b' })).toBeNull();
    expect(normalizeItem({ id: 'x', type: 'image', src: 'http://insecure/b.jpg', thumb: 'https://a/t.jpg' })).toBeNull();
    expect(normalizeItem({ id: 'x', type: 'image', src: 'https://a/b.jpg' })).toBeNull();
  });

  it('repairs aspect ratios and fills defaults', () => {
    const video = normalizeItem({ id: 'v', type: 'video', src: 'https://a/v.webm', poster: 'https://a/p.jpg', aspectRatio: 99 });
    expect(video?.aspectRatio).toBeCloseTo(16 / 9);
    expect(video?.thumb).toBe('https://a/p.jpg');
    expect(video?.title).toBe('Untitled video');
    expect(video?.license).toBe('See source page');
  });

  it('drops duplicates and tolerates a malformed file', () => {
    const entry = { id: 'i', type: 'image', src: 'https://a/i.jpg', thumb: 'https://a/t.jpg' };
    expect(normalizeCatalog({ items: [entry, entry] })).toHaveLength(1);
    expect(normalizeCatalog('nope')).toEqual([]);
  });

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(128.9)).toBe('2:08');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('downsamples waveforms by bucket peak', () => {
    expect(downsampleWaveform([0.1, 0.5, 0.2, 0.9], 2)).toEqual([0.5, 0.9]);
    expect(downsampleWaveform([0.1, 0.2], 10)).toEqual([0.1, 0.2]);
  });
});

describe('shipped catalog', () => {
  const raw = JSON.parse(readFileSync(new URL('../public/data/catalog.json', import.meta.url), 'utf8'));
  const items = normalizeCatalog(raw);

  it('is complete, mixed-media, https-only and attributed', () => {
    expect(items.length).toBe(raw.items.length);
    const types = new Set(items.map((i) => i.type));
    expect([...types].sort()).toEqual(['audio', 'image', 'video']);
    for (const item of items) {
      expect(item.src.startsWith('https://')).toBe(true);
      expect(item.license).not.toBe('');
      expect(item.page).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
    }
  });

  it('only ships WebM video (playable in Chromium) and waveforms for audio', () => {
    for (const item of items.filter((i) => i.type === 'video')) expect(item.src).toMatch(/\.webm$/);
    for (const item of items.filter((i) => i.type === 'audio')) expect(item.waveform?.length).toBeGreaterThan(8);
  });

  it('does not reference any model or embedding asset', () => {
    const text = JSON.stringify(raw);
    expect(text).not.toMatch(/huggingface|\.onnx|embeddinggemma|\.f16/i);
  });

  it('has a stable seeded display order', () => {
    expect(displayOrder(items, 7).map((i) => i.id)).toEqual(displayOrder(items, 7).map((i) => i.id));
    expect(displayOrder(items, 7)).toHaveLength(items.length);
  });
});

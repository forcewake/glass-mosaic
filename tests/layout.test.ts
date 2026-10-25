import { describe, expect, it } from 'vitest';
import { computeMosaicLayout, computeResultLayout } from '../src/engine/AspectMosaicLayout';
import { pickNeighbor, type Instance } from '../src/engine/GlassField';
import { SpatialIndex, rectsOverlap } from '../src/engine/SpatialIndex';
import { item } from './fixtures';

const items = Array.from({ length: 40 }, (_, i) => item({ id: `i${i}`, aspectRatio: [1.5, 0.75, 1, 16 / 9][i % 4] }));

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w - 0.5 && Math.abs(a.y - b.y) * 2 < a.h + b.h - 0.5;

describe('layout', () => {
  it('places every item without overlaps', () => {
    for (const layout of [computeMosaicLayout(items), computeResultLayout(items.slice(0, 17))]) {
      for (let a = 0; a < layout.items.length; a++) {
        for (let b = a + 1; b < layout.items.length; b++) expect(overlaps(layout.items[a], layout.items[b])).toBe(false);
      }
    }
    expect(computeMosaicLayout(items).items).toHaveLength(40);
  });

  it('puts the best result in the middle of the spiral', () => {
    const layout = computeResultLayout(items.slice(0, 25));
    const dist = (i: number) => Math.hypot(layout.items[i].x, layout.items[i].y);
    const closest = layout.items.map((_, i) => i).sort((a, b) => dist(a) - dist(b))[0];
    expect(dist(0)).toBeLessThanOrEqual(dist(closest) + layout.gap + layout.items[0].w / 2);
    expect(dist(0)).toBeLessThan(dist(24));
  });

  it('handles an empty result list', () => {
    expect(computeResultLayout([]).items).toEqual([]);
  });
});

describe('spatial index', () => {
  it('returns exactly the cards that intersect a viewport', () => {
    const layout = computeMosaicLayout(items);
    const index = new SpatialIndex(layout.items);
    const view = { left: -300, right: 300, top: -300, bottom: 300 };
    const expected = layout.items
      .map((it, rank) => ({ it, rank }))
      .filter(({ it }) => rectsOverlap(view, { left: it.x - it.w / 2, right: it.x + it.w / 2, top: it.y - it.h / 2, bottom: it.y + it.h / 2 }))
      .map(({ rank }) => rank)
      .sort((a, b) => a - b);
    expect([...index.query(view)].sort((a, b) => a - b)).toEqual(expected);
  });
});

describe('arrow-key neighbours', () => {
  // A 3x3 grid with a staggered middle row.
  const grid: Instance[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      grid.push({ key: `${r}${c}`, item: items[0], x: c * 120 + (r === 1 ? 40 : 0), y: r * 90, w: 110, h: 80, rank: r * 3 + c });
    }
  }
  const at = (key: string) => grid.find((g) => g.key === key)!;
  const go = (key: string, dir: 'left' | 'right' | 'up' | 'down') => pickNeighbor(at(key), grid.filter((g) => g.key !== key), dir)?.key ?? null;

  it('moves along a row', () => {
    expect(go('11', 'right')).toBe('12');
    expect(go('11', 'left')).toBe('10');
    expect(go('12', 'right')).toBeNull();
  });

  it('moves between rows to the horizontally closest card', () => {
    expect(go('11', 'up')).toBe('01');
    expect(go('00', 'down')).toBe('10');
    expect(go('22', 'down')).toBeNull();
    expect(go('01', 'up')).toBeNull();
  });
});

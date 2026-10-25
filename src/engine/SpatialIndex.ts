/**
 * A spatial index over the laid-out cards.
 *
 * Port of the recovered `ut` class: the cards are sorted by their top edge and
 * queried with a viewport rectangle, so only the visible cards are considered.
 * With 5,543 items this keeps the per-frame work proportional to what is on
 * screen rather than to the size of the catalog.
 */
import type { LayoutItem } from './AspectMosaicLayout';

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface IndexedEntry extends Rect {
  /** Index of the card in the layout's item list. */
  rank: number;
}

/** True when two rectangles overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export class SpatialIndex {
  private entries: IndexedEntry[];
  private maxHeight = 0;
  private bounds: Rect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };

  constructor(items: readonly LayoutItem[]) {
    this.entries = items
      .map((item, rank) => {
        const entry: IndexedEntry = {
          left: item.x - item.w / 2,
          right: item.x + item.w / 2,
          top: item.y - item.h / 2,
          bottom: item.y + item.h / 2,
          rank,
        };
        this.maxHeight = Math.max(this.maxHeight, item.h);
        this.bounds.left = Math.min(this.bounds.left, entry.left);
        this.bounds.right = Math.max(this.bounds.right, entry.right);
        this.bounds.top = Math.min(this.bounds.top, entry.top);
        this.bounds.bottom = Math.max(this.bounds.bottom, entry.bottom);
        return entry;
      })
      .sort((a, b) => a.top - b.top);
  }

  /** The indices of the cards that intersect `viewport`, in layout order. */
  query(viewport: Rect): number[] {
    if (!this.entries.length || !rectsOverlap(viewport, this.bounds)) return [];
    const top = viewport.top - this.maxHeight;
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.entries[mid].top < top) low = mid + 1;
      else high = mid;
    }
    const result: number[] = [];
    for (let i = low; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.top > viewport.bottom) break;
      if (rectsOverlap(entry, viewport)) result.push(entry.rank);
    }
    return result.sort((a, b) => a - b);
  }
}

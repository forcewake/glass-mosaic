/**
 * The aspect-ratio aware row layout of the mosaic.
 *
 * Two algorithms are ported from the recovered renderer:
 *   `ct` -> computeMosaicLayout: the initial (shuffled) arrangement,
 *   `St` -> computeResultLayout: the spiral arrangement used for search hits.
 *
 * The layout is a *row* layout, not a scatter plot: items are packed into rows
 * whose height is derived from their aspect ratio, and alternate rows are
 * staggered by half a row width.
 */
import type { MediaItem } from '../media/types';

/** The gap between two cards, in layout units. */
export const GAP = 29.52;

/** The reference card width; the layout is expressed in these units. */
export const CARD_WIDTH = 492;

/** The gap as a fraction of the card width. */
const GAP_RATIO = GAP / CARD_WIDTH;

export interface LayoutItem {
  id: string;
  item: MediaItem;
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
}

export interface MosaicLayout {
  items: LayoutItem[];
  width: number;
  height: number;
  gap: number;
  rows: number;
  columns: number;
}

interface Row {
  start: number;
  end: number;
  h: number;
}

/** The aspect ratio of an item, with the reference fallback. */
export function aspectOf(item: MediaItem): number {
  const ratio = item.aspectRatio;
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : 4 / 3;
}

/**
 * Packs the items into aspect-ratio aware rows.
 *
 * @param items The items to lay out.
 * @param columns Optional fixed column count (the reference derives it).
 */
export function computeMosaicLayout(items: readonly MediaItem[], columns?: number): MosaicLayout {
  const count = items.length;
  const aspects = items.map(aspectOf);
  const adjusted = aspects.map((aspect) => aspect + GAP_RATIO);
  const total = adjusted.reduce((sum, value) => sum + value, 0);
  const average = count ? total / count : 4 / 3;
  const derivedColumns = Math.ceil(Math.sqrt((count * 1.06) / average));
  const columnCount = Math.max(1, Math.min(count || 1, Math.floor(columns ?? derivedColumns) || 1));
  const rowCount = Math.max(1, Math.ceil(count / columnCount));

  if (!count) {
    return { items: [], width: 685.52, height: 521.52, gap: GAP, rows: rowCount, columns: columnCount };
  }

  let width = (CARD_WIDTH * total) / rowCount;
  const rows: Row[] = [];
  let start = 0;
  let remaining = total;

  for (let row = 0; row < rowCount; row++) {
    const rowsLeft = rowCount - row;
    let end = count;
    if (rowsLeft > 1) {
      const target = remaining / rowsLeft;
      const limit = count - rowsLeft + 1;
      end = start + 1;
      let running = adjusted[start];
      while (end < limit && Math.abs(running + adjusted[end] - target) < Math.abs(running - target)) {
        running += adjusted[end];
        end++;
      }
    }
    // The row height is derived from the *raw* aspect ratios; the gap padding
    // only participates in the total that sets the layout width.
    const rowTotal = aspects.slice(start, end).reduce((sum, value) => sum + value, 0);
    const height = (width - GAP * (end - start)) / rowTotal;
    rows.push({ start, end, h: height });
    for (let i = start; i < end; i++) remaining -= adjusted[i];
    start = end;
  }

  // Guard against rows that would collapse to a non-positive height.
  if (rows.some((row) => row.h <= 0)) {
    width = Math.max(
      width,
      GAP * Math.max(...rows.map((row) => row.end - row.start)) + CARD_WIDTH * Math.min(...aspects),
    );
    for (const row of rows) {
      const rowTotal = aspects.slice(row.start, row.end).reduce((sum, value) => sum + value, 0);
      row.h = (width - GAP * (row.end - row.start)) / rowTotal;
    }
  }

  const height = rows.reduce((sum, row) => sum + row.h + GAP, 0);
  const laidOut: LayoutItem[] = [];
  let y = -height / 2 + GAP / 2;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    let x = -width / 2 + GAP / 2;
    const stagger = index % 2 ? width / (row.end - row.start) / 2 : 0;
    for (let i = row.start; i < row.end; i++) {
      const w = row.h * aspects[i];
      const wrapped = ((((x + w / 2 + stagger + width / 2) % width) + width) % width) - width / 2;
      laidOut.push({
        id: items[i].id,
        item: items[i],
        x: wrapped,
        y: y + row.h / 2,
        w,
        h: row.h,
        row: index,
      });
      x += w + GAP;
    }
    y += row.h + GAP;
  }

  return { items: laidOut, width, height, gap: GAP, rows: rowCount, columns: columnCount };
}

/**
 * Lays the search hits out in a centred spiral.
 *
 * The rows are filled from the centre outwards so the best match sits in the
 * middle of the viewport.
 */
export function computeResultLayout(items: readonly MediaItem[]): MosaicLayout {
  const base = computeMosaicLayout(items, Math.ceil(Math.sqrt(items.length)));
  if (!base.items.length) return base;

  const centreRow = Math.floor(base.rows / 2);
  const perRow = Array(base.rows).fill(Math.floor(items.length / base.rows));
  const rowOrder = perRow
    .map((_, index) => index)
    .sort((a, b) => Math.abs(a - centreRow) - Math.abs(b - centreRow) || a - b);
  for (const row of rowOrder.slice(0, items.length % base.rows)) perRow[row]++;

  const grid = perRow.map((count) => Array(count).fill(-1));
  let rowOffset = 0;
  let columnOffset = 0;
  let next = 0;
  let direction = 0;
  let radius = 1;
  const steps = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];

  const fill = () => {
    const row = grid[columnOffset + centreRow];
    if (!row) return;
    const index = rowOffset + Math.floor(row.length / 2);
    if (index >= 0 && index < row.length) row[index] = next++;
  };

  for (fill(); next < items.length;) {
    for (let turn = 0; turn < 2; turn++) {
      for (let step = 0; step < radius; step++) {
        rowOffset += steps[direction][0];
        columnOffset += steps[direction][1];
        fill();
      }
      direction = (direction + 1) % steps.length;
    }
    radius++;
  }

  const ratios = base.items.map((item) => item.w / item.h);
  const width = Math.max(base.width, base.gap * Math.max(...perRow) + Math.min(...base.items.map((item) => item.w)));
  const rowHeights = grid.map((row) => {
    const sum = row.reduce((total, index) => total + (index >= 0 ? ratios[index] : 0), 0);
    return sum ? (width - base.gap * row.length) / sum : 0;
  });
  const height = rowHeights.reduce((sum, value) => sum + value + base.gap, 0);
  const placed = new Array<LayoutItem>(items.length);
  let y = -height / 2 + base.gap / 2;

  for (const [rowIndex, row] of grid.entries()) {
    const rowHeight = rowHeights[rowIndex];
    let x = -width / 2 + base.gap / 2;
    for (const itemIndex of row) {
      if (itemIndex < 0) continue;
      const w = rowHeight * ratios[itemIndex];
      placed[itemIndex] = {
        ...base.items[itemIndex],
        x: x + w / 2,
        y: y + rowHeight / 2,
        w,
        h: rowHeight,
        row: rowIndex,
      };
      x += w + base.gap;
    }
    y += rowHeight + base.gap;
  }

  const originX = placed[0].x;
  const originY = placed[0].y;
  const wrap = (value: number, size: number) => value - Math.round(value / size) * size;
  const spiral = placed
    .map((item, spiralOrder) => ({
      ...item,
      x: wrap(item.x - originX, width),
      y: wrap(item.y - originY, height),
      spiralOrder,
    }))
    .sort((a, b) => a.x * a.x + a.y * a.y - (b.x * b.x + b.y * b.y) || a.spiralOrder - b.spiralOrder);

  return {
    ...base,
    items: spiral.map(({ spiralOrder: _spiralOrder, ...item }, index) => ({
      ...item,
      id: items[index].id,
      item: items[index],
    })),
    width,
    height,
  };
}

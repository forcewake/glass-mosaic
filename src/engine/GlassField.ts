/**
 * The glass field: an endless liquid-glass mosaic driven by arrow keys.
 *
 * A glasses-first re-write of embed-anything's `SpatialField` (MIT). It keeps
 * the original pieces — the aspect-ratio row layout with its wrap-around
 * tiling, the spiral result layout, the spatial index, the spherical card
 * placement and the WebGL2 glass renderer — and replaces pointer, wheel,
 * pinch and orbit handling with a focus model made for a D-pad:
 *
 *   - every visible card is a real `<button>` positioned over the canvas, so
 *     focus, `:focus-visible`, Enter-to-activate and screen readers just work;
 *   - Arrow keys move focus to the geometric neighbour and the camera pans to
 *     keep the focused card in the middle; when a key has nowhere to go
 *     upwards the field hands focus back to the search box (`onExitUp`);
 *   - rendering is on demand: no frame is drawn while nothing moves.
 */
import { computeMosaicLayout, computeResultLayout, type MosaicLayout, type LayoutItem } from './AspectMosaicLayout';
import { SpatialIndex, type Rect } from './SpatialIndex';
import { cardShape, clamp, orbitMatrix, projectToScreen, smootherstep, spherePlacement, type CameraState } from './geometry';
import { GlassRenderer, type RendererCard } from './GlassRenderer';
import type { MediaPool } from './MediaPool';
import { stillUrl } from './MediaPool';
import type { MediaItem } from '../media/types';
import { TYPE_LABEL } from '../media/types';
import { formatDuration } from '../media/catalog';
import { paintWaveform } from '../media/waveform';

export type Direction = 'left' | 'right' | 'up' | 'down';
export type FieldMode = 'browse' | 'results';

export interface FieldHit {
  item: MediaItem;
  relevance: number;
}

/** One placed card, in layout units, including its tile offset. */
export interface Instance {
  key: string;
  item: MediaItem;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Order in the layout (= rank in results mode). */
  rank: number;
  relevance?: number;
}

export interface FieldOptions {
  items: MediaItem[];
  pool: MediaPool;
  render: 'webgl' | 'dom';
  reduced: boolean;
  /** Height in CSS px covered by the toolbar at the top. */
  topInset: () => number;
  onOpen: (instance: Instance) => void;
  onExitUp: () => void;
  /** Down with no card below (only happens at the bottom of the finite results spiral). */
  onExitDown?: () => void;
  onFocusChange?: (instance: Instance | null) => void;
  /** Called once if frames are consistently slow, so the app can degrade. */
  onSlow?: () => void;
}

interface Node {
  button: HTMLButtonElement;
  instance: Instance;
  media?: HTMLImageElement | HTMLCanvasElement;
}

interface Visible {
  instance: Instance;
  /** Screen-space rect, CSS px. */
  left: number;
  top: number;
  width: number;
  height: number;
  card: RendererCard;
}

/** Visible card rows per viewport height. */
const ROWS_VISIBLE = { browse: 3.4, results: 2.9 } as const;
/** Visual size of a card relative to its layout slot (widens the gaps). */
const CARD_FILL = 0.94;
/** Maximum number of focusable card buttons in the DOM at once. */
const MAX_NODES = 48;
const ENTRANCE_MS = 340;

export class GlassField {
  readonly element: HTMLDivElement;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: GlassRenderer | null = null;
  private layer: HTMLDivElement;
  private caption: HTMLDivElement;
  private options: FieldOptions;

  private mode: FieldMode = 'browse';
  private browseLayout: MosaicLayout;
  private browseIndex: SpatialIndex;
  private layout: MosaicLayout;
  private index: SpatialIndex;
  private relevance = new Map<string, number>();
  private rowPitch = 500;

  private width = 600;
  private height = 600;
  private scale = 0.4;
  private camera = { x: 0, y: 0 };
  private target = { x: 0, y: 0 };
  private cameraState: CameraState = { perspective: 417, radius: 1736, orbit: orbitMatrix(0, 0), shift: 0 };

  private nodes = new Map<string, Node>();
  private focusKey: string | null = null;
  private focusInstance: Instance | null = null;
  private reframeAt = -Infinity;
  private frame = 0;
  private lastTime = 0;
  private active = true;
  private reduced: boolean;
  private slowFrames = 0;
  private sampledFrames = 0;
  private slowReported = false;
  private resizeObserver: ResizeObserver;
  private disposed = false;

  constructor(host: HTMLElement, options: FieldOptions) {
    this.options = options;
    this.reduced = options.reduced;
    this.element = document.createElement('div');
    this.element.className = 'field';
    this.element.dataset.render = options.render;
    host.append(this.element);

    if (options.render === 'webgl') {
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'field-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
      this.element.append(this.canvas);
      try {
        this.renderer = new GlassRenderer(this.canvas, {
          antialias: !this.reduced,
          onContextLost: () => this.fallbackToDom(),
        });
      } catch {
        this.fallbackToDom();
      }
    }

    this.layer = document.createElement('div');
    this.layer.className = 'card-layer';
    this.layer.setAttribute('role', 'group');
    this.layer.setAttribute('aria-label', 'Mosaic');
    this.element.append(this.layer);

    this.caption = document.createElement('div');
    this.caption.className = 'card-caption';
    this.caption.setAttribute('aria-hidden', 'true');
    this.caption.hidden = true;
    this.element.append(this.caption);

    this.browseLayout = computeMosaicLayout(options.items);
    this.browseIndex = new SpatialIndex(this.browseLayout.items);
    this.layout = this.browseLayout;
    this.index = this.browseIndex;
    this.rowPitch = this.browseLayout.height / Math.max(1, this.browseLayout.rows);

    this.layer.addEventListener('keydown', this.onKeyDown);
    this.layer.addEventListener('click', this.onClick);
    this.layer.addEventListener('focusin', this.onFocusIn);
    this.layer.addEventListener('focusout', () => this.invalidate());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.element);
    this.resize();
    this.resetCamera(true);
    this.invalidate();
  }

  /** `webgl` or `dom`, whichever is actually in use. */
  get renderMode(): 'webgl' | 'dom' {
    return this.renderer ? 'webgl' : 'dom';
  }

  get currentMode(): FieldMode {
    return this.mode;
  }

  get focused(): Instance | null {
    return this.focusInstance;
  }

  // ------------------------------------------------------------------ setup

  private fallbackToDom(): void {
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
    this.element.dataset.render = 'dom';
    for (const node of this.nodes.values()) node.button.remove();
    this.nodes.clear();
    this.invalidate();
  }

  private resize(): void {
    const rect = this.element.getBoundingClientRect();
    this.width = Math.max(1, rect.width || window.innerWidth);
    this.height = Math.max(1, rect.height || window.innerHeight);
    const viewScale = Math.max(this.width, this.height) / 1728;
    this.cameraState = {
      perspective: 1200 * viewScale,
      radius: 5000 * viewScale,
      orbit: orbitMatrix(0, 0),
      shift: 0,
    };
    this.updateScale();
    if (this.renderer) {
      const ratio = Math.min(window.devicePixelRatio || 1, this.reduced ? 1 : 1.5);
      this.renderer.resize(this.width, this.height, ratio);
    }
    if (this.focusInstance) this.centerOn(this.focusInstance, true);
    this.invalidate();
  }

  private updateScale(): void {
    const pitch = this.mode === 'browse' ? this.rowPitch : this.layout.height / Math.max(1, this.layout.rows);
    const usable = this.height - this.options.topInset() * 0.5;
    this.scale = usable / (ROWS_VISIBLE[this.mode] * Math.max(1, pitch));
  }

  setReduced(reduced: boolean): void {
    if (this.reduced === reduced) return;
    this.reduced = reduced;
    this.resize();
  }

  /** Pauses (viewer open, page hidden) or resumes rendering. */
  setActive(active: boolean): void {
    this.active = active;
    if (active) this.invalidate();
  }

  // ------------------------------------------------------------------ modes

  /** The endless browse mosaic. */
  showBrowse(): void {
    const hadFocus = this.layer.contains(document.activeElement);
    this.mode = 'browse';
    this.layout = this.browseLayout;
    this.index = this.browseIndex;
    this.relevance.clear();
    this.updateScale();
    this.clearNodes();
    this.resetCamera(false);
    this.reframeAt = performance.now();
    this.setFocus(null);
    this.invalidate();
    if (hadFocus) this.focusEntry();
  }

  /** Reframes the field into a spiral of hits (best hit in the centre). */
  showResults(hits: readonly FieldHit[]): void {
    const hadFocus = this.layer.contains(document.activeElement);
    this.mode = 'results';
    this.relevance = new Map(hits.map((hit) => [hit.item.id, hit.relevance]));
    this.layout = computeResultLayout(hits.map((hit) => hit.item));
    this.index = new SpatialIndex(this.layout.items);
    this.updateScale();
    this.clearNodes();
    this.resetCamera(false);
    this.reframeAt = performance.now();
    this.setFocus(null);
    this.invalidate();
    if (hadFocus) this.focusEntry();
  }

  private clearNodes(): void {
    for (const node of this.nodes.values()) node.button.remove();
    this.nodes.clear();
  }

  private resetCamera(immediate: boolean): void {
    if (this.mode === 'results') {
      this.target = { x: 0, y: -this.options.topInset() / 2 / this.scale };
    } else {
      this.target = { x: 0, y: this.minCameraY() };
    }
    if (immediate || this.reduced) this.camera = { ...this.target };
  }

  /** Browse mode: the camera may not scroll above the first row. */
  private minCameraY(): number {
    const top = -this.browseLayout.height / 2;
    return top + (this.height / 2 - this.options.topInset() - 10) / this.scale;
  }

  // ------------------------------------------------------------------ geometry

  /** Every instance whose layout rect intersects `rect` (layout units). */
  private instancesIn(rect: Rect): Instance[] {
    const layout = this.layout;
    const out: Instance[] = [];
    const push = (placed: LayoutItem, rank: number, ox: number, oy: number, key: string) => {
      out.push({
        key,
        item: placed.item,
        x: placed.x + ox,
        y: placed.y + oy,
        w: placed.w,
        h: placed.h,
        rank,
        relevance: this.relevance.get(placed.item.id),
      });
    };
    if (this.mode === 'results') {
      for (const rank of this.index.query(rect)) push(layout.items[rank], rank, 0, 0, layout.items[rank].id);
      return out;
    }
    const W = layout.width;
    const H = layout.height;
    const i0 = Math.ceil((rect.left - W / 2) / W);
    const i1 = Math.floor((rect.right + W / 2) / W);
    const j0 = Math.max(0, Math.ceil((rect.top - H / 2) / H));
    const j1 = Math.floor((rect.bottom + H / 2) / H);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const local = { left: rect.left - i * W, right: rect.right - i * W, top: rect.top - j * H, bottom: rect.bottom - j * H };
        for (const rank of this.index.query(local)) {
          const placed = layout.items[rank];
          push(placed, rank, i * W, j * H, `${placed.id}@${i},${j}`);
        }
      }
    }
    return out;
  }

  private viewRect(margin = 0.12): Rect {
    const halfW = (this.width / 2 / this.scale) * (1 + margin);
    const halfH = (this.height / 2 / this.scale) * (1 + margin);
    return { left: this.camera.x - halfW, right: this.camera.x + halfW, top: this.camera.y - halfH, bottom: this.camera.y + halfH };
  }

  /** Picks the neighbour of `from` in direction `dir`, or null. */
  neighbor(from: Instance, dir: Direction): Instance | null {
    const reachX = from.w * 2.5 + this.rowPitch;
    const reachY = this.rowPitch * 2.2 + from.h;
    const candidates = this.instancesIn({
      left: from.x - reachX,
      right: from.x + reachX,
      top: from.y - reachY,
      bottom: from.y + reachY,
    }).filter((c) => c.key !== from.key);
    return pickNeighbor(from, candidates, dir);
  }

  /** The instance closest to the centre of the visible content area. */
  private entryInstance(): Instance | null {
    if (this.mode === 'results') {
      const first = this.layout.items[0];
      return first ? this.instancesIn({ left: first.x - 1, right: first.x + 1, top: first.y - 1, bottom: first.y + 1 }).find((i) => i.rank === 0) ?? null : null;
    }
    const cx = this.target.x;
    const cy = this.target.y + this.options.topInset() / 2 / this.scale;
    const near = this.instancesIn({ left: cx - 600, right: cx + 600, top: cy - 600, bottom: cy + 600 });
    let best: Instance | null = null;
    let bestDistance = Infinity;
    for (const c of near) {
      const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ focus

  /** Focuses the natural entry card (best hit, or the card nearest the centre). */
  focusEntry(): Instance | null {
    const entry = this.entryInstance();
    if (entry) this.focusOn(entry, true);
    return entry;
  }

  /** Toolbar → field: back to the remembered card if it is still in view, else the entry card. */
  restoreFocusOrEntry(): void {
    const remembered = this.focusInstance;
    if (remembered && this.visibleCache.some((v) => v.instance.key === remembered.key)) this.focusOn(remembered, true);
    else this.focusEntry();
  }

  /** Re-focuses the remembered card (e.g. after the viewer closes). */
  restoreFocus(): void {
    if (this.focusInstance) this.focusOn(this.focusInstance, true);
    else this.focusEntry();
  }

  /** Moves focus in a direction. Returns the new instance or null at an edge. */
  move(dir: Direction, focusDom = true): Instance | null {
    const from = this.focusInstance ?? this.entryInstance();
    if (!from) return null;
    const next = this.neighbor(from, dir);
    if (next) this.focusOn(next, focusDom);
    return next;
  }

  /** Results mode: the instance at a given rank. */
  instanceAtRank(rank: number): Instance | null {
    if (this.mode !== 'results') return null;
    const placed = this.layout.items[rank];
    if (!placed) return null;
    return { key: placed.id, item: placed.item, x: placed.x, y: placed.y, w: placed.w, h: placed.h, rank, relevance: this.relevance.get(placed.item.id) };
  }

  get resultCount(): number {
    return this.mode === 'results' ? this.layout.items.length : 0;
  }

  /** Focuses (and pans to) an instance. */
  focusOn(instance: Instance, focusDom: boolean): void {
    this.setFocus(instance);
    this.centerOn(instance, false);
    if (focusDom) {
      const node = this.ensureNode(instance);
      this.positionNodes();
      node.button.focus({ preventScroll: true });
    }
    this.invalidate();
  }

  private setFocus(instance: Instance | null): void {
    const changed = instance?.key !== this.focusInstance?.key;
    this.focusInstance = instance;
    this.focusKey = instance?.key ?? null;
    this.options.pool.setLive(instance && this.active ? instance.item : null);
    if (changed) this.options.onFocusChange?.(instance);
  }

  private centerOn(instance: Instance, immediate: boolean): void {
    const inset = this.options.topInset();
    let y = instance.y - inset / 2 / this.scale;
    if (this.mode === 'browse') y = Math.max(this.minCameraY(), y);
    this.target = { x: instance.x, y };
    if (immediate || this.reduced) this.camera = { ...this.target };
  }

  private onKeyDown = (event: KeyboardEvent) => {
    const dir = KEY_DIRECTIONS[event.key];
    if (!dir || event.altKey || event.ctrlKey || event.metaKey) return;
    const node = this.nodeFor(event.target);
    if (!node) return;
    // A custom 2-D widget: we replace the default spatial navigation for the
    // cards only, and always leave a way out (Up from the top -> search box).
    event.preventDefault();
    if (this.focusKey !== node.instance.key) this.setFocus(node.instance);
    const next = this.move(dir);
    if (!next && dir === 'up') this.options.onExitUp();
    else if (!next && dir === 'down') this.options.onExitDown?.();
  };

  private onClick = (event: MouseEvent) => {
    const node = this.nodeFor(event.target);
    if (!node) return;
    this.setFocus(node.instance);
    this.options.onOpen(node.instance);
  };

  private onFocusIn = (event: FocusEvent) => {
    const node = this.nodeFor(event.target);
    if (node && node.instance.key !== this.focusKey) {
      this.setFocus(node.instance);
      this.centerOn(node.instance, false);
      this.invalidate();
    }
    this.invalidate();
  };

  private nodeFor(target: EventTarget | null): Node | undefined {
    const button = (target as HTMLElement | null)?.closest?.('button.card') as HTMLButtonElement | null;
    return button ? this.nodes.get(button.dataset.key ?? '') : undefined;
  }

  // ------------------------------------------------------------------ DOM nodes

  private ensureNode(instance: Instance): Node {
    let node = this.nodes.get(instance.key);
    if (node) {
      node.instance = instance;
      return node;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card';
    button.dataset.key = instance.key;
    button.dataset.id = instance.item.id;
    button.dataset.type = instance.item.type;
    button.setAttribute('aria-label', describe(instance));
    if (instance.item.type !== 'image') {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = `${instance.item.type === 'video' ? '▶' : '♪'}${instance.item.durationSeconds ? ` ${formatDuration(instance.item.durationSeconds)}` : ''}`;
      button.append(badge);
    }
    node = { button, instance };
    if (!this.renderer) {
      if (instance.item.type === 'audio') {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 240;
        paintWaveform(canvas, instance.item);
        node.media = canvas;
      } else {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        img.src = stillUrl(instance.item) ?? '';
        node.media = img;
      }
      node.media.className = 'card-media';
      button.prepend(node.media);
    }
    this.layer.append(button);
    this.nodes.set(instance.key, node);
    return node;
  }

  // ------------------------------------------------------------------ frame loop

  private raf = 0;

  /** Requests a frame. */
  invalidate(): void {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.disposed) return;
    const dt = this.lastTime ? Math.min(100, now - this.lastTime) : 16;
    this.lastTime = now;
    const k = 1 - Math.exp(-dt / 110);
    this.camera.x += (this.target.x - this.camera.x) * k;
    this.camera.y += (this.target.y - this.camera.y) * k;
    if (Math.abs(this.target.x - this.camera.x) * this.scale < 0.3) this.camera.x = this.target.x;
    if (Math.abs(this.target.y - this.camera.y) * this.scale < 0.3) this.camera.y = this.target.y;

    const animating = this.draw(now);
    this.measure(dt, animating);
    if (animating && this.active) this.invalidate();
    else this.lastTime = 0;
  };

  private measure(dt: number, animating: boolean): void {
    if (!animating || this.reduced || this.slowReported || !this.renderer) return;
    this.sampledFrames++;
    if (dt > 45) this.slowFrames++;
    if (this.sampledFrames >= 90) {
      if (this.slowFrames / this.sampledFrames > 0.5) {
        this.slowReported = true;
        this.options.onSlow?.();
      }
      this.sampledFrames = this.slowFrames = 0;
    }
  }

  /** Lays out, renders and positions the DOM nodes. Returns true while animating. */
  private draw(now: number): boolean {
    this.frame++;
    const pool = this.options.pool;
    pool.beginFrame();
    pool.advance(now);
    const visible = this.computeVisible(now);
    const moving = this.camera.x !== this.target.x || this.camera.y !== this.target.y;
    const entering = !this.reduced && now - this.reframeAt < ENTRANCE_MS + 160;

    if (this.renderer && this.active) {
      const cards = visible.map((v) => v.card);
      this.renderer.render(cards, this.cameraState, this.width, this.height);
    }
    this.syncNodes(visible);
    return moving || entering || pool.animating;
  }

  private computeVisible(now: number): Visible[] {
    const pool = this.options.pool;
    const instances = this.instancesIn(this.viewRect());
    const s = this.scale;
    const radius = this.cameraState.radius;
    const out: Visible[] = [];
    const cx = this.camera.x;
    const cy = this.camera.y;
    for (const instance of instances) {
      const focused = instance.key === this.focusKey;
      const x = (instance.x - cx) * s;
      const y = (instance.y - cy) * s;
      let w = instance.w * s * CARD_FILL;
      let h = instance.h * s * CARD_FILL;
      // Entrance after a reframe: staggered by rank, best hits first.
      let enter = 1;
      if (!this.reduced && now - this.reframeAt < ENTRANCE_MS + 160) {
        const delay = Math.min(150, instance.rank * 15);
        enter = smootherstep(clamp((now - this.reframeAt - delay) / ENTRANCE_MS, 0, 1));
      }
      const grow = focused ? 1.05 : 1;
      w *= (0.9 + 0.1 * enter) * grow;
      h *= (0.9 + 0.1 * enter) * grow;
      const pose = spherePlacement(x, y, radius);
      const projected = projectToScreen(pose.position, this.cameraState, this.width, this.height);
      const ratio = this.cameraState.perspective / Math.max(1, projected.depth);
      const sw = w * ratio;
      const sh = h * ratio;
      const left = projected.x - sw / 2;
      const top = projected.y - sh / 2;
      if (left > this.width || top > this.height || left + sw < 0 || top + sh < 0) {
        if (!focused) continue;
      }
      const distance = Math.hypot(projected.x - this.width / 2, projected.y - this.height / 2);
      const source = this.renderer ? pool.get(instance.item, distance) : undefined;
      if (!this.renderer && instance.item.type !== 'audio') pool.get(instance.item, distance);
      const relevance = instance.relevance;
      const resting = this.mode === 'results' && relevance !== undefined ? 0.5 + 0.35 * relevance : 0.72;
      const opacity = (focused ? 1 : resting) * enter;
      out.push({
        instance,
        left,
        top,
        width: sw,
        height: sh,
        card: {
          id: instance.item.id,
          instanceKey: instance.key,
          x: pose.position[0],
          y: pose.position[1],
          z: pose.position[2] + (focused ? 6 : 0),
          w,
          h,
          q: pose.q,
          opacity,
          hover: focused ? 1 : 0,
          dispersion: instance.item.type === 'audio' ? 0.12 : 1,
          shape: cardShape(w, h),
          sphereRadius: radius,
          source: source?.source,
          sourceVersion: source?.version,
          aspect: instance.item.aspectRatio,
        },
      });
    }
    // Focused card last so it draws on top in the transparent pass.
    out.sort((a, b) => Number(a.instance.key === this.focusKey) - Number(b.instance.key === this.focusKey));
    return out;
  }

  private visibleCache: Visible[] = [];

  private syncNodes(visible: Visible[]): void {
    this.visibleCache = visible;
    const keep = new Set<string>();
    // Closest to the centre first, so the cap drops the far edges.
    const ordered = [...visible].sort(
      (a, b) =>
        Math.hypot(a.left + a.width / 2 - this.width / 2, a.top + a.height / 2 - this.height / 2) -
        Math.hypot(b.left + b.width / 2 - this.width / 2, b.top + b.height / 2 - this.height / 2),
    );
    for (const v of ordered) {
      if (keep.size >= MAX_NODES && v.instance.key !== this.focusKey) continue;
      keep.add(v.instance.key);
      this.ensureNode(v.instance);
    }
    if (this.focusKey) keep.add(this.focusKey);
    for (const [key, node] of this.nodes) {
      if (keep.has(key)) continue;
      if (node.button === document.activeElement) continue;
      node.button.remove();
      this.nodes.delete(key);
    }
    this.positionNodes();
  }

  private positionNodes(): void {
    const byKey = new Map(this.visibleCache.map((v) => [v.instance.key, v]));
    for (const [key, node] of this.nodes) {
      const v = byKey.get(key);
      const button = node.button;
      if (!v) {
        // Not computed yet (just created): place it from layout coordinates.
        const s = this.scale;
        const w = node.instance.w * s * CARD_FILL;
        const h = node.instance.h * s * CARD_FILL;
        const x = this.width / 2 + (node.instance.x - this.camera.x) * s - w / 2;
        const y = this.height / 2 + (node.instance.y - this.camera.y) * s - h / 2;
        setRect(button, x, y, w, h);
        continue;
      }
      setRect(button, v.left, v.top, v.width, v.height);
      button.style.opacity = this.renderer ? '' : String(v.card.opacity ?? 1);
      button.classList.toggle('is-focused', key === this.focusKey);
    }
    this.updateCaption(byKey.get(this.focusKey ?? ''));
  }

  private captionKey = '';

  private updateCaption(v: Visible | undefined): void {
    const showing = !!v && this.layer.contains(document.activeElement);
    this.caption.hidden = !showing;
    if (!v || !showing) return;
    const instance = v.instance;
    const key = `${instance.key}|${instance.relevance ?? ''}`;
    if (key !== this.captionKey) {
      this.captionKey = key;
      const item = instance.item;
      const meta = [TYPE_LABEL[item.type], item.topic].filter(Boolean);
      if (item.durationSeconds) meta.push(formatDuration(item.durationSeconds));
      if (instance.relevance !== undefined) meta.push(`Relevance ${instance.relevance.toFixed(2)}`);
      this.caption.replaceChildren(
        Object.assign(document.createElement('strong'), { textContent: item.title }),
        Object.assign(document.createElement('span'), { textContent: meta.join(' · ') }),
      );
    }
    const chipHeight = this.caption.offsetHeight || 56;
    const chipWidth = Math.min(this.width - 16, 420);
    let top = v.top + v.height + 8;
    if (top + chipHeight > this.height - 6) top = Math.max(this.options.topInset() + 4, v.top - chipHeight - 8);
    if (top + chipHeight > this.height - 6) top = this.height - chipHeight - 6;
    const left = clamp(v.left + v.width / 2 - chipWidth / 2, 8, this.width - chipWidth - 8);
    this.caption.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    this.caption.style.width = `${chipWidth}px`;
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.renderer?.dispose();
    this.element.remove();
  }
}

function setRect(el: HTMLElement, x: number, y: number, w: number, h: number): void {
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  el.style.width = `${Math.max(1, w).toFixed(1)}px`;
  el.style.height = `${Math.max(1, h).toFixed(1)}px`;
}

const KEY_DIRECTIONS: Record<string, Direction | undefined> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

function describe(instance: Instance): string {
  const item = instance.item;
  const parts = [item.title, TYPE_LABEL[item.type]];
  if (item.durationSeconds) parts.push(formatDuration(item.durationSeconds));
  if (instance.relevance !== undefined) parts.push(`relevance ${instance.relevance.toFixed(2)}`);
  return parts.join(', ');
}

/**
 * The neighbour rule, shared with the unit tests.
 *
 * Horizontal: cards in the same row band first (vertical overlap), nearest by
 * horizontal distance. Vertical: the nearest row band in that direction, then
 * the card whose centre is horizontally closest.
 */
export function pickNeighbor(from: Instance, candidates: readonly Instance[], dir: Direction): Instance | null {
  const top = from.y - from.h / 2;
  const bottom = from.y + from.h / 2;
  if (dir === 'left' || dir === 'right') {
    const sign = dir === 'right' ? 1 : -1;
    const ahead = candidates.filter((c) => sign * (c.x - from.x) > from.w * 0.25);
    const sameRow = ahead.filter((c) => c.y - c.h / 2 < bottom - from.h * 0.25 && c.y + c.h / 2 > top + from.h * 0.25);
    const pool = sameRow.length ? sameRow : ahead;
    let best: Instance | null = null;
    let bestScore = Infinity;
    for (const c of pool) {
      const score = Math.abs(c.x - from.x) + (sameRow.length ? 0 : 2 * Math.abs(c.y - from.y));
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }
  const sign = dir === 'down' ? 1 : -1;
  const ahead = candidates.filter((c) => sign * (c.y - from.y) > from.h * 0.5);
  if (!ahead.length) return null;
  const nearestDy = Math.min(...ahead.map((c) => Math.abs(c.y - from.y)));
  const band = ahead.filter((c) => Math.abs(c.y - from.y) <= nearestDy + from.h * 0.5);
  let best: Instance | null = null;
  let bestScore = Infinity;
  for (const c of band) {
    const score = Math.abs(c.x - from.x) + 0.1 * Math.abs(c.y - from.y);
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

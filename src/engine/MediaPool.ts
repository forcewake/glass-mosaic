/**
 * The media pool: owns card bitmaps, audio waveform canvases and the single
 * live video preview, and tells the field when something new can be drawn.
 *
 * A simplified port of embed-anything's `MediaTexturePool` (MIT) for a
 * battery-powered 600x600 display:
 *   - only small thumbnails (330 px) are ever decoded for the field;
 *   - at most `concurrency` downloads at a time, closest-first;
 *   - an LRU bound on decoded bitmaps;
 *   - at most ONE video element, for the focused card, muted, 240p, and its
 *     frames are re-uploaded at no more than `videoFps`. Everything else is a
 *     still poster, and the video is paused whenever it is not focused, the
 *     viewer is open or the page is hidden.
 */
import { paintWaveform } from '../media/waveform';
import type { MediaItem } from '../media/types';

export interface PoolOptions {
  onChange: () => void;
  concurrency?: number;
  capacity?: number;
  videoFps?: number;
}

interface Entry {
  item: MediaItem;
  image?: HTMLImageElement;
  canvas?: HTMLCanvasElement;
  ready: boolean;
  failed: boolean;
  loading: boolean;
  used: number;
}

export interface CardSource {
  source: CanvasImageSource;
  version: string;
  /** True for the live video preview. */
  live?: boolean;
}

/** The still image used for a card (image thumbnail or video poster). */
export function stillUrl(item: MediaItem): string | undefined {
  if (item.type === 'audio') return undefined;
  return item.thumb ?? item.poster ?? (item.type === 'image' ? item.src : undefined);
}

export class MediaPool {
  private entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private active = 0;
  private tick = 0;
  private readonly concurrency: number;
  private readonly capacity: number;
  private readonly frameInterval: number;
  private readonly onChange: () => void;

  private video: HTMLVideoElement | null = null;
  private liveItem: MediaItem | null = null;
  private liveReady = false;
  private liveVersion = 0;
  private lastFrame = 0;
  private liveEnabled = true;

  constructor(options: PoolOptions) {
    this.onChange = options.onChange;
    this.concurrency = options.concurrency ?? 6;
    this.capacity = options.capacity ?? 120;
    this.frameInterval = 1000 / (options.videoFps ?? 12);
  }

  /** Marks the start of a frame; used for LRU bookkeeping. */
  beginFrame(): void {
    this.tick++;
  }

  /**
   * The bitmap for a card, or `undefined` while it loads. Calling this also
   * schedules the download with the given priority (lower = sooner).
   */
  get(item: MediaItem, priority = 0): CardSource | undefined {
    if (this.liveItem?.id === item.id && this.liveReady && this.video) {
      return { source: this.video, version: `v${this.liveVersion}`, live: true };
    }
    let entry = this.entries.get(item.id);
    if (!entry) {
      entry = { item, ready: false, failed: false, loading: false, used: this.tick };
      this.entries.set(item.id, entry);
      if (item.type === 'audio') {
        entry.canvas = this.waveformCanvas(item);
        entry.ready = true;
      } else {
        (entry as Entry & { priority?: number }).priority = priority;
        this.queue.push(entry);
        this.pump();
      }
      this.evict();
    } else if (!entry.ready && !entry.loading && !entry.failed) {
      (entry as Entry & { priority?: number }).priority = priority;
    }
    entry.used = this.tick;
    if (!entry.ready) return undefined;
    const source = entry.canvas ?? entry.image;
    return source ? { source, version: 's' } : undefined;
  }

  /** The decoded still for the DOM renderer (`<img>` src or waveform canvas). */
  isReady(item: MediaItem): boolean {
    return !!this.entries.get(item.id)?.ready;
  }

  private waveformCanvas(item: MediaItem): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    paintWaveform(canvas, item);
    return canvas;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      this.queue.sort(
        (a, b) =>
          ((a as Entry & { priority?: number }).priority ?? 0) - ((b as Entry & { priority?: number }).priority ?? 0),
      );
      const entry = this.queue.shift()!;
      if (!this.entries.has(entry.item.id) || entry.used < this.tick - 2) {
        // Scrolled away before its turn: forget it, it will be re-requested.
        this.entries.delete(entry.item.id);
        continue;
      }
      const url = stillUrl(entry.item);
      if (!url) {
        entry.failed = true;
        continue;
      }
      this.active++;
      entry.loading = true;
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      const done = (ok: boolean) => {
        this.active--;
        entry.loading = false;
        if (ok) {
          entry.image = image;
          entry.ready = true;
          this.onChange();
        } else {
          entry.failed = true;
        }
        this.pump();
      };
      image.onload = () => {
        image
          .decode()
          .catch(() => undefined)
          .then(() => done(image.naturalWidth > 0));
      };
      image.onerror = () => done(false);
      image.src = url;
    }
  }

  private evict(): void {
    if (this.entries.size <= this.capacity) return;
    const victims = [...this.entries.values()]
      .filter((entry) => !entry.loading)
      .sort((a, b) => a.used - b.used)
      .slice(0, this.entries.size - this.capacity);
    for (const victim of victims) {
      if (victim.image) victim.image.src = '';
      if (victim.canvas) victim.canvas.width = victim.canvas.height = 0;
      this.entries.delete(victim.item.id);
    }
  }

  /** Enables or disables live video previews (reduced mode turns them off). */
  setLiveEnabled(enabled: boolean): void {
    this.liveEnabled = enabled;
    if (!enabled) this.setLive(null);
  }

  /**
   * Plays a muted, low-resolution preview of `item` in the field (or stops
   * the preview with `null`). Only one preview exists at any time.
   */
  setLive(item: MediaItem | null): void {
    const next = item && this.liveEnabled && item.type === 'video' && (item.preview || item.src) ? item : null;
    if (next?.id === this.liveItem?.id) return;
    this.liveItem = next;
    this.liveReady = false;
    if (!next) {
      if (this.video) {
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
      }
      this.onChange();
      return;
    }
    const video = this.video ?? this.createVideo();
    video.src = next.preview ?? next.src;
    video.play().catch(() => undefined);
  }

  /** Pauses or resumes the live preview without forgetting it. */
  setLivePaused(paused: boolean): void {
    if (!this.video || !this.liveItem) return;
    if (paused) this.video.pause();
    else this.video.play().catch(() => undefined);
  }

  /** True while a live preview needs new frames. */
  get animating(): boolean {
    return !!(this.video && this.liveItem && this.liveReady && !this.video.paused);
  }

  /** Advances the live preview version at the throttled frame rate. */
  advance(now: number): void {
    if (!this.animating) return;
    if (now - this.lastFrame >= this.frameInterval) {
      this.lastFrame = now;
      this.liveVersion++;
    }
  }

  private createVideo(): HTMLVideoElement {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.disablePictureInPicture = true;
    video.addEventListener('loadeddata', () => {
      if (!this.liveItem) return;
      this.liveReady = true;
      this.onChange();
    });
    video.addEventListener('playing', () => this.onChange());
    this.video = video;
    return video;
  }

  dispose(): void {
    this.setLive(null);
    this.entries.clear();
    this.queue = [];
  }
}

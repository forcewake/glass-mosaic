/**
 * The full-screen viewer (a DOM dialog over the paused field).
 *
 * D-pad model, all on real focusable elements:
 *   stage (focused on open): Left/Right = previous/next, Enter = play/pause
 *     (audio, video), Down = the controls row;
 *   controls row: [Prev] [Play] [Close] [Next], ordinary buttons (native
 *     spatial navigation moves between them), Up = back to the stage.
 * The system Back gesture (history.back) and Escape close the viewer.
 */
import type { MediaItem } from '../media/types';
import { TYPE_LABEL } from '../media/types';
import { formatDuration } from '../media/catalog';
import { paintWaveform } from '../media/waveform';

export interface ViewerContext {
  item: MediaItem;
  relevance?: number;
  /** "3 of 24", or a hint in browse mode. */
  position: string;
}

export interface ViewerCallbacks {
  onStep: (delta: 1 | -1) => ViewerContext | null;
  onClose: () => void;
}

export class Viewer {
  readonly element: HTMLDivElement;
  private stage: HTMLDivElement;
  private title: HTMLHeadingElement;
  private meta: HTMLParagraphElement;
  private credit: HTMLParagraphElement;
  private position: HTMLSpanElement;
  private playButton: HTMLButtonElement;
  private controls: HTMLDivElement;
  private media: HTMLVideoElement | HTMLAudioElement | null = null;
  private waveform: HTMLCanvasElement | null = null;
  private current: ViewerContext | null = null;
  private raf = 0;

  constructor(
    host: HTMLElement,
    private callbacks: ViewerCallbacks,
  ) {
    const el = document.createElement('div');
    el.className = 'viewer';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'viewer-title');
    el.innerHTML = `
      <div class="viewer-stage" tabindex="0" role="group" aria-roledescription="media viewer" aria-describedby="viewer-help"></div>
      <div class="viewer-caption">
        <h2 class="viewer-title" id="viewer-title"></h2>
        <p class="viewer-meta"></p>
        <p class="viewer-credit"></p>
      </div>
      <div class="viewer-controls" role="toolbar" aria-label="Viewer controls">
        <button type="button" data-action="prev" aria-label="Previous item">‹ Prev</button>
        <button type="button" data-action="play">Play</button>
        <button type="button" data-action="close">Close</button>
        <button type="button" data-action="next" aria-label="Next item">Next ›</button>
      </div>
      <p class="viewer-help" id="viewer-help"><span class="viewer-position"></span><span>←→ next · ↓ buttons · Back</span></p>`;
    host.append(el);
    this.element = el;
    this.stage = el.querySelector('.viewer-stage')!;
    this.title = el.querySelector('.viewer-title')!;
    this.meta = el.querySelector('.viewer-meta')!;
    this.credit = el.querySelector('.viewer-credit')!;
    this.position = el.querySelector('.viewer-position')!;
    this.controls = el.querySelector('.viewer-controls')!;
    this.playButton = el.querySelector('[data-action="play"]')!;

    this.stage.addEventListener('keydown', this.onStageKey);
    this.controls.addEventListener('keydown', this.onControlsKey);
    this.controls.addEventListener('click', this.onControlsClick);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.callbacks.onClose();
      }
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  get item(): MediaItem | null {
    return this.current?.item ?? null;
  }

  open(context: ViewerContext): void {
    this.element.hidden = false;
    this.show(context);
    this.stage.focus({ preventScroll: true });
  }

  close(): void {
    this.stopMedia();
    this.element.hidden = true;
    this.stage.replaceChildren();
    this.current = null;
  }

  /** Moves to the previous/next item. Returns false at the ends. */
  step(delta: 1 | -1): boolean {
    const next = this.callbacks.onStep(delta);
    if (!next) {
      this.stage.classList.remove('bump');
      void this.stage.offsetWidth;
      this.stage.classList.add('bump');
      return false;
    }
    this.show(next);
    return true;
  }

  /** Starts or pauses audio/video. Returns the new playing state, or null for images. */
  togglePlay(): boolean | null {
    const media = this.media;
    if (!media) return null;
    if (media.paused) {
      media.play().catch(() => this.syncPlayLabel());
    } else {
      media.pause();
    }
    this.syncPlayLabel();
    return !media.paused;
  }

  private show(context: ViewerContext): void {
    this.stopMedia();
    this.current = context;
    const item = context.item;
    this.title.textContent = item.title;
    const meta = [TYPE_LABEL[item.type], item.topic].filter(Boolean);
    if (item.durationSeconds) meta.push(formatDuration(item.durationSeconds));
    if (context.relevance !== undefined) meta.push(`Relevance ${context.relevance.toFixed(2)}`);
    this.meta.textContent = meta.join(' · ');
    this.credit.replaceChildren(
      document.createTextNode(`${item.artist} · ${item.license}${item.page ? ' · ' : ''}`),
    );
    if (item.page) {
      const link = document.createElement('a');
      link.href = item.page;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.tabIndex = -1;
      link.textContent = 'Wikimedia Commons';
      this.credit.append(link);
    }
    this.position.textContent = context.position;
    this.element.dataset.type = item.type;
    this.stage.setAttribute('aria-label', `${item.title}, ${TYPE_LABEL[item.type]}`);

    const nodes: HTMLElement[] = [];
    if (item.type === 'image') {
      const img = document.createElement('img');
      img.alt = item.title;
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      // The 330 px thumbnail is usually cached already: show it at once and
      // swap in the 960 px version when it has loaded.
      img.src = item.thumb ?? item.src;
      if (item.thumb && item.thumb !== item.src) {
        const large = new Image();
        large.referrerPolicy = 'no-referrer';
        large.onload = () => {
          if (this.current?.item.id === item.id) img.src = large.src;
        };
        large.src = item.src;
      }
      nodes.push(img);
    } else if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = item.src;
      if (item.poster ?? item.thumb) video.poster = (item.poster ?? item.thumb)!;
      video.preload = 'metadata';
      video.playsInline = true;
      video.loop = true;
      video.disablePictureInPicture = true;
      video.setAttribute('aria-label', item.title);
      this.media = video;
      nodes.push(video);
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = 560;
      canvas.height = 300;
      canvas.className = 'viewer-waveform';
      paintWaveform(canvas, item);
      const audio = document.createElement('audio');
      audio.src = item.src;
      audio.preload = 'metadata';
      this.media = audio;
      this.waveform = canvas;
      nodes.push(canvas, audio);
    }
    if (this.media) {
      this.media.addEventListener('play', this.onPlayState);
      this.media.addEventListener('pause', this.onPlayState);
      this.media.addEventListener('ended', this.onPlayState);
    }
    this.stage.replaceChildren(...nodes);
    this.playButton.hidden = item.type === 'image';
    this.syncPlayLabel();
  }

  private onPlayState = () => {
    this.syncPlayLabel();
    if (this.media && !this.media.paused && this.waveform) this.animateWaveform();
  };

  private animateWaveform() {
    cancelAnimationFrame(this.raf);
    const draw = (time: number) => {
      const media = this.media;
      if (!media || !this.waveform || !this.current) return;
      const progress = media.duration ? media.currentTime / media.duration : 0;
      paintWaveform(this.waveform, this.current.item, progress, media.paused ? undefined : time / 1000);
      if (!media.paused) this.raf = requestAnimationFrame(draw);
    };
    this.raf = requestAnimationFrame(draw);
  }

  private syncPlayLabel() {
    const playing = !!this.media && !this.media.paused;
    this.playButton.textContent = playing ? 'Pause' : 'Play';
    this.element.classList.toggle('is-playing', playing);
  }

  private stopMedia() {
    cancelAnimationFrame(this.raf);
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute('src');
      this.media.load();
    }
    this.media = null;
    this.waveform = null;
  }

  private onStageKey = (event: KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        this.step(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.step(1);
        break;
      case 'ArrowDown': {
        event.preventDefault();
        const first = this.media ? this.playButton : this.controls.querySelector<HTMLButtonElement>('[data-action="close"]');
        first?.focus({ preventScroll: true });
        break;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        this.togglePlay();
        break;
    }
  };

  /**
   * A roving toolbar: Left/Right move between the visible buttons (desktop
   * Chromium has no spatial navigation, the glasses do; handling it here
   * gives both the same behaviour), Up returns to the stage.
   */
  private onControlsKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.stage.focus({ preventScroll: true });
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = [...this.controls.querySelectorAll<HTMLButtonElement>('button')].filter((b) => !b.hidden);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = buttons[index + (event.key === 'ArrowRight' ? 1 : -1)];
    next?.focus({ preventScroll: true });
  };

  private onControlsClick = (event: MouseEvent) => {
    const action = (event.target as HTMLElement).closest('button')?.dataset.action;
    if (action === 'prev') this.step(-1);
    else if (action === 'next') this.step(1);
    else if (action === 'play') this.togglePlay();
    else if (action === 'close') this.callbacks.onClose();
  };
}

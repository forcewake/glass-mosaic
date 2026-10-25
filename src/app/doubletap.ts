/**
 * Double ArrowUp → search.
 *
 * On the glasses the touchpad / Meta Neural Band deliver arrow keys, and the
 * search field sits at the top of the screen, so reaching it one row at a
 * time is tedious. Two ArrowUp keydowns within `DOUBLE_ARROW_UP_MS` jump
 * straight to the field and activate it (which opens the system composer).
 *
 * The first ArrowUp is never touched, so spatial navigation and the field's
 * own arrow handling keep working; only the second, quick press is consumed
 * (`preventDefault` + `stopPropagation`) and replaced by the jump.
 */

/** Maximum gap between the two ArrowUp keydowns, in ms. */
export const DOUBLE_ARROW_UP_MS = 350;

/** Pure timing rule, shared with the unit tests. */
export class DoubleTapDetector {
  private last = Number.NEGATIVE_INFINITY;

  constructor(readonly windowMs = DOUBLE_ARROW_UP_MS) {}

  /** Records a press at time `t` (ms). Returns true when it completes a double tap. */
  press(t: number): boolean {
    const gap = t - this.last;
    if (gap >= 0 && gap <= this.windowMs) {
      // Consume the pair, so a triple tap does not fire twice.
      this.last = Number.NEGATIVE_INFINITY;
      return true;
    }
    this.last = t;
    return false;
  }

  /** True while a first press is waiting for its partner at time `t`. */
  pending(t: number): boolean {
    const gap = t - this.last;
    return gap >= 0 && gap <= this.windowMs;
  }

  reset(): void {
    this.last = Number.NEGATIVE_INFINITY;
  }
}

export interface DoubleArrowUpOptions {
  /** True when a sequence must not start (e.g. the search field already has focus or the composer is open). */
  isBlocked: () => boolean;
  onDoubleTap: () => void;
  windowMs?: number;
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

interface KeyLike {
  key: string;
  repeat?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  timeStamp: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * Builds the keydown handler (exported separately so it can be tested
 * without a DOM). Listen with `capture: true` so the second press is
 * consumed before the focused widget sees it.
 */
export function doubleArrowUpHandler(options: Omit<DoubleArrowUpOptions, 'target'>): (event: KeyLike) => void {
  const detector = new DoubleTapDetector(options.windowMs);
  return (event) => {
    if (event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      detector.reset();
      return;
    }
    if (event.repeat) return;
    // Do not start a sequence from the search field or while the composer is up.
    // Checked only for the first press: that press may itself move focus into
    // the field (Up from the top row), and the second one then opens the composer.
    if (!detector.pending(event.timeStamp) && options.isBlocked()) {
      detector.reset();
      return;
    }
    if (detector.press(event.timeStamp)) {
      event.preventDefault();
      event.stopPropagation();
      options.onDoubleTap();
    }
  };
}

/** Installs the listener on `window` (capture phase). Returns an uninstall function. */
export function installDoubleArrowUp(options: DoubleArrowUpOptions): () => void {
  const target = options.target ?? window;
  const handler = doubleArrowUpHandler(options) as unknown as EventListener;
  target.addEventListener('keydown', handler, { capture: true });
  return () => target.removeEventListener('keydown', handler, { capture: true });
}

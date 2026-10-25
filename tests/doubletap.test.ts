import { describe, expect, it, vi } from 'vitest';
import { DOUBLE_ARROW_UP_MS, DoubleTapDetector, doubleArrowUpHandler } from '../src/app/doubletap';

function key(keyName: string, timeStamp: number, extra: Partial<{ repeat: boolean; shiftKey: boolean }> = {}) {
  return { key: keyName, timeStamp, ...extra, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe('DoubleTapDetector', () => {
  it('fires on the second press inside the window only', () => {
    const d = new DoubleTapDetector(350);
    expect(d.press(1000)).toBe(false);
    expect(d.press(1300)).toBe(true);
    expect(d.press(1400)).toBe(false); // pair consumed: a triple tap fires once
    expect(d.press(2000)).toBe(false); // too slow (600 ms)
    expect(d.press(2350)).toBe(true); // exactly the window
  });

  it('defaults to the configurable constant and can reset', () => {
    const d = new DoubleTapDetector();
    expect(d.windowMs).toBe(DOUBLE_ARROW_UP_MS);
    d.press(0);
    expect(d.pending(100)).toBe(true);
    d.reset();
    expect(d.press(100)).toBe(false);
  });
});

describe('double ArrowUp handler', () => {
  it('leaves the first press alone and consumes only the second', () => {
    const onDoubleTap = vi.fn();
    const handle = doubleArrowUpHandler({ isBlocked: () => false, onDoubleTap });
    const first = key('ArrowUp', 10);
    const second = key('ArrowUp', 200);
    handle(first);
    expect(first.preventDefault).not.toHaveBeenCalled();
    expect(first.stopPropagation).not.toHaveBeenCalled();
    handle(second);
    expect(second.preventDefault).toHaveBeenCalled();
    expect(second.stopPropagation).toHaveBeenCalled();
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it('ignores slow presses, other keys in between, key repeat and modifiers', () => {
    const onDoubleTap = vi.fn();
    const handle = doubleArrowUpHandler({ isBlocked: () => false, onDoubleTap });
    handle(key('ArrowUp', 0));
    handle(key('ArrowUp', 500)); // too slow, becomes a new first press
    handle(key('ArrowLeft', 600));
    handle(key('ArrowUp', 650)); // sequence was reset by ArrowLeft
    handle(key('ArrowUp', 700, { repeat: true })); // held key
    handle(key('ArrowUp', 1500));
    handle(key('ArrowUp', 1600, { shiftKey: true }));
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it('does not start from the search field, but completes when the first press moved focus into it', () => {
    let inField = true;
    const onDoubleTap = vi.fn();
    const handle = doubleArrowUpHandler({ isBlocked: () => inField, onDoubleTap });
    handle(key('ArrowUp', 0));
    handle(key('ArrowUp', 100));
    expect(onDoubleTap).not.toHaveBeenCalled();
    inField = false;
    handle(key('ArrowUp', 1000)); // from the top row of cards…
    inField = true; // …which moved focus into the field
    handle(key('ArrowUp', 1200));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });
});

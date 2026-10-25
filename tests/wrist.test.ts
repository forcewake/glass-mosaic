import { describe, expect, it } from 'vitest';
import { DEG, WRIST_DEFAULTS, WristRollDetector, hasWristSensor, toW3C, twistAngle, wrapAngle, type WristUpdate } from '../src/app/wrist';

/** A raw, w-first reading ([w, x, y, z], as the glasses deliver it) for a twist of `deg` about the forearm (+Y). */
function rawTwist(deg: number, sign = 1): number[] {
  const h = (deg * DEG) / 2;
  return [sign * Math.cos(h), 0, sign * Math.sin(h), 0];
}

/** Twist plus a fixed forearm pitch about X (applied first), w-first. */
function rawTwistPitched(deg: number, pitchDeg: number): number[] {
  const a = (deg * DEG) / 2;
  const b = (pitchDeg * DEG) / 2;
  // q = qPitch(X) * qTwist(Y), W3C [x, y, z, w]
  const [x1, w1] = [Math.sin(b), Math.cos(b)];
  const [y2, w2] = [Math.sin(a), Math.cos(a)];
  const x = w1 * 0 + x1 * w2;
  const y = w1 * y2;
  const z = x1 * y2;
  const w = w1 * w2;
  return [w, x, y, z];
}

/** Feeds angles at 50 Hz starting at t0; returns all updates and the end time. */
function feed(d: WristRollDetector, angles: number[], t0: number, raw: (a: number) => number[] = rawTwist) {
  const out: WristUpdate[] = [];
  let t = t0;
  for (const a of angles) {
    out.push(d.push(raw(a), t));
    t += 20;
  }
  return { out, t };
}
const hold = (deg: number, ms: number) => Array.from({ length: Math.round(ms / 20) }, () => deg);
const ramp = (from: number, to: number, ms: number) => {
  const n = Math.max(1, Math.round(ms / 20));
  return Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);
};
const triggers = (u: WristUpdate[]) => u.filter((x) => x.triggered).length;

describe('wrist roll math', () => {
  it('reorders w-first readings into W3C order and rejects junk', () => {
    expect(toW3C([1, 2, 3, 4])).toEqual([2, 3, 4, 1]);
    expect(toW3C([0, 0, 0, 0])).toBeNull();
    expect(toW3C([1, NaN, 0, 0])).toBeNull();
    expect(toW3C(null)).toBeNull();
    expect(toW3C([1, 0, 0])).toBeNull();
  });

  it('measures twist about the forearm axis, independent of quaternion sign', () => {
    for (const deg of [-120, -50, 0, 30, 90, 170]) {
      expect(wrapAngle(twistAngle(toW3C(rawTwist(deg))!)) / DEG).toBeCloseTo(deg, 6);
      expect(wrapAngle(twistAngle(toW3C(rawTwist(deg, -1))!)) / DEG).toBeCloseTo(deg, 6);
    }
    // A pitched forearm does not read as twist.
    expect(wrapAngle(twistAngle(toW3C(rawTwistPitched(0, 40))!)) / DEG).toBeCloseTo(0, 6);
  });

  it('wraps angles to [-180, 180)', () => {
    expect(wrapAngle(181 * DEG) / DEG).toBeCloseTo(-179, 6);
    expect(wrapAngle(-181 * DEG) / DEG).toBeCloseTo(179, 6);
    expect(wrapAngle((179 - -179) * DEG) / DEG).toBeCloseTo(-2, 6);
  });

  it('detects the runtime marker, not the bare constructor', () => {
    class Plain {}
    class Wrapped {
      static __imuQuatWrapped = true;
    }
    expect(hasWristSensor({})).toBe(false);
    expect(hasWristSensor({ RelativeOrientationSensor: Plain })).toBe(false);
    expect(hasWristSensor({ RelativeOrientationSensor: Wrapped })).toBe(true);
  });
});

describe('WristRollDetector', () => {
  it('waits out an early frame flip before capturing the reference, then fires once on twist-and-return', () => {
    const d = new WristRollDetector();
    // Settling stream: +20 deg, then the mirror engages and the frame inverts to -20.
    let r = feed(d, hold(20, 600), 0);
    const flipped = d.push(rawTwist(-20), r.t);
    expect(flipped.flipped).toBe(true);
    expect(d.ready).toBe(false);
    r = feed(d, hold(-20, 900), r.t + 20);
    expect(d.ready).toBe(false); // needs settleMs of stability after the flip
    r = feed(d, hold(-20, 300), r.t);
    expect(d.ready).toBe(true);
    // Reference is the post-flip pose: holding there reads ~0.
    r = feed(d, hold(-20, 200), r.t);
    expect(Math.abs(r.out.at(-1)!.rollDeg!)).toBeLessThan(1);

    // Twist +65 deg relative to the reference in 300 ms, return in 300 ms.
    r = feed(d, [...ramp(-20, 45, 300), ...ramp(45, -20, 300)], r.t);
    expect(r.out.some((u) => u.phase === 'armed')).toBe(true);
    expect(triggers(r.out)).toBe(1);
    expect(r.out.at(-1)!.phase).toBe('cooldown');

    // A second twist inside the cooldown does nothing…
    r = feed(d, [...ramp(-20, 45, 300), ...ramp(45, -20, 300)], r.t);
    expect(triggers(r.out)).toBe(0);
    // …but works after it.
    r = feed(d, hold(-20, WRIST_DEFAULTS.cooldownMs), r.t);
    r = feed(d, [...ramp(-20, -90, 300), ...ramp(-90, -20, 300)], r.t); // the other direction
    expect(triggers(r.out)).toBe(1);
  });

  it('ignores readings before warm-up and never fires while settling', () => {
    const d = new WristRollDetector();
    const r = feed(d, [...hold(0, 200), ...ramp(0, 80, 200), ...ramp(80, 0, 200)], 0);
    expect(triggers(r.out)).toBe(0);
    expect(r.out.every((u) => u.rollDeg === null)).toBe(true);
  });

  it('does not fire below the threshold, on a slow drift, or on a held posture change', () => {
    const d = new WristRollDetector();
    let r = feed(d, hold(0, 2200), 0);
    expect(d.ready).toBe(true);
    // 40 deg and back: below the 50 deg threshold.
    r = feed(d, [...ramp(0, 40, 300), ...ramp(40, 0, 300)], r.t);
    expect(triggers(r.out)).toBe(0);
    // Heading/roll drift of 90 deg over 30 s: the reference follows.
    r = feed(d, ramp(0, 90, 30_000), r.t);
    expect(triggers(r.out)).toBe(0);
    expect(Math.abs(r.out.at(-1)!.rollDeg!)).toBeLessThan(WRIST_DEFAULTS.thresholdDeg);
    // Twist to 70 deg and hold for 2 s, then come back slowly: a posture change.
    r = feed(d, [...ramp(90, 160, 300), ...hold(160, 2000), ...ramp(160, 90, 3000)], r.t);
    expect(triggers(r.out)).toBe(0);
  });

  it('requires the return (hysteresis): hovering around the threshold does not fire', () => {
    const d = new WristRollDetector();
    let r = feed(d, hold(0, 2200), 0);
    r = feed(d, [...ramp(0, 55, 200), 45, 52, 46, 51, 44, 53, 30, 35], r.t);
    expect(triggers(r.out)).toBe(0);
    r = feed(d, ramp(35, 0, 200), r.t);
    expect(triggers(r.out)).toBe(1);
  });

  it('honours a single configured direction and threshold', () => {
    const d = new WristRollDetector({ direction: 1, thresholdDeg: 30 });
    let r = feed(d, hold(0, 2200), 0);
    r = feed(d, [...ramp(0, -45, 200), ...ramp(-45, 0, 200)], r.t);
    expect(triggers(r.out)).toBe(0);
    r = feed(d, [...ramp(0, 35, 200), ...ramp(35, 0, 200)], r.t);
    expect(triggers(r.out)).toBe(1);
  });

  it('survives a quaternion sign change (double cover) without re-settling', () => {
    const d = new WristRollDetector();
    let r = feed(d, hold(10, 2200), 0);
    r = feed(d, hold(10, 400), r.t, (a) => rawTwist(a, -1));
    expect(r.out.some((u) => u.flipped)).toBe(false);
    expect(d.ready).toBe(true);
  });
});

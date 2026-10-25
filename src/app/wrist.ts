/**
 * EXPERIMENTAL: wrist twist (Meta Neural Band) → open search.
 *
 * API source (official docs, "Wrist orientation", Web Apps v1.0):
 *   https://wearables.developer.meta.com/docs/develop/webapps/build/wrist/
 *   (llms.txt: products/webapps/sections/guides/build/wrist)
 *
 * What the docs say and what this file relies on:
 *   - the band is a W3C Generic Sensor `RelativeOrientationSensor`, selected
 *     with `{ sensorId: 'emg-wrist' }`; `onreading` exposes `quaternion` and
 *     `timestamp`;
 *   - feature-detect with the runtime's `RelativeOrientationSensor.__imuQuatWrapped === true`
 *     marker, not with `'RelativeOrientationSensor' in window` alone: desktop
 *     Chromium has its own constructor that ignores `sensorId` and would
 *     subscribe to the host device. The marker lands a few hundred ms after
 *     load, so poll for a few seconds;
 *   - on current builds the components arrive w-first `[w, x, y, z]`, not in
 *     W3C order: reorder once, here (`toW3C`);
 *   - roll = twist about the forearm axis (local +Y): `2 * atan2(q·Y, w)`;
 *   - the sensor is relative (no magnetometer, heading drifts): measure roll
 *     as an offset from a reference you capture yourself;
 *   - the frame may invert early in a stream while the runtime learns which
 *     wrist the band is on: do not capture a reference until readings are stable;
 *   - errors: `NotAllowedError` (permission denied/revoked), `NotReadableError`
 *     (cannot start, often band not worn: retry with backoff); a started
 *     subscription can stay silent, so keep a silence timer > 5 s;
 *   - holding a started sensor makes the band stream continuously (battery):
 *     stop it when not needed (here: when the page is hidden).
 * The docs page does not label the wrist sensor beta; this app still treats
 * the gesture as experimental. Keyboard/double-Up and the Search buttons are
 * always available, so nothing depends on it.
 */

export const DEG = Math.PI / 180;

/** Tunables (degrees / ms). */
export const WRIST_DEFAULTS = {
  /** Roll offset that arms the gesture. */
  thresholdDeg: 50,
  /** Roll offset the wrist must come back under to fire (hysteresis). */
  releaseDeg: 20,
  /** Twist out and back must take at most this long; longer is a posture change. */
  maxGestureMs: 1200,
  /** No second trigger for this long. */
  cooldownMs: 1500,
  /** Ignore everything for this long after the first reading (fusion settling). */
  warmupMs: 1000,
  /** Readings must stay within `settleToleranceDeg` for this long before the reference is captured. */
  settleMs: 1000,
  settleToleranceDeg: 10,
  /** A jump at least this large and this fast is a frame flip, not a wrist: re-settle. */
  flipMinDeg: 35,
  flipRateDegPerS: 1500,
  /** Within this band the reference slowly follows the wrist (drift, slow posture changes). */
  idleBandDeg: 25,
  idleTauMs: 2500,
  /** Held between the idle band and the threshold this long → re-capture the reference. */
  rebaseHoldMs: 1500,
  /** 0 = either direction, 1 / -1 = only positive / negative roll. Either by default: the mirror may never resolve. */
  direction: 0 as -1 | 0 | 1,
};

export type WristConfig = typeof WRIST_DEFAULTS;
export type Quat = readonly [number, number, number, number];

/** Reorders a w-first reading into W3C `[x, y, z, w]`. The one place to change when the platform is corrected. */
export function toW3C(raw: ArrayLike<number> | null | undefined): Quat | null {
  if (!raw || raw.length < 4) return null;
  const q: Quat = [raw[1], raw[2], raw[3], raw[0]];
  if (!q.every(Number.isFinite)) return null;
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  return len > 1e-6 ? q : null;
}

/** Signed twist about the forearm axis (+Y), radians, from a W3C quaternion (docs: "Wrist roll"). */
export function twistAngle(q: Quat): number {
  return 2 * Math.atan2(q[1], q[3]);
}

/** Wraps to [-PI, PI). */
export function wrapAngle(a: number): number {
  const x = (a + Math.PI) % (2 * Math.PI);
  return (x < 0 ? x + 2 * Math.PI : x) - Math.PI;
}

export type WristPhase = 'settling' | 'idle' | 'armed' | 'cooldown';

export interface WristUpdate {
  phase: WristPhase;
  /** Roll offset from the reference in degrees, or null while settling. */
  rollDeg: number | null;
  triggered: boolean;
  /** A frame flip was detected on this reading. */
  flipped: boolean;
}

/**
 * Pure gesture state machine: feed it raw readings and timestamps.
 *
 * settling → (stable for settleMs after warmup) idle → (|roll| ≥ threshold)
 * armed → (|roll| ≤ release within maxGestureMs) trigger + cooldown.
 */
export class WristRollDetector {
  readonly config: WristConfig;
  private phase: 'settling' | 'idle' | 'armed' = 'settling';
  private startT: number | null = null;
  private lastT: number | null = null;
  private lastAngle: number | null = null;
  private anchor: number | null = null;
  private stableSince = 0;
  private reference = 0;
  private armedAt = 0;
  private outsideSince: number | null = null;
  private cooldownUntil = Number.NEGATIVE_INFINITY;

  constructor(config: Partial<WristConfig> = {}) {
    this.config = { ...WRIST_DEFAULTS, ...config };
  }

  get ready(): boolean {
    return this.phase !== 'settling';
  }

  reset(): void {
    this.phase = 'settling';
    this.startT = this.lastT = this.lastAngle = this.anchor = null;
    this.outsideSince = null;
    this.cooldownUntil = Number.NEGATIVE_INFINITY;
  }

  push(raw: ArrayLike<number> | null | undefined, t: number): WristUpdate {
    const c = this.config;
    const q = toW3C(raw);
    if (!q) return this.update(null, false, false, t);
    const a = twistAngle(q);
    if (this.startT === null) this.startT = t;
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);

    if (this.lastAngle !== null) {
      const jump = Math.abs(wrapAngle(a - this.lastAngle)) / DEG;
      if (jump >= c.flipMinDeg && (dt <= 0 || jump / (dt / 1000) >= c.flipRateDegPerS)) {
        // The frame settling (wrist mirror engaging), not the wearer: start over.
        this.phase = 'settling';
        this.anchor = a;
        this.stableSince = t;
        this.lastAngle = a;
        this.lastT = t;
        return this.update(null, false, true, t);
      }
    }
    this.lastAngle = a;
    this.lastT = t;

    if (this.phase === 'settling') {
      if (this.anchor === null || Math.abs(wrapAngle(a - this.anchor)) / DEG > c.settleToleranceDeg) {
        this.anchor = a;
        this.stableSince = t;
      }
      if (t - this.startT >= c.warmupMs && t - this.stableSince >= c.settleMs) {
        this.reference = a;
        this.phase = 'idle';
        this.outsideSince = null;
      }
      return this.update(this.phase === 'idle' ? 0 : null, false, false, t);
    }

    const roll = wrapAngle(a - this.reference) / DEG;
    const abs = Math.abs(roll);
    let triggered = false;

    if (this.phase === 'armed') {
      if (abs <= c.releaseDeg) {
        if (t - this.armedAt <= c.maxGestureMs) {
          triggered = true;
          this.cooldownUntil = t + c.cooldownMs;
        }
        this.phase = 'idle';
      } else if (t - this.armedAt > c.maxGestureMs) {
        // Held, not flicked: adopt the new posture as the reference.
        this.reference = a;
        this.phase = 'idle';
      }
      return this.update(roll, triggered, false, t);
    }

    // idle
    const directionOk = c.direction === 0 || Math.sign(roll) === c.direction;
    if (abs >= c.thresholdDeg && directionOk && t >= this.cooldownUntil) {
      this.phase = 'armed';
      this.armedAt = t;
      this.outsideSince = null;
    } else if (abs < c.idleBandDeg) {
      // Slowly re-capture the reference while the wrist is idle (drift).
      const k = 1 - Math.exp(-dt / c.idleTauMs);
      this.reference = wrapAngle(this.reference + wrapAngle(a - this.reference) * k);
      this.outsideSince = null;
    } else {
      this.outsideSince ??= t;
      if (t - this.outsideSince >= c.rebaseHoldMs) {
        this.reference = a;
        this.outsideSince = null;
      }
    }
    return this.update(roll, false, false, t);
  }

  private update(rollDeg: number | null, triggered: boolean, flipped: boolean, t: number): WristUpdate {
    const phase: WristPhase =
      this.phase === 'idle' && t < this.cooldownUntil ? 'cooldown' : this.phase;
    return { phase, rollDeg: this.phase === 'settling' ? null : rollDeg, triggered, flipped };
  }
}

// ---------------------------------------------------------------- runtime

export type WristStatus = 'checking' | 'unavailable' | 'off' | 'starting' | 'settling' | 'on' | 'denied' | 'error';

interface SensorLike {
  quaternion?: ArrayLike<number> | null;
  timestamp?: number | null;
  onreading: ((this: SensorLike) => void) | null;
  onerror: ((this: SensorLike, event: { error?: { name?: string } }) => void) | null;
  start(): void;
  stop(): void;
}
type SensorCtor = (new (options: { sensorId: string; frequency?: number }) => SensorLike) & { __imuQuatWrapped?: boolean };

/** Docs-recommended detection: the runtime marker, not the bare constructor. */
export function hasWristSensor(win: unknown = globalThis): boolean {
  const Ctor = (win as { RelativeOrientationSensor?: SensorCtor }).RelativeOrientationSensor;
  return typeof Ctor === 'function' && Ctor.__imuQuatWrapped === true;
}

export interface WristGestureOptions {
  enabled: boolean;
  onTrigger: () => void;
  onStatus: (status: WristStatus, detail?: string) => void;
  onPhase?: (update: WristUpdate) => void;
  config?: Partial<WristConfig>;
}

const MARKER_WAIT_MS = 5000;
const MARKER_POLL_MS = 250;
const SILENCE_MS = 9000;
const MAX_RETRIES = 3;

/** Owns the one sensor subscription; stops it while the page is hidden. Never throws. */
export class WristGesture {
  status: WristStatus = 'checking';
  detail = '';
  private sensor: SensorLike | null = null;
  private detector: WristRollDetector;
  private retries = 0;
  private silence = 0;
  private retryTimer = 0;
  private wanted = true;

  constructor(private options: WristGestureOptions) {
    this.detector = new WristRollDetector(options.config);
    if (!options.enabled) {
      this.set('off', 'disabled (?wrist=0)');
      return;
    }
    this.set('checking');
    void this.waitForMarker().then((found) => {
      if (!found) this.set('unavailable', 'no emg-wrist sensor');
      else this.start();
    });
    document.addEventListener('visibilitychange', () => {
      this.wanted = document.visibilityState !== 'hidden';
      if (!this.wanted) this.stop();
      else if (this.status === 'settling' || this.status === 'on' || this.status === 'starting') this.start();
      else if (this.status === 'error' && this.retries < MAX_RETRIES) this.start();
    });
  }

  private async waitForMarker(): Promise<boolean> {
    const until = performance.now() + MARKER_WAIT_MS;
    while (performance.now() < until) {
      if (hasWristSensor(window)) return true;
      await new Promise((r) => setTimeout(r, MARKER_POLL_MS));
    }
    return hasWristSensor(window);
  }

  private set(status: WristStatus, detail = ''): void {
    if (status === this.status && detail === this.detail) return;
    this.status = status;
    this.detail = detail;
    this.options.onStatus(status, detail);
  }

  private start(): void {
    if (this.sensor || !this.wanted) return;
    const Ctor = (window as unknown as { RelativeOrientationSensor?: SensorCtor }).RelativeOrientationSensor;
    if (!Ctor) return this.set('unavailable', 'no constructor');
    let sensor: SensorLike;
    try {
      sensor = new Ctor({ sensorId: 'emg-wrist' });
    } catch (error) {
      return this.set('unavailable', (error as Error)?.name ?? 'construct failed');
    }
    this.detector.reset();
    sensor.onreading = () => {
      this.armSilence();
      const update = this.detector.push(sensor.quaternion, sensor.timestamp ?? performance.now());
      this.retries = 0;
      this.set(this.detector.ready ? 'on' : 'settling');
      this.options.onPhase?.(update);
      if (update.triggered) this.options.onTrigger();
    };
    sensor.onerror = (event) => {
      const name = event?.error?.name ?? 'Error';
      this.stop();
      if (name === 'NotAllowedError') this.set('denied', 'sensor permission denied');
      else this.retry(name);
    };
    this.sensor = sensor;
    this.set('starting');
    try {
      sensor.start();
      this.armSilence();
    } catch (error) {
      this.stop();
      this.retry((error as Error)?.name ?? 'start failed');
    }
  }

  private stop(): void {
    window.clearTimeout(this.silence);
    window.clearTimeout(this.retryTimer);
    if (!this.sensor) return;
    const sensor = this.sensor;
    this.sensor = null;
    sensor.onreading = null;
    sensor.onerror = null;
    try {
      sensor.stop();
    } catch {
      // ignore
    }
  }

  private armSilence(): void {
    window.clearTimeout(this.silence);
    this.silence = window.setTimeout(() => {
      this.stop();
      this.retry('silent');
    }, SILENCE_MS);
  }

  /** NotReadableError / silence: retry with backoff (2, 4, 8 s), then give up quietly. */
  private retry(reason: string): void {
    if (this.retries >= MAX_RETRIES) return this.set('error', reason);
    const delay = 2000 * 2 ** this.retries++;
    this.set('error', `${reason}, retrying`);
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.start(), delay);
  }
}

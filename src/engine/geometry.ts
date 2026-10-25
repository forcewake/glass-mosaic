/**
 * Geometry helpers for the glass field.
 *
 * These are verbatim ports of the recovered renderer math (`$e`, `et`, `tt`,
 * `nt`, `rt`, `Tt`, `it`, `at`, `ot`, `Nt`, `Mt`, `Ot`, `Dt`, `kt`, `At`,
 * `jt`, `Ht`, `wt`). The index arithmetic is preserved exactly, including the
 * places where the original mixes column-major and row-major conventions, so
 * the rendered result is identical to the reference.
 */

/** A 3x3 matrix stored as 9 numbers. */
export type Mat3 = number[];

/** A unit quaternion `[x, y, z, w]`. */
export type Quaternion = [number, number, number, number];

/** The camera state shared by the renderer, the layout and the DOM labels. */
export interface CameraState {
  perspective: number;
  radius: number;
  orbit: Mat3;
  shift: number;
}

/** A placed card in world space. */
export interface CardPose {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  q: Quaternion;
  opacity?: number;
  hover?: number;
  lens?: number;
  dispersion?: number;
  shape?: CardShape;
  sphereRadius?: number;
  focused?: boolean;
  depthWrite?: boolean;
  id?: string;
  instanceKey?: string;
  source?: CanvasImageSource | undefined;
  sourceVersion?: string;
  aspect?: number;
}

export interface CardShape {
  radius: number;
  bevel: number;
  thickness: number;
  rim: number;
}

export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/** Smoothstep easing, used by the entrance and focus animations. */
export const smoothstep = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Quintic smootherstep, used by the card entrance. */
export const smootherstep = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/**
 * Builds the orbit matrix for a pitch/yaw pair.
 *
 * Port of `$e`. The result is a column-major 3x3 matrix, which is what WebGL
 * expects for `uniformMatrix3fv`.
 */
export function orbitMatrix(pitch: number, yaw: number): Mat3 {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return [cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy];
}

/** Matrix product, port of `et`. */
export function multiplyMat3(a: Mat3, b: readonly number[]): Mat3 {
  return [
    a[0] * b[0] + a[3] * b[1] + a[6] * b[2],
    a[1] * b[0] + a[4] * b[1] + a[7] * b[2],
    a[2] * b[0] + a[5] * b[1] + a[8] * b[2],
  ];
}

/** Matrix-vector product, port of `wt`. */
export function multiplyMat3Vector(a: Mat3, v: readonly number[]): number[] {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}

/** Transpose, port of `tt`. */
export function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** CSS `matrix3d()` string, port of `nt`. */
export function toCssMatrix3d(m: Mat3): string {
  return `matrix3d(${m[0]},${m[1]},${m[2]},0,${m[3]},${m[4]},${m[5]},0,${m[6]},${m[7]},${m[8]},0,0,0,0,1)`;
}

/** Quaternion to 3x3 matrix, port of `rt`. */
export function quaternionToMatrix(q: readonly number[]): Mat3 {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
  ];
}

/** 3x3 matrix to quaternion, port of `Tt`. */
export function matrixToQuaternion(m: Mat3): Quaternion {
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  const trace = m[0] + m[4] + m[8];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m[5] - m[7]) / s;
    y = (m[6] - m[2]) / s;
    z = (m[1] - m[3]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    w = (m[5] - m[7]) / s;
    x = s / 4;
    y = (m[3] + m[1]) / s;
    z = (m[6] + m[2]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    w = (m[6] - m[2]) / s;
    x = (m[3] + m[1]) / s;
    y = s / 4;
    z = (m[7] + m[5]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    w = (m[1] - m[3]) / s;
    x = (m[6] + m[2]) / s;
    y = (m[7] + m[5]) / s;
    z = s / 4;
  }
  const length = Math.hypot(x, y, z, w);
  return [x / length, y / length, z / length, w / length];
}

/** Quaternion product, port of `kt`. */
export function quaternionMultiply(a: readonly number[], b: readonly number[]): Quaternion {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Rotates a quaternion by a matrix, port of `Ht`. */
export function rotateQuaternion(m: Mat3, q: readonly number[]): Mat3 {
  return Array.from({ length: 9 }, (_, r) => {
    const i = r % 3;
    const a = Math.floor(r / 3) * 3;
    return m[i] * q[a] + m[i + 3] * q[a + 1] + m[i + 6] * q[a + 2];
  }) as Mat3;
}

/** Spherical placement of a card, port of `it`. */
export function spherePlacement(x: number, y: number, radius: number): { position: number[]; q: Quaternion } {
  const rx = x / radius;
  const ry = y / radius;
  const dir = [Math.sin(rx) * Math.cos(ry), Math.sin(ry), Math.cos(rx) * Math.cos(ry)];
  const axis = [-dir[1], dir[0], 0, 1 + dir[2]];
  const length = Math.hypot(...axis);
  const q: Quaternion = length > 1e-12 ? [axis[0] / length, axis[1] / length, 0, axis[3] / length] : [1, 0, 0, 0];
  return { position: [dir[0] * radius, dir[1] * radius, (dir[2] - 1) * radius], q };
}

/**
 * Screen point -> world point on the focal sphere.
 *
 * Port of `at`. Used to keep the zoom anchored under the pointer.
 */
export function screenToSphere(x: number, y: number, camera: CameraState): [number, number] {
  const inverse = transposeMat3(camera.orbit);
  const center = multiplyMat3(inverse, [0, 0, camera.perspective - camera.shift]);
  const ray = multiplyMat3(inverse, [x / camera.perspective, y / camera.perspective, -1]);
  const shifted = [center[0], center[1], center[2] + camera.radius];
  const a = ray.reduce((sum, value) => sum + value * value, 0);
  const b = 2 * shifted.reduce((sum, value, index) => sum + value * ray[index], 0);
  const c = shifted.reduce((sum, value) => sum + value * value, 0) - camera.radius * camera.radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [x, y];
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  const hit = center.map((value, index) => value + ray[index] * t);
  return [
    Math.atan2(hit[0], hit[2] + camera.radius) * camera.radius,
    Math.asin(clamp(hit[1] / camera.radius, -1, 1)) * camera.radius,
  ];
}

/** World point -> screen point, port of `ot`. */
export function projectToScreen(
  world: readonly number[],
  camera: CameraState,
  width: number,
  height: number,
): { x: number; y: number; depth: number } {
  const transformed = multiplyMat3(camera.orbit, world);
  transformed[2] += camera.shift;
  const depth = camera.perspective - transformed[2];
  return {
    x: width / 2 + (transformed[0] * camera.perspective) / depth,
    y: height / 2 + (transformed[1] * camera.perspective) / depth,
    depth,
  };
}

/** The glass shape of a card, port of `Nt`. */
export function cardShape(width: number, height: number): CardShape {
  return {
    radius: Math.min(width * 0.163, Math.min(width, height) * 0.5),
    bevel: width * 0.192,
    thickness: (155 * width) / 656,
    rim: (10 * width) / 656,
  };
}

/** The glass shape of the focused card, port of `Mt`. */
export function focusShape(camera: CameraState, compact = false): CardShape {
  const scale = Math.max(Math.max(1, camera.perspective * 0.05) * 2, camera.perspective * 0.32) / camera.perspective;
  return {
    radius: (compact ? 12 : 18) * scale,
    bevel: 22 * scale,
    thickness: 18 * scale,
    rim: 2 * scale,
  };
}

/** The pose the focused card animates towards, port of `Et`. */
export function focusTarget(
  camera: CameraState,
  width: number,
  height: number,
  margin = width < 650 ? 10 : 16,
  aspect?: number,
): CardPose {
  let availableWidth = Math.max(1, width - 2 * margin);
  let availableHeight = Math.max(1, height - 2 * margin);
  if (aspect && Number.isFinite(aspect) && aspect > 0) {
    const scale = Math.min(availableWidth / aspect, availableHeight);
    availableWidth = scale * aspect;
    availableHeight = scale;
  }
  const near = Math.max(1, camera.perspective * 0.05);
  const depth = Math.max(near * 2, camera.perspective * 0.32);
  const cardWidth = (availableWidth * depth) / camera.perspective;
  const cardHeight = (availableHeight * depth) / camera.perspective;
  const center = multiplyMat3Vector(camera.orbit, [0, 0, camera.perspective - depth - camera.shift]);
  const rotation = matrixToQuaternion(camera.orbit);
  return {
    x: center[0],
    y: center[1],
    z: center[2],
    w: cardWidth,
    h: cardHeight,
    q: [-rotation[0], -rotation[1], -rotation[2], rotation[3]],
    sphereRadius: Math.max(cardWidth, cardHeight) * 1e6,
  };
}

/** Spherical interpolation of two quaternions, port of `Dt`. */
export function slerpQuaternion(a: readonly number[], b: readonly number[], t: number): Quaternion {
  const amount = clamp(t, 0, 1);
  let dot = a.reduce((sum, value, index) => sum + value * b[index], 0);
  const sign = dot < 0 ? -1 : 1;
  dot = clamp(Math.abs(dot), 0, 1);
  let weightA = 1 - amount;
  let weightB = amount;
  if (dot < 0.9995) {
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    weightA = Math.sin((1 - amount) * theta) / sinTheta;
    weightB = Math.sin(amount * theta) / sinTheta;
  }
  const mixed = a.map((value, index) => value * weightA + sign * b[index] * weightB);
  const length = Math.hypot(...mixed);
  return [mixed[0] / length, mixed[1] / length, mixed[2] / length, mixed[3] / length];
}

/** Interpolates two card poses, port of `Ot`. */
export function interpolateCard(from: CardPose, to: CardPose, t: number): CardPose {
  const amount = clamp(t, 0, 1);
  const mix = (a: number, b: number) => a + (b - a) * amount;
  if (amount === 0) return { ...from };
  if (amount === 1) return { ...to };
  const radius = mix(1 / (from.sphereRadius ?? 5000), 1 / (to.sphereRadius ?? 5000));
  return {
    ...from,
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    z: mix(from.z, to.z),
    w: mix(from.w, to.w),
    h: mix(from.h, to.h),
    q: slerpQuaternion(from.q, to.q, amount),
    sphereRadius: 1 / Math.max(radius, 1e-12),
  };
}

/** Applies the camera orbit to a card, port of `At`. */
export function applyOrbit(card: CardPose, camera: CameraState): CardPose {
  const m = camera.orbit;
  const { x, y, z } = card;
  return {
    ...card,
    x: m[0] * x + m[3] * y + m[6] * z,
    y: m[1] * x + m[4] * y + m[7] * z,
    z: m[2] * x + m[5] * y + m[8] * z + camera.shift,
    q: quaternionMultiply(matrixToQuaternion(m), card.q),
  };
}

/** Applies the inverse camera orbit to a card, port of `jt`. */
export function applyInverseOrbit(card: CardPose, camera: CameraState): CardPose {
  const world = multiplyMat3Vector(camera.orbit, [card.x, card.y, card.z - camera.shift]);
  const rotation = matrixToQuaternion(camera.orbit);
  return {
    ...card,
    x: world[0],
    y: world[1],
    z: world[2],
    q: quaternionMultiply([-rotation[0], -rotation[1], -rotation[2], rotation[3]], card.q),
  };
}

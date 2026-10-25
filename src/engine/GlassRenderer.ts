/**
 * The WebGL2 glass renderer.
 *
 * Ported from embed-anything's `src/engine/GlassRenderer.ts` (MIT):
 *   - a single instanced program with the GLSL 300 ES glass shaders,
 *   - a `TEXTURE_2D_ARRAY` cache of the card bitmaps,
 *   - a dedicated 2D texture for the focused card,
 *   - an RGBE environment map for the reflections.
 *
 * Glasses edition changes:
 *   - texture layers are 320x240 (160x120 when overloaded) and there are 48
 *     of them instead of 640x480 x 96, which keeps GPU memory under ~15 MB;
 *   - the environment is generated procedurally (`studioEnvironment`) instead
 *     of downloading `studio.hdr` from the original Space;
 *   - `powerPreference` is `low-power` and antialiasing is optional.
 */
import { VERTEX_SHADER, FRAGMENT_SHADER } from './shaders';
import type { CameraState, CardPose, CardShape } from './geometry';

/** Maximum number of instances drawn per frame. */
const MAX_INSTANCES = 160;

/** Floats per instance: rect(4) + quaternion(4) + info(4) + shape(4) + surface(4) + dispersion(1). */
const INSTANCE_FLOATS = 21;

/** Byte stride of the instance buffer. */
const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

/** The nominal size of a card texture. */
const TEXTURE_WIDTH = 320;
const TEXTURE_HEIGHT = 240;

/** The nominal number of texture-array layers. */
const TEXTURE_LAYERS = 48;

/** The per-instance attribute offsets, in floats. */
const ATTRIB_OFFSETS = { rect: 0, quaternion: 4, info: 8, shape: 12, surface: 16, dispersion: 20 };

export interface RendererCard extends CardPose {
  /** Unique id of the media item; used as the texture-array key. */
  id: string;
  shape: CardShape;
}

interface TextureSlot {
  index: number;
  source: CanvasImageSource;
  version: string;
  aspect: number;
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  /** Frame counter of the last use, for the LRU eviction. */
  last: number;
}

interface Uniforms {
  viewport: WebGLUniformLocation | null;
  perspective: WebGLUniformLocation | null;
  radius: WebGLUniformLocation | null;
  orbit: WebGLUniformLocation | null;
  shift: WebGLUniformLocation | null;
  images: WebGLUniformLocation | null;
  environment: WebGLUniformLocation | null;
  focusedImage: WebGLUniformLocation | null;
}

interface Mesh {
  vertices: Float32Array;
  indices: Uint16Array;
}

/** Builds a subdivided quad grid. */
function buildMesh(columns = 24, rows = 18): Mesh {
  const vertices = new Float32Array((columns + 1) * (rows + 1) * 2);
  const indices = new Uint16Array(columns * rows * 6);
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const index = (row * (columns + 1) + column) * 2;
      vertices[index] = column / columns - 0.5;
      vertices[index + 1] = row / rows - 0.5;
    }
  }
  let cursor = 0;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const topLeft = row * (columns + 1) + column;
      const bottomLeft = topLeft + columns + 1;
      indices.set([topLeft, topLeft + 1, bottomLeft, bottomLeft, topLeft + 1, bottomLeft + 1], cursor);
      cursor += 6;
    }
  }
  return { vertices, indices };
}

/** Reads the intrinsic size of a canvas image source. */
export function sourceSize(source: CanvasImageSource): { width: number; height: number } {
  const image = source as HTMLImageElement;
  const video = source as HTMLVideoElement;
  const canvas = source as HTMLCanvasElement & { displayWidth?: number; displayHeight?: number };
  const videoFrame = source as VideoFrame;
  return {
    width:
      image.naturalWidth || video.videoWidth || canvas.displayWidth || videoFrame.displayWidth || Number(canvas.width),
    height:
      image.naturalHeight ||
      video.videoHeight ||
      canvas.displayHeight ||
      videoFrame.displayHeight ||
      Number(canvas.height),
  };
}

/** Encodes a linear RGB colour as RGBE (shared exponent in alpha), the format the shader decodes. */
export function encodeRgbe(r: number, g: number, b: number): [number, number, number, number] {
  const max = Math.max(r, g, b);
  if (max < 1e-32) return [0, 0, 0, 0];
  const exponent = Math.ceil(Math.log2(max));
  const scale = 256 / 2 ** exponent;
  return [
    Math.min(255, Math.floor(r * scale)),
    Math.min(255, Math.floor(g * scale)),
    Math.min(255, Math.floor(b * scale)),
    exponent + 128,
  ];
}

/**
 * A small procedural "photo studio" environment (equirectangular, RGBE).
 *
 * Replaces the `studio.hdr` the original fetched from the Hugging Face Space:
 * a dark room with a large soft key light, a cooler fill and a thin top strip.
 * The reflections on an additive display only need a hint of highlights, so a
 * 128x64 map is plenty.
 */
export function studioEnvironment(width = 128, height = 64): { width: number; height: number; pixels: Uint8Array } {
  const pixels = new Uint8Array(width * height * 4);
  const soft = (u: number, v: number, cu: number, cv: number, su: number, sv: number) => {
    let du = Math.abs(u - cu);
    du = Math.min(du, 1 - du);
    const x = du / su;
    const y = (v - cv) / sv;
    return Math.exp(-(x ** 4 + y ** 4));
  };
  for (let row = 0; row < height; row++) {
    const v = (row + 0.5) / height;
    for (let column = 0; column < width; column++) {
      const u = (column + 0.5) / width;
      const ambient = 0.025 + 0.05 * v;
      const key = 3.2 * soft(u, v, 0.32, 0.62, 0.09, 0.16);
      const fill = 1.1 * soft(u, v, 0.78, 0.55, 0.12, 0.2);
      const strip = 1.6 * soft(u, v, 0.55, 0.92, 0.3, 0.03);
      const rgbe = encodeRgbe(ambient + key + fill * 0.8 + strip, ambient + key + fill * 0.92 + strip, ambient * 1.1 + key * 0.96 + fill + strip);
      pixels.set(rgbe, (row * width + column) * 4);
    }
  }
  return { width, height, pixels };
}

export interface GlassRendererOptions {
  /** Called when the WebGL context is lost. */
  onContextLost?: () => void;
  /** Request an antialiased context (off in reduced mode). */
  antialias?: boolean;
}

export class GlassRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private shaders: WebGLShader[] = [];
  private textures: WebGLTexture[] = [];
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: Uniforms;
  private instanceBuffer: WebGLBuffer;

  /** Vertex buffer of the high-resolution field mesh. */
  private fieldVertexBuffer: WebGLBuffer;
  /** Index buffer of the high-resolution field mesh. */
  private fieldIndexBuffer: WebGLBuffer;
  /** Vertex buffer of the low-resolution mesh used by small cards. */
  private focusVertexBuffer: WebGLBuffer;
  /** Index buffer of the low-resolution mesh used by small cards. */
  private focusIndexBuffer: WebGLBuffer;
  private instanceData: Float32Array;
  private instanceSnapshot: Float32Array;
  private lastInstanceCount = -1;

  private fieldMesh: Mesh;
  private focusMesh: Mesh;
  private currentMesh: Mesh;

  private textureArray: WebGLTexture;
  private arrayWidth = TEXTURE_WIDTH;
  private arrayHeight = TEXTURE_HEIGHT;
  private arrayLayers = TEXTURE_LAYERS;
  private maxLayers: number;

  private environmentTexture: WebGLTexture;
  private focusedTexture: WebGLTexture;
  private sourceCanvas: HTMLCanvasElement;
  private sourceContext: CanvasRenderingContext2D;
  private focusCanvas: HTMLCanvasElement;
  private focusContext: CanvasRenderingContext2D;

  private slots = new Map<string, TextureSlot>();
  private batchIds = new Set<string>();
  private frame = 0;
  private disposed = false;
  private contextLost = false;
  private abort = new AbortController();
  private uniforms3x3 = new Float32Array(9);
  private focusedSlot: TextureSlot | null = null;
  private contextLostCallback: (() => void) | undefined;

  constructor(canvas: HTMLCanvasElement, options: GlassRendererOptions = {}) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: options.antialias ?? true,
      powerPreference: 'low-power',
      premultipliedAlpha: true,
    });
    if (!gl) throw new Error('WebGL2 is not available.');
    this.gl = gl;
    this.contextLostCallback = options.onContextLost;

    const program = gl.createProgram();
    if (!program) throw new Error('Glass shader unavailable.');
    this.program = program;

    try {
      for (const [source, type] of [
        [VERTEX_SHADER, gl.VERTEX_SHADER],
        [FRAGMENT_SHADER, gl.FRAGMENT_SHADER],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Glass shader unavailable.');
        this.shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader) || 'Glass shader error');
        }
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || 'Glass program error');
      }

      this.fieldMesh = buildMesh(24, 18);
      this.focusMesh = buildMesh(8, 6);
      this.currentMesh = this.fieldMesh;

      const vao = gl.createVertexArray();
      const fieldVertices = gl.createBuffer();
      const fieldIndices = gl.createBuffer();
      const focusVertices = gl.createBuffer();
      const focusIndices = gl.createBuffer();
      this.instanceBuffer = gl.createBuffer();
      this.arrayWidth = TEXTURE_WIDTH;
      this.arrayHeight = TEXTURE_HEIGHT;
      this.arrayLayers = TEXTURE_LAYERS;
      this.textureArray = gl.createTexture();
      this.environmentTexture = gl.createTexture();
      this.focusedTexture = gl.createTexture();

      if (
        !vao ||
        !fieldVertices ||
        !fieldIndices ||
        !focusVertices ||
        !focusIndices ||
        !this.instanceBuffer ||
        !this.textureArray ||
        !this.environmentTexture ||
        !this.focusedTexture
      ) {
        throw new Error('Glass buffers unavailable');
      }
      this.vao = vao;
      this.fieldVertexBuffer = fieldVertices;
      this.fieldIndexBuffer = fieldIndices;
      this.focusVertexBuffer = focusVertices;
      this.focusIndexBuffer = focusIndices;
      this.textures.push(this.textureArray, this.environmentTexture, this.focusedTexture);

      this.instanceData = new Float32Array(MAX_INSTANCES * INSTANCE_FLOATS);
      this.instanceSnapshot = new Float32Array(this.instanceData.length);

      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, focusVertices);
      gl.bufferData(gl.ARRAY_BUFFER, this.focusMesh.vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, focusIndices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.focusMesh.indices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, fieldVertices);
      gl.bufferData(gl.ARRAY_BUFFER, this.fieldMesh.vertices, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, fieldIndices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.fieldMesh.indices, gl.STATIC_DRAW);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
      for (let location = 1; location <= 6; location++) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, location === 6 ? 1 : 4, gl.FLOAT, false, INSTANCE_STRIDE, (location - 1) * 16);
        gl.vertexAttribDivisor(location, 1);
      }

      this.maxLayers = Math.max(2, Math.min(TEXTURE_LAYERS, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number));

      this.sourceCanvas = document.createElement('canvas');
      const sourceContext = this.sourceCanvas.getContext('2d');
      if (!sourceContext) throw new Error('Glass source canvas unavailable');
      this.sourceContext = sourceContext;

      this.focusCanvas = document.createElement('canvas');
      const focusContext = this.focusCanvas.getContext('2d');
      if (!focusContext) throw new Error('Glass focus canvas unavailable');
      this.focusContext = focusContext;

      this.initArrayTexture();
      this.initTextures();

      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);

      const uniform = (name: string) => gl.getUniformLocation(program, name);
      this.uniforms = {
        viewport: uniform('uViewport'),
        perspective: uniform('uPerspective'),
        radius: uniform('uRadius'),
        orbit: uniform('uOrbit'),
        shift: uniform('uShift'),
        images: uniform('uImages'),
        environment: uniform('uEnvironment'),
        focusedImage: uniform('uFocusedImage'),
      };
      gl.useProgram(program);
      gl.uniform1i(this.uniforms.images, 0);
      gl.uniform1i(this.uniforms.environment, 1);
      gl.uniform1i(this.uniforms.focusedImage, 2);

      canvas.addEventListener('webglcontextlost', this.handleContextLost);
      this.uploadEnvironment(studioEnvironment());
    } catch (error) {
      this.abort.abort();
      this.releaseResources();
      throw error;
    }
  }

  /** Allocates the texture array and fills its first layer with a placeholder. */
  private initArrayTexture() {
    const gl = this.gl;
    this.sourceCanvas.width = this.arrayWidth;
    this.sourceCanvas.height = this.arrayHeight;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, this.arrayWidth, this.arrayHeight, this.arrayLayers);
    for (const [key, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ] as const) {
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, key, value);
    }
    const gradient = this.sourceContext.createLinearGradient(0, 0, this.arrayWidth, this.arrayHeight);
    gradient.addColorStop(0, '#1d2629');
    gradient.addColorStop(1, '#101618');
    this.sourceContext.fillStyle = gradient;
    this.sourceContext.fillRect(0, 0, this.arrayWidth, this.arrayHeight);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY,
      0,
      0,
      0,
      0,
      this.arrayWidth,
      this.arrayHeight,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.sourceCanvas,
    );
  }

  /** Creates the environment and focused-image textures. */
  private initTextures() {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.environmentTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([60, 65, 70, 128]));
    for (const [key, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.REPEAT],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ] as const) {
      gl.texParameteri(gl.TEXTURE_2D, key, value);
    }

    gl.activeTexture(gl.TEXTURE0 + 2);
    gl.bindTexture(gl.TEXTURE_2D, this.focusedTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    for (const [key, value] of [
      [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
      [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
      [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
    ] as const) {
      gl.texParameteri(gl.TEXTURE_2D, key, value);
    }
  }

  /** Uploads the procedural RGBE environment map. */
  private uploadEnvironment(decoded: { width: number; height: number; pixels: Uint8Array }) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.environmentTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, decoded.width, decoded.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, decoded.pixels);
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    this.abort.abort();
    this.contextLostCallback?.();
  };

  /** Resizes the drawing buffer. */
  resize(width: number, height: number, pixelRatio = 1) {
    if (this.disposed || this.contextLost) return;
    const max = this.gl.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) as number;
    const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
    const w = Math.max(1, Math.min(max, Math.round(width * ratio)));
    const h = Math.max(1, Math.min(max, Math.round(height * ratio)));
    const canvas = this.gl.canvas as HTMLCanvasElement;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }

  /** True when the card is small enough for the low-resolution mesh. */
  private isSmall(card: RendererCard): boolean {
    return Math.max(card.w, card.h) <= 180;
  }

  /**
   * Grows or shrinks the texture array depending on how many distinct cards
   * are on screen.
   */
  private adjustTextureArray(cards: RendererCard[]) {
    if (cards.some((card) => card.focused)) return;
    const distinct = new Set(cards.map((card) => card.id)).size;
    const overloaded = distinct > this.arrayLayers - 1;
    if (!overloaded && this.arrayWidth < TEXTURE_WIDTH && distinct > (TEXTURE_LAYERS - 1) * 0.75) return;
    const width = overloaded ? TEXTURE_WIDTH / 2 : TEXTURE_WIDTH;
    if (this.arrayWidth === width) return;
    const texture = this.gl.createTexture();
    if (!texture) return;
    const previous = this.textureArray;
    this.textures[this.textures.indexOf(previous)] = texture;
    this.textureArray = texture;
    this.arrayWidth = width;
    this.arrayHeight = overloaded ? TEXTURE_HEIGHT / 2 : TEXTURE_HEIGHT;
    this.arrayLayers = overloaded ? Math.min(TEXTURE_LAYERS * 4, this.maxLayers) : TEXTURE_LAYERS;
    this.initArrayTexture();
    this.gl.deleteTexture(previous);
    this.slots.clear();
  }

  /** Assigns a texture-array layer to a card and uploads its bitmap. */
  private uploadCard(card: RendererCard): TextureSlot | undefined {
    const existing = this.slots.get(card.id);
    if (existing) existing.last = this.frame;
    if (!card.source || (existing && existing.source === card.source && existing.version === card.sourceVersion)) {
      return existing;
    }
    const size = sourceSize(card.source);
    if (!(size.width > 0 && size.height > 0)) return existing;

    let evictKey: string | undefined;
    let layer = existing?.index;
    if (layer === undefined) {
      if (this.slots.size < this.arrayLayers - 1) {
        const used = new Set(Array.from(this.slots.values()).map((slot) => slot.index));
        for (let candidate = 1; candidate < this.arrayLayers; candidate++) {
          if (!used.has(candidate)) {
            layer = candidate;
            break;
          }
        }
      } else {
        let oldest = Infinity;
        for (const [key, slot] of this.slots) {
          if (!this.batchIds.has(key) && slot.last < oldest) {
            evictKey = key;
            oldest = slot.last;
            layer = slot.index;
          }
        }
      }
    }
    if (layer === undefined) return existing;

    const aspect =
      Number.isFinite(card.aspect) && (card.aspect ?? 0) > 0 ? (card.aspect as number) : size.width / size.height;
    const textureAspect = this.arrayWidth / this.arrayHeight;
    const drawWidth = Math.max(2, 2 * Math.round((this.arrayWidth * Math.min(1, aspect / textureAspect)) / 2));
    const drawHeight = Math.max(2, 2 * Math.round((this.arrayHeight * Math.min(1, textureAspect / aspect)) / 2));
    const offsetX = (this.arrayWidth - drawWidth) / 2;
    const offsetY = (this.arrayHeight - drawHeight) / 2;
    const scaleX = drawWidth / this.arrayWidth;
    const scaleY = drawHeight / this.arrayHeight;

    try {
      this.sourceContext.clearRect(0, 0, this.arrayWidth, this.arrayHeight);
      this.sourceContext.drawImage(card.source, offsetX, offsetY, drawWidth, drawHeight);
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,
        0,
        0,
        layer,
        this.arrayWidth,
        this.arrayHeight,
        1,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.sourceCanvas,
      );
    } catch {
      this.sourceCanvas.width = this.arrayWidth;
      this.sourceCanvas.height = this.arrayHeight;
      return existing;
    }

    if (evictKey !== undefined) this.slots.delete(evictKey);
    const slot: TextureSlot = {
      index: layer,
      source: card.source,
      version: card.sourceVersion ?? '',
      aspect,
      width: size.width,
      height: size.height,
      scaleX,
      scaleY,
      last: this.frame,
    };
    this.slots.set(card.id, slot);
    return slot;
  }

  /** Uploads the focused card into its dedicated texture. */
  private updateFocusedTexture(card: RendererCard) {
    const source = card.source;
    if (!source || !card.focused) return;
    const size = sourceSize(source);
    if (!(size.width > 0 && size.height > 0)) return;
    const max = Math.min(1024, this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number);
    const scale = Math.min(1, max / Math.max(size.width, size.height));
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    if (this.focusCanvas.width !== width) this.focusCanvas.width = width;
    if (this.focusCanvas.height !== height) this.focusCanvas.height = height;
    try {
      this.focusContext.drawImage(source, 0, 0, width, height);
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + 2);
      gl.bindTexture(gl.TEXTURE_2D, this.focusedTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.focusCanvas);
      this.focusedSlot = {
        index: -1,
        source,
        version: card.sourceVersion ?? '',
        aspect: size.width / size.height,
        width,
        height,
        scaleX: 1,
        scaleY: 1,
        last: this.frame,
      };
    } catch {
      this.focusCanvas.width = width;
      this.focusCanvas.height = height;
    }
  }

  /** Draws one frame. */
  render(cards: RendererCard[], camera: CameraState, width: number, height: number) {
    if (this.disposed || this.contextLost || this.gl.isContextLost()) return;
    const gl = this.gl;
    this.frame++;

    let list = cards;
    if (list.some((card) => (card.opacity ?? 1) < 0.01)) {
      list = list.filter((card) => (card.opacity ?? 1) >= 0.01);
    }
    const isOpaque = (card: RendererCard) => (card.opacity ?? 1) >= 1 && card.depthWrite !== false;
    const opaque = list.filter(isOpaque);
    list = [
      ...opaque.filter((card) => this.isSmall(card)),
      ...opaque.filter((card) => !this.isSmall(card)),
      ...list.filter((card) => !isOpaque(card)),
    ];
    if (list.length > MAX_INSTANCES) list = list.slice(0, MAX_INSTANCES);

    this.adjustTextureArray(list);

    const total = list.length;
    const opaqueEnd = Math.min(opaque.length, total);
    for (let i = 0; i < 9; i++) this.uniforms3x3[i] = camera.orbit[i];

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.uniforms.viewport, Math.max(1, width), Math.max(1, height));
    gl.uniform1f(this.uniforms.perspective, camera.perspective);
    gl.uniform1f(this.uniforms.radius, camera.radius);
    gl.uniform1f(this.uniforms.shift, camera.shift);
    gl.uniformMatrix3fv(this.uniforms.orbit, false, this.uniforms3x3);
    gl.viewport(0, 0, (gl.canvas as HTMLCanvasElement).width, (gl.canvas as HTMLCanvasElement).height);
    gl.clearColor(0, 0, 0, 0);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.textureArray);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.environmentTexture);
    gl.activeTexture(gl.TEXTURE0 + 2);
    gl.bindTexture(gl.TEXTURE_2D, this.focusedTexture);

    const drawRange = (start: number, end: number, depthWrite: boolean) => {
      gl.depthMask(depthWrite);
      let cursor = start;
      while (cursor < end) {
        const mesh = this.isSmall(list[cursor]) ? this.focusMesh : this.fieldMesh;
        let next = cursor + 1;
        while (next < end && (this.isSmall(list[next]) ? this.focusMesh : this.fieldMesh) === mesh) next++;
        this.bindMesh(mesh);
        this.bindInstanceOffset(cursor);
        gl.drawElementsInstanced(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0, next - cursor);
        cursor = next;
      }
    };

    let batchStart = 0;
    while (batchStart < total) {
      this.batchIds.clear();
      let batchEnd = batchStart;
      while (batchEnd < total) {
        const id = list[batchEnd].id;
        if (!this.batchIds.has(id) && this.batchIds.size === this.arrayLayers - 1) break;
        this.batchIds.add(id);
        batchEnd++;
      }

      // Upload the textures of this batch, most recently used first.
      const seen = new Set<string>();
      for (let i = batchEnd - 1; i >= batchStart; i--) {
        const id = list[i].id;
        if (seen.has(id)) continue;
        seen.add(id);
        this.uploadCard(list[i]);
      }

      for (let i = batchStart; i < batchEnd; i++) {
        const card = list[i];
        this.updateFocusedTexture(card);
        const base = i * INSTANCE_FLOATS;
        const slot = this.slots.get(card.id);
        const focused = card.focused && this.focusedSlot?.source === card.source ? this.focusedSlot : undefined;
        const data = this.instanceData;
        data[base + ATTRIB_OFFSETS.rect] = card.x;
        data[base + ATTRIB_OFFSETS.rect + 1] = card.y;
        data[base + ATTRIB_OFFSETS.rect + 2] = card.w;
        data[base + ATTRIB_OFFSETS.rect + 3] = card.h;
        for (let k = 0; k < 4; k++) data[base + ATTRIB_OFFSETS.quaternion + k] = card.q[k];
        data[base + ATTRIB_OFFSETS.info] = card.z;
        data[base + ATTRIB_OFFSETS.info + 1] = focused ? -1 : (slot?.index ?? 0);
        data[base + ATTRIB_OFFSETS.info + 2] = Math.max(0, Math.min(1, card.opacity ?? 1));
        data[base + ATTRIB_OFFSETS.info + 3] =
          card.lens === undefined ? (card.hover ?? 0) : -1 - Math.max(0, Math.min(1, card.lens));
        data[base + ATTRIB_OFFSETS.shape] = card.shape?.radius ?? 0.163 * card.w;
        data[base + ATTRIB_OFFSETS.shape + 1] = Math.max(0.001, card.shape?.bevel ?? 0.192 * card.w);
        data[base + ATTRIB_OFFSETS.shape + 2] = card.shape?.thickness ?? (155 * card.w) / 656;
        data[base + ATTRIB_OFFSETS.shape + 3] = Math.max(0.001, card.shape?.rim ?? (10 * card.w) / 656);
        data[base + ATTRIB_OFFSETS.surface] = card.sphereRadius ?? 0;
        data[base + ATTRIB_OFFSETS.surface + 1] = focused?.aspect ?? slot?.aspect ?? 4 / 3;
        data[base + ATTRIB_OFFSETS.surface + 2] = focused ? 1 : (slot?.scaleX ?? 1);
        data[base + ATTRIB_OFFSETS.surface + 3] = focused ? 1 : (slot?.scaleY ?? 1);
        data[base + ATTRIB_OFFSETS.dispersion] = Math.max(0, Math.min(1, card.dispersion ?? 1));
      }

      // Only upload the instance buffer when something actually changed.
      let dirty = this.lastInstanceCount !== batchEnd;
      if (!dirty) {
        for (let i = batchStart * INSTANCE_FLOATS; i < batchEnd * INSTANCE_FLOATS; i++) {
          if (this.instanceData[i] !== this.instanceSnapshot[i]) {
            dirty = true;
            break;
          }
        }
      }
      if (dirty) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.bufferSubData(
          gl.ARRAY_BUFFER,
          batchStart * INSTANCE_FLOATS * 4,
          this.instanceData.subarray(batchStart * INSTANCE_FLOATS, batchEnd * INSTANCE_FLOATS),
        );
        this.instanceSnapshot.set(
          this.instanceData.subarray(batchStart * INSTANCE_FLOATS, batchEnd * INSTANCE_FLOATS),
          batchStart * INSTANCE_FLOATS,
        );
        this.lastInstanceCount = batchEnd;
      }

      drawRange(batchStart, Math.min(batchEnd, opaqueEnd), true);
      drawRange(Math.max(batchStart, opaqueEnd), batchEnd, false);
      batchStart = batchEnd;
    }

    gl.depthMask(true);
    this.bindInstanceOffset(0);
  }

  /** Switches the mesh bound to attribute 0. */
  private bindMesh(mesh: Mesh) {
    if (this.currentMesh === mesh) return;
    this.currentMesh = mesh;
    const gl = this.gl;
    const isFocus = mesh === this.focusMesh;
    gl.bindBuffer(gl.ARRAY_BUFFER, isFocus ? this.focusVertexBuffer : this.fieldVertexBuffer);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, isFocus ? this.focusIndexBuffer : this.fieldIndexBuffer);
  }

  /** Points the instance attributes at the given instance index. */
  private bindInstanceOffset(index: number) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    for (let location = 1; location <= 6; location++) {
      gl.vertexAttribPointer(
        location,
        location === 6 ? 1 : 4,
        gl.FLOAT,
        false,
        INSTANCE_STRIDE,
        index * INSTANCE_FLOATS * 4 + (location - 1) * 16,
      );
    }
  }

  private releaseResources() {
    const gl = this.gl;
    for (const shader of this.shaders) gl.deleteShader(shader);
    gl.deleteBuffer(this.fieldVertexBuffer);
    gl.deleteBuffer(this.fieldIndexBuffer);
    gl.deleteBuffer(this.focusVertexBuffer);
    gl.deleteBuffer(this.focusIndexBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    for (const texture of this.textures) gl.deleteTexture(texture);
    if (this.vao) gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  /** Releases every GPU resource. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    (this.gl.canvas as HTMLCanvasElement).removeEventListener('webglcontextlost', this.handleContextLost);
    this.slots.clear();
    this.releaseResources();
    this.sourceCanvas.width = this.sourceCanvas.height = 0;
    this.focusCanvas.width = this.focusCanvas.height = 0;
  }
}

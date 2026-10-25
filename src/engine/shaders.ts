/**
 * The GLSL sources of the glass field, ported unchanged from embed-anything
 * (`src/engine/shaders/glass.{vert,frag}.glsl`, MIT).
 */
import vertexSource from './shaders/glass.vert.glsl?raw';
import fragmentSource from './shaders/glass.frag.glsl?raw';

export const VERTEX_SHADER = vertexSource;
export const FRAGMENT_SHADER = fragmentSource;

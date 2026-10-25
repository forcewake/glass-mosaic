/**
 * Draws the audio waveform tile.
 *
 * Ported from the recovered `vt` function: a dark teal gradient background, a
 * soft centre line, and a gradient waveform whose played portion is drawn in a
 * bright mint colour.
 */
import { downsampleWaveform } from './audio';
import type { MediaItem } from './types';

/** A deterministic pseudo-random waveform, used when no real waveform is known. */
export function syntheticWaveform(bars: number): number[] {
  return Array.from({ length: bars }, (_, i) => 0.12 + 0.5 * Math.sin(i * 0.37) ** 2 * Math.sin(i * 0.11) ** 2);
}

export function paintWaveform(canvas: HTMLCanvasElement, item: MediaItem, progress = 0, time?: number): void {
  const width = canvas.width;
  const height = canvas.height;
  const context = canvas.getContext('2d');
  if (!context) return;

  const background = context.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#12363d');
  background.addColorStop(0.48, '#0c202b');
  background.addColorStop(1, '#080e1b');
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);

  const left = Math.round(width * 0.09);
  const span = Math.round(width * 0.82);
  const middle = Math.round(height * 0.46);
  context.fillStyle = '#b9f2ef20';
  context.fillRect(left, middle, span, 1);

  const source = item.waveform?.length ? item.waveform : syntheticWaveform(96);
  const bars = downsampleWaveform(source, Math.max(1, Math.floor(span / 5)));
  const barWidth = span / bars.length;
  const gradient = context.createLinearGradient(left, middle - height * 0.18, left + span, middle + height * 0.18);
  gradient.addColorStop(0, '#b1f5e4');
  gradient.addColorStop(0.55, '#8ad9ee');
  gradient.addColorStop(1, '#a7b9f1');

  const clamped = Math.max(0, Math.min(1, progress));
  for (let i = 0; i < bars.length; i++) {
    const wobble = time == null ? 1 : 0.7 + 0.3 * Math.sin(time * 3.2 - i * 0.16);
    const amplitude = Math.max(1, Math.round(bars[i] * wobble * height * 0.18));
    context.fillStyle = clamped > 0 && i / bars.length <= clamped ? '#edfffa' : gradient;
    context.globalAlpha = clamped > 0 && i / bars.length > clamped ? 0.48 : 0.9;
    context.beginPath();
    context.roundRect(
      Math.round(left + i * barWidth),
      middle - amplitude,
      Math.max(2, Math.round(barWidth * 0.6)),
      amplitude * 2,
      1,
    );
    context.fill();
  }
  context.globalAlpha = 1;

  if (clamped > 0) {
    context.fillStyle = '#edfffa';
    context.fillRect(
      Math.round(left + span * clamped),
      Math.round(middle - height * 0.22),
      2,
      Math.round(height * 0.44),
    );
  }
}

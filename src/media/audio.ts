/** Waveform helpers, ported from embed-anything's `src/media/audio.ts` (MIT). */

/** Reduces a waveform to `target` bars by keeping the peak of each bucket. */
export function downsampleWaveform(waveform: number[], target: number): number[] {
  const count = Math.min(waveform.length, Math.max(1, Math.floor(target)));
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor((i * waveform.length) / count);
    const end = Math.floor(((i + 1) * waveform.length) / count);
    let peak = 0;
    for (let j = start; j < end; j++) peak = Math.max(peak, waveform[j]);
    return peak;
  });
}

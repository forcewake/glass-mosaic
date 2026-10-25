/**
 * The media model of the mosaic.
 *
 * Ported from embed-anything's `src/media/types.ts`, minus everything that only
 * existed for the embedding pipeline (embedding ids, user uploads, text items).
 */
export type MediaType = 'image' | 'video' | 'audio';

export interface MediaItem {
  /** Stable catalog id. */
  id: string;
  type: MediaType;
  title: string;
  description: string;
  /** Curated topic the item was collected for (e.g. "Mountains"). */
  topic: string;
  /** Lower-case tags (cleaned source categories). */
  tags: string[];
  /** Width / height. */
  aspectRatio: number;
  /** Small bitmap used as the card texture (images, video posters). */
  thumb?: string;
  /** Full media URL (large image, video, or audio file). */
  src: string;
  /** Still frame for videos. */
  poster?: string;
  /** Low-resolution video used for the live preview of a focused card. */
  preview?: string;
  mime?: string;
  durationSeconds?: number;
  /** Normalized 0..1 waveform peaks for audio. */
  waveform?: number[];
  license: string;
  licenseUrl?: string | null;
  artist: string;
  /** Attribution / source page. */
  page: string;
}

export interface Catalog {
  version: 1;
  source: string;
  generatedAt?: string;
  notice?: string;
  items: MediaItem[];
}

export const TYPE_LABEL: Record<MediaType, string> = { image: 'Photo', video: 'Video', audio: 'Sound' };

import type { IndexableDoc } from '../src/search/indexer';
import type { MediaItem } from '../src/media/types';

export function item(partial: Partial<MediaItem> & { id: string }): MediaItem {
  return {
    type: 'image',
    title: partial.id,
    description: '',
    topic: '',
    tags: [],
    aspectRatio: 1.5,
    src: `https://upload.wikimedia.org/${partial.id}.jpg`,
    thumb: `https://upload.wikimedia.org/thumb/${partial.id}.jpg`,
    license: 'CC BY 4.0',
    artist: 'Someone',
    page: `https://commons.wikimedia.org/wiki/File:${partial.id}`,
    ...partial,
  };
}

export const DOCS: IndexableDoc[] = [
  { id: 'alps', type: 'image', title: 'Matterhorn at dawn', topic: 'Mountains', tags: ['alps', 'switzerland', 'peaks'], description: 'Snow-covered mountain peak above Zermatt', artist: 'A' },
  { id: 'andes', type: 'image', title: 'Andes ridge', topic: 'Mountains', tags: ['andes', 'chile'], description: 'High mountains in the clouds', artist: 'B' },
  { id: 'massif', type: 'image', title: 'Massif central overview', topic: 'Landscapes', tags: ['france'], description: 'Volcanic plateau', artist: 'C' },
  { id: 'rain-audio', type: 'audio', title: 'Heavy rain in summer', topic: 'Rain', tags: ['field recording', 'weather'], description: 'Rain falling on a roof', artist: 'D' },
  { id: 'rain-photo', type: 'image', title: 'Rainy street at night', topic: 'Cities', tags: ['rain', 'night'], description: 'Wet asphalt reflections', artist: 'E' },
  { id: 'ocean-video', type: 'video', title: 'Ocean surface waves', topic: 'Ocean', tags: ['sea', 'waves'], description: 'Slow waves rolling in', artist: 'F' },
  { id: 'ocean-photo', type: 'image', title: 'Pacific ocean from a cliff', topic: 'Ocean', tags: ['sea', 'coast'], description: 'Blue water and rocks', artist: 'G' },
  { id: 'wolf', type: 'image', title: 'Grey wolves in the snow', topic: 'Wildlife', tags: ['animals', 'canis lupus'], description: 'A pack of wolves', artist: 'H' },
  { id: 'cat', type: 'image', title: 'Sleeping kitten', topic: 'Cats', tags: ['pets'], description: 'A small cat asleep', artist: 'I' },
  { id: 'forest', type: 'image', title: 'Pine forest', topic: 'Forests', tags: ['trees', 'woodland'], description: 'Tall pines in fog', artist: 'J' },
  { id: 'birdsong', type: 'audio', title: 'Blackbird song', topic: 'Birdsong', tags: ['birds', 'turdus merula'], description: 'Morning song of a blackbird', artist: 'K' },
  { id: 'montage', type: 'image', title: 'Photo montage of a city', topic: 'Art', tags: ['collage'], description: 'Composite image', artist: 'L' },
];

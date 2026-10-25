# Notices, provenance and media licensing

## Code

Glass Mosaic is MIT-licensed (see [`LICENSE`](LICENSE)). It ports parts of
[forcewake/embed-anything](https://github.com/forcewake/embed-anything)
(MIT, Copyright (c) 2026 Embed Anything contributors), whose notice is kept in
`LICENSE`:

| Here | From embed-anything | How |
| --- | --- | --- |
| `src/engine/shaders/glass.{vert,frag}.glsl` | `src/engine/shaders/` | unchanged |
| `src/engine/geometry.ts`, `SpatialIndex.ts`, `AspectMosaicLayout.ts` | `src/engine/` | unchanged |
| `src/engine/GlassRenderer.ts` | `src/engine/GlassRenderer.ts` | adapted: smaller instance/texture budget, procedural studio environment instead of `studio.hdr`, low-power context, context-loss callback |
| `src/engine/MediaPool.ts` | media texture pool | rewritten smaller: one live video, LRU, concurrency cap |
| `src/engine/GlassField.ts` | `SpatialField` | rewritten for arrow keys: focusable DOM cards over the canvas, infinite tiling, camera follow, DOM fallback |
| `src/media/{shuffle,audio,waveform}.ts`, parts of `catalog.ts` | `src/media/` | ported |

### Provenance caveat (please read before publishing)

embed-anything's README describes its GLSL shaders as "recovered … byte-equivalent"
from the deployed bundle of the Hugging Face Space
`webml-community/embeddinggemma-2-webgpu`, and several engine files as ports of
the "recovered renderer". embed-anything also states that the Space's
application source has **no known open-source license**. Glass Mosaic inherits
those files through embed-anything's MIT license, but the MIT grant can only
cover what its authors had the right to license. If you need certainty for a
public or commercial release, replace `src/engine/shaders/*` (and the ported
math) with a clean-room implementation or obtain permission. Nothing else from
the Space is used: no bundle, no model, no embeddings, no HDR file, no fonts.

## Media

The shipped catalog (`public/data/catalog.json`) holds **metadata and links**
for 768 files on [Wikimedia Commons](https://commons.wikimedia.org); the media
themselves are not in this repository and are loaded from
`upload.wikimedia.org` at runtime. Every item records its own `license`,
`licenseUrl`, `artist` and source `page`; the viewer shows the author, license
and a link to the file page. Licenses in the current catalog are free licenses
(mostly CC BY-SA 4.0 / 3.0, CC BY, CC0, public domain, a few GFDL/FAL).
Attribution and share-alike obligations apply when you redistribute or adapt
the media. Check each item before reusing it outside this app.

The catalog builder (`scripts/build-catalog.mjs`) only uses the public
MediaWiki API with an identifying User-Agent. The optional legacy converter
(`scripts/import-legacy-catalog.ts`) works on a local file only; the content it
describes (Unsplash, Pexels, Pixabay, Wikimedia) carries its own terms.

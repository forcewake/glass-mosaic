import { defineConfig } from 'vite';

// A relative base keeps the build servable from any sub-path
// (GitHub Pages project sites, Azure Static Web Apps, a CDN folder…).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 200,
  },
  server: { host: true },
  preview: { host: true },
});

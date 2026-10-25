import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests at the glasses' 600x600 viewport, driven only by the keys
 * the Meta Ray-Ban Display delivers (arrows + Enter). The app is served from
 * the production build (`npm run build` first).
 *
 * WebGL runs on SwiftShader in headless Chromium. Media come from
 * upload.wikimedia.org, so the tests need network access.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:4173/',
    viewport: { width: 600, height: 600 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
    },
  },
  projects: [
    { name: 'desktop-chromium' },
    {
      // Chromium's spatial navigation, as on the glasses (see the Test guide).
      name: 'spatial-navigation',
      use: {
        launchOptions: {
          args: [
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--autoplay-policy=no-user-gesture-required',
            '--enable-spatial-navigation',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});

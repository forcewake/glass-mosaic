import { expect, test, type Page } from '@playwright/test';

/**
 * Glasses flow at 600x600 using only ArrowUp/Down/Left/Right and Enter.
 *
 * Text entry on the glasses goes through the system composer, which delivers
 * `input` and `change` events only (no per-key events), so the tests set the
 * field value and dispatch those two events. The system Back gesture calls
 * `history.back()`, which the tests reproduce with `page.goBack()`.
 */

interface State {
  mode: 'browse' | 'results';
  render: 'webgl' | 'dom';
  reduced: boolean;
  focused: string | null;
  viewer: string | null;
  items: number;
  index: string;
}

const MODEL_PATTERN = /huggingface|hf\.co|\.onnx|onnxruntime|ort-wasm|transformers|embeddinggemma|safetensors|\.f16|studio\.hdr/i;
const shots = () => process.env.SCREENSHOTS !== '0' && test.info().project.name === 'desktop-chromium';

async function state(page: Page): Promise<State> {
  return page.evaluate(() => (window as unknown as { glassMosaic: { state: State } }).glassMosaic.state);
}

async function ready(page: Page, url = './') {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as { glassMosaic?: { state: State } }).glassMosaic?.state.focused);
  return requests;
}

async function activeLabel(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName.toLowerCase() ?? '',
      id: el?.id ?? '',
      className: el?.className ?? '',
      label: el?.getAttribute('aria-label') ?? el?.textContent?.trim() ?? '',
      focusVisible: !!el?.matches(':focus-visible'),
      outline: el ? getComputedStyle(el).outlineStyle : '',
    };
  });
}

/** Composer commit: `input` then `change`. */
async function compose(page: Page, text: string) {
  await page.evaluate((value) => {
    const input = document.getElementById('search-input') as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, text);
}

async function settle(page: Page, ms = 600) {
  await page.waitForTimeout(ms);
}

/** Waits until the visible card textures have loaded (best effort, network bound). */
async function mediaSettled(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

test('browse, search, view and go back with arrows and Enter only', async ({ page }) => {
  const requests = await ready(page);
  const s = await state(page);
  expect(s.items).toBeGreaterThan(500);
  expect(s.mode).toBe('browse');
  expect(s.index).toBe('prebuilt');

  // A card has focus with a visible ring.
  let active = await activeLabel(page);
  expect(active.className).toContain('card');
  expect(active.focusVisible).toBe(true);
  expect(active.outline).toBe('solid');
  if (shots()) {
    await mediaSettled(page);
    await page.screenshot({ path: 'docs/screens/mosaic.png' });
  }

  // Arrows move between cards (the camera follows).
  const start = s.focused;
  await page.keyboard.press('ArrowRight');
  await settle(page, 300);
  const right = (await state(page)).focused;
  expect(right).not.toBe(start);
  await page.keyboard.press('ArrowDown');
  await settle(page, 300);
  expect((await state(page)).focused).not.toBe(right);
  await page.keyboard.press('ArrowLeft');
  await settle(page, 300);

  // Up from the top row reaches the search field.
  for (let i = 0; i < 12 && (await activeLabel(page)).id !== 'search-input'; i++) {
    await page.keyboard.press('ArrowUp');
    await settle(page, 200);
  }
  active = await activeLabel(page);
  expect(active.id).toBe('search-input');
  expect(active.focusVisible).toBe(true);

  // Composer commit → spiral of results, best hit focused.
  await compose(page, 'mountains');
  await expect.poll(async () => (await state(page)).mode).toBe('results');
  await settle(page);
  await expect(page.locator('.status')).toContainText(/\d+ matches/);
  active = await activeLabel(page);
  expect(active.className).toContain('card');
  expect(active.label).toMatch(/relevance 1\.00/i);
  expect(active.label.toLowerCase()).toMatch(/mountain/);
  if (shots()) {
    await mediaSettled(page);
    await page.screenshot({ path: 'docs/screens/search-mountains.png' });
  }

  // Enter opens the viewer on the focused hit.
  const opened = (await state(page)).focused;
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).viewer).toBe(opened);
  await expect(page.locator('.viewer')).toBeVisible();
  await expect(page.locator('.viewer-position')).toHaveText(/^1 of \d+$/);
  expect((await activeLabel(page)).className).toContain('viewer-stage');
  if (shots()) {
    await mediaSettled(page);
    await page.screenshot({ path: 'docs/screens/viewer.png' });
  }

  // Left/Right step through the results inside the viewer.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.viewer-position')).toHaveText(/^2 of \d+$/);
  const second = (await state(page)).viewer;
  expect(second).not.toBe(opened);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.viewer-position')).toHaveText(/^1 of \d+$/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.viewer-position')).toHaveText(/^1 of \d+$/);

  // Down reaches the controls; the Close button is a way out with Enter.
  await page.keyboard.press('ArrowDown');
  for (let i = 0; i < 4 && !/close/i.test((await activeLabel(page)).label); i++) {
    await page.keyboard.press('ArrowRight');
  }
  expect((await activeLabel(page)).label).toMatch(/close/i);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).viewer).toBeNull();
  await expect(page.locator('.viewer')).toBeHidden();
  active = await activeLabel(page);
  expect(active.className).toContain('card');
  expect((await state(page)).focused).toBe(opened);

  // Enter again, then the system Back gesture closes the viewer…
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).viewer).not.toBeNull();
  await page.goBack();
  await expect.poll(async () => (await state(page)).viewer).toBeNull();
  expect((await state(page)).mode).toBe('results');
  // …and Back once more returns to the full mosaic.
  await page.goBack();
  await expect.poll(async () => (await state(page)).mode).toBe('browse');

  // History stays well under the host's five-entry cap.
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(5);

  // No model, embedding or inference downloads.
  expect(requests.filter((url) => MODEL_PATTERN.test(url))).toEqual([]);
  const offOrigin = requests.filter((url) => !url.startsWith('http://localhost:4173/'));
  expect(offOrigin.filter((url) => !/^(https:\/\/(upload|thumb)\.wikimedia\.org\/|data:|blob:)/.test(url))).toEqual([]);
});

test('typing a query previews results without stealing focus; Clear is reachable', async ({ page }) => {
  await ready(page);
  for (let i = 0; i < 12 && (await activeLabel(page)).id !== 'search-input'; i++) await page.keyboard.press('ArrowUp');
  await page.evaluate(() => {
    const input = document.getElementById('search-input') as HTMLInputElement;
    input.value = 'rain sounds';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(async () => (await state(page)).mode).toBe('results');
  expect((await activeLabel(page)).id).toBe('search-input');
  // Right from the end of the text reaches Clear; Enter clears.
  await page.keyboard.press('ArrowRight');
  expect((await activeLabel(page)).label).toMatch(/clear/i);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).mode).toBe('browse');
  // Down returns to the mosaic.
  for (let i = 0; i < 2 && !(await activeLabel(page)).className.includes('card'); i++) await page.keyboard.press('ArrowDown');
  expect((await activeLabel(page)).className).toContain('card');
});

test('audio opens a waveform viewer that plays with Enter', async ({ page }) => {
  await ready(page);
  await compose(page, 'rain sounds');
  await expect.poll(async () => (await state(page)).mode).toBe('results');
  await page.keyboard.press('Enter');
  await expect(page.locator('.viewer-waveform')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.viewer [data-action="play"]')).toHaveText(/pause|play/i);
  await page.goBack();
  await expect.poll(async () => (await state(page)).viewer).toBeNull();
});

test('no matches keeps the mosaic and says so', async ({ page }) => {
  await ready(page);
  await compose(page, 'zzzzqx');
  await expect(page.locator('.status')).toContainText('No matches');
  expect((await state(page)).mode).toBe('browse');
});

test('DOM fallback and reduced mode work with the same keys', async ({ page }) => {
  await ready(page, './?render=dom&reduced=1');
  const s = await state(page);
  expect(s.render).toBe('dom');
  expect(s.reduced).toBe(true);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).viewer).not.toBeNull();
  await page.goBack();
  await expect.poll(async () => (await state(page)).viewer).toBeNull();
  expect((await activeLabel(page)).className).toContain('card');
});

test('layout fits the 600x600 display with readable text', async ({ page }) => {
  await ready(page);
  const report = await page.evaluate(() => {
    const overflow = document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight;
    const small: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (!el.offsetParent || !el.childNodes.length) continue;
      const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (hasText && parseFloat(getComputedStyle(el).fontSize) < 16) small.push(el.className || el.tagName);
    }
    return { overflow, small, background: getComputedStyle(document.body).backgroundColor };
  });
  expect(report.overflow).toBe(false);
  expect(report.small).toEqual([]);
  expect(report.background).toBe('rgb(0, 0, 0)');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', 'width=device-width, initial-scale=1');
  const manifest = await page.request.get('./.well-known/meta-wearables-manifest.json');
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).version).toBe(1);
});

test('WebMCP tools (beta) drive the same app state when the API exists', async ({ page }) => {
  // Stand-in for the Dev Mode `document.modelContext`; the real API is off by default.
  await page.addInitScript(() => {
    const tools = new Map<string, { execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown> }>();
    Object.defineProperty(document, 'modelContext', {
      value: {
        registerTool: async (tool: { name: string; execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown> }) => {
          tools.set(tool.name, tool);
        },
      },
    });
    (window as unknown as { __tools: typeof tools }).__tools = tools;
  });
  await ready(page);
  const call = (name: string, input: unknown = {}) =>
    page.evaluate(
      ([n, i]) =>
        (window as unknown as { __tools: Map<string, { execute: (input: unknown, o: { signal: AbortSignal }) => Promise<unknown> }> }).__tools
          .get(n as string)!
          .execute(i, { signal: new AbortController().signal }),
      [name, input] as const,
    );
  expect(await page.evaluate(() => [...(window as unknown as { __tools: Map<string, unknown> }).__tools.keys()])).toEqual([
    'search_mosaic', 'open_item', 'next_item', 'previous_item', 'close_viewer',
  ]);
  const found = JSON.stringify(await call('search_mosaic', { query: 'mountains' }));
  expect(found).toMatch(/Found \d+ matches/);
  expect((await state(page)).mode).toBe('results');
  await call('open_item', { position: 2 });
  await expect(page.locator('.viewer-position')).toHaveText(/^2 of \d+$/);
  await call('next_item');
  await expect(page.locator('.viewer-position')).toHaveText(/^3 of \d+$/);
  await call('previous_item');
  await expect(page.locator('.viewer-position')).toHaveText(/^2 of \d+$/);
  await call('close_viewer');
  await expect.poll(async () => (await state(page)).viewer).toBeNull();
  expect(JSON.stringify(await call('open_item', { position: 9999 }))).toContain('not_found');
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(5);
});

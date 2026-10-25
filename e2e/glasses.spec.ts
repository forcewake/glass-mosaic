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
  wrist: string;
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
  // Screenshots without the launch-time diagnostics line.
  await page.locator('.diag').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
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
  // (Presses are spaced beyond the double-ArrowUp window to test the plain path.)
  for (let i = 0; i < 12 && (await activeLabel(page)).id !== 'search-input'; i++) {
    await page.keyboard.press('ArrowUp');
    await settle(page, 450);
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

// ------------------------------------------------------------------ quick search access

/** Counts activations (clicks) of the search field: that is what opens the composer on the glasses. */
async function watchActivation(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __activations: number };
    w.__activations = 0;
    document.getElementById('search-input')!.addEventListener('click', () => w.__activations++);
  });
}
const activations = (page: Page) => page.evaluate(() => (window as unknown as { __activations: number }).__activations);

test('double ArrowUp jumps to the search field and opens the composer; one ArrowUp still navigates', async ({ page }) => {
  await ready(page);
  await watchActivation(page);
  // Move down a few rows so a single Up has somewhere to go.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  await settle(page, 400);
  const before = (await state(page)).focused;
  await page.keyboard.press('ArrowUp');
  await settle(page, 450);
  const afterOne = await activeLabel(page);
  expect(afterOne.className).toContain('card');
  expect((await state(page)).focused).not.toBe(before);
  expect(await activations(page)).toBe(0);

  // Two quick presses: focus + activation of the semantic search field.
  const fromCard = (await state(page)).focused;
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const active = await activeLabel(page);
  expect(active.id).toBe('search-input');
  expect(await page.locator('#search-input').getAttribute('type')).toBe('search');
  expect(await activations(page)).toBe(1);
  // The first press of the pair moved focus at most one row: the second was consumed.
  expect((await state(page)).focused).not.toBeNull();
  expect(fromCard).not.toBeNull();

  // Not again from inside the field.
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  expect(await activations(page)).toBe(1);

  // Committed composer text (input + change only) searches.
  await compose(page, 'mountains');
  await expect.poll(async () => (await state(page)).mode).toBe('results');
  expect((await activeLabel(page)).className).toContain('card');

  // From inside the viewer too: closes it through history first.
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).viewer).not.toBeNull();
  const lengthInViewer = await page.evaluate(() => history.length);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => (await state(page)).viewer).toBeNull();
  await expect.poll(async () => (await activeLabel(page)).id).toBe('search-input');
  expect(await activations(page)).toBe(2);
  await expect.poll(() => page.evaluate(() => (history.state as { gm?: string } | null)?.gm)).toBe('results');
  expect(await page.evaluate(() => history.length)).toBe(lengthInViewer);
  // Back still clears the search and leaves the app history intact.
  await page.goBack();
  await expect.poll(async () => (await state(page)).mode).toBe('browse');
});

test('viewer Search button is one move from where Down lands and opens the composer', async ({ page }) => {
  await ready(page);
  await watchActivation(page);
  await compose(page, 'mountains');
  await expect.poll(async () => (await state(page)).mode).toBe('results');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).viewer).not.toBeNull();
  await expect(page.locator('.viewer [data-action="search"]')).toBeVisible();
  if (shots()) {
    await mediaSettled(page);
    await page.screenshot({ path: 'docs/screens/viewer.png' });
  }
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  const label = await activeLabel(page);
  expect(label.tag).toBe('button');
  expect(label.label).toBe('New search');
  expect(label.focusVisible).toBe(true);
  if (shots()) await page.screenshot({ path: 'docs/screens/viewer-search.png' });
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).viewer).toBeNull();
  await expect.poll(async () => (await activeLabel(page)).id).toBe('search-input');
  expect(await activations(page)).toBe(1);
  await expect.poll(() => page.evaluate(() => (history.state as { gm?: string } | null)?.gm)).toBe('results');
  await compose(page, 'rain sounds');
  await expect(page.locator('.status')).toContainText(/\d+ matches/);
  expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(5);
});

test('"New search" at the end of the results is reached with Down and opens the composer', async ({ page }) => {
  await ready(page);
  await watchActivation(page);
  await expect(page.locator('.results-search')).toBeHidden();
  await compose(page, 'snow');
  await expect.poll(async () => (await state(page)).mode).toBe('results');
  await expect(page.locator('.results-search')).toBeVisible();
  for (let i = 0; i < 20 && !(await activeLabel(page)).className.includes('results-search'); i++) {
    await page.keyboard.press('ArrowDown');
    await settle(page, 120);
  }
  let active = await activeLabel(page);
  expect(active.className).toContain('results-search');
  expect(active.tag).toBe('button');
  expect(active.focusVisible).toBe(true);
  if (shots()) {
    await mediaSettled(page);
    await page.screenshot({ path: 'docs/screens/results-new-search.png' });
  }
  // Up goes back to the cards; Down returns in one move.
  await page.keyboard.press('ArrowUp');
  expect((await activeLabel(page)).className).toContain('card');
  await page.keyboard.press('ArrowDown');
  active = await activeLabel(page);
  expect(active.className).toContain('results-search');
  await page.keyboard.press('Enter');
  expect((await activeLabel(page)).id).toBe('search-input');
  expect(await activations(page)).toBe(1);
  await compose(page, '');
  await expect.poll(async () => (await state(page)).mode).toBe('browse');
  await expect(page.locator('.results-search')).toBeHidden();
});

test('wrist twist: silent without the band, off with ?wrist=0, diagnostics with ?debug=1', async ({ page }) => {
  await ready(page, './?debug=1');
  // Desktop Chromium may have its own RelativeOrientationSensor, but not the glasses marker.
  await expect.poll(async () => (await state(page)).wrist, { timeout: 8000 }).toBe('unavailable');
  await expect(page.locator('.wrist-hint')).toBeHidden();
  await expect(page.locator('.diag')).toHaveText('WebMCP: unavailable · Wrist: unavailable – no emg-wrist sensor');
  await page.waitForTimeout(4200);
  await expect(page.locator('.diag')).toBeVisible(); // stays with ?debug=1

  await ready(page, './?wrist=0');
  expect((await state(page)).wrist).toBe('off');
  await expect(page.locator('.diag')).toContainText('Wrist: off');
  await expect(page.locator('.diag')).toBeHidden({ timeout: 6000 }); // launch-only without ?debug=1
  await page.goto('./?wrist=1'); // re-enable (the setting is remembered)
});

test('wrist twist opens search with a stand-in emg-wrist sensor (early frame flip ignored)', async ({ page }) => {
  await page.addInitScript(() => {
    type Reading = { quaternion: number[] | null; timestamp: number; onreading: (() => void) | null; onerror: unknown };
    const sensors: Reading[] = [];
    class FakeWrist {
      quaternion: number[] | null = null;
      timestamp = 0;
      onreading: (() => void) | null = null;
      onerror: unknown = null;
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
        sensors.push(this);
      }
      start() {}
      stop() {}
    }
    // The marker lands after load, as on the glasses.
    setTimeout(() => {
      Object.defineProperty(window, 'RelativeOrientationSensor', { value: Object.assign(FakeWrist, { __imuQuatWrapped: true }), configurable: true });
    }, 300);
    let t = 0;
    (window as unknown as { __wrist: unknown }).__wrist = {
      get options() {
        return (sensors.at(-1) as unknown as { options: unknown } | undefined)?.options;
      },
      /** Feeds twist angles (deg) at 50 Hz as w-first quaternions. */
      emit(angles: number[]) {
        const s = sensors.at(-1);
        if (!s) return false;
        for (const deg of angles) {
          const h = (deg * Math.PI) / 360;
          s.quaternion = [Math.cos(h), 0, Math.sin(h), 0];
          s.timestamp = t += 20;
          s.onreading?.();
        }
        return true;
      },
    };
  });
  await ready(page, './?wrist=1');
  await watchActivation(page);
  await expect.poll(async () => (await state(page)).wrist).toBe('starting');
  const emit = (angles: number[]) => page.evaluate((a) => (window as unknown as { __wrist: { emit: (a: number[]) => boolean } }).__wrist.emit(a), angles);
  expect(await page.evaluate(() => (window as unknown as { __wrist: { options: unknown } }).__wrist.options)).toEqual({ sensorId: 'emg-wrist' });
  const hold = (deg: number, n: number) => Array.from({ length: n }, () => deg);
  const ramp = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 1)) / n);
  // Settling with an early sign flip: no reference, no trigger.
  await emit([...hold(25, 20), ...hold(-25, 20), ...ramp(-25, 60, 10), ...ramp(60, -25, 10)]);
  expect((await state(page)).wrist).toBe('settling');
  expect(await activations(page)).toBe(0);
  await emit(hold(-25, 60));
  expect((await state(page)).wrist).toBe('on');
  await expect(page.locator('.wrist-hint')).toBeVisible();

  // Open the viewer, then twist: the viewer closes and the composer opens.
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).viewer).not.toBeNull();
  await emit([...ramp(-25, 40, 15), ...ramp(40, -25, 15)]);
  await expect.poll(async () => (await state(page)).viewer).toBeNull();
  await expect.poll(async () => (await activeLabel(page)).id).toBe('search-input');
  expect(await activations(page)).toBe(1);
  // Cooldown + field already focused: nothing more.
  await emit([...ramp(-25, 40, 15), ...ramp(40, -25, 15)]);
  expect(await activations(page)).toBe(1);
  await compose(page, 'ocean');
  await expect.poll(async () => (await state(page)).mode).toBe('results');
});

/**
 * Glass Mosaic — application wiring.
 *
 * Loads the catalog and the prebuilt search index, creates the field, the
 * toolbar and the viewer, and keeps them in sync with the browser history
 * (the glasses' Back gesture calls `history.back()`).
 */
import '../styles/app.css';
import { displayOrder, loadCatalog } from '../media/catalog';
import { resolveSeed } from '../media/shuffle';
import type { MediaItem } from '../media/types';
import { buildIndex, isSearchIndex, type SearchIndex } from '../search/indexer';
import { Ranker, type SearchResult } from '../search/ranker';
import { GlassField, type Instance } from '../engine/GlassField';
import { MediaPool } from '../engine/MediaPool';
import { Toolbar } from './toolbar';
import { Viewer, type ViewerContext } from './viewer';
import { AgentNotReady, registerAgentTools, webmcpStatus, type AgentApi, type AgentState } from './webmcp';
import { liveTitle } from './title';
import {
  SIMPLE_DESCRIPTION,
  createCallLog,
  isSimpleMode,
  registerSimpleTools,
  simpleStatus,
  simpleTitle,
  simpleToolDefinitions,
} from './webmcp-simple';
import { installDoubleArrowUp } from './doubletap';
import { WristGesture, type WristStatus } from './wrist';

type HistoryState = { gm: 'results'; q: string } | { gm: 'viewer'; id: string } | null;

const params = new URLSearchParams(location.search);
const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let reduced = params.get('reduced') === '1' || (params.get('reduced') !== '0' && prefersReducedMotion);
const forceDom = params.get('render') === 'dom';
const debug = params.get('debug') === '1';
// Experimental wrist twist: on by default when the band's sensor exists;
// `?wrist=0` turns it off (remembered), `?wrist=1` turns it back on.
const WRIST_KEY = 'glass-mosaic:wrist';
if (params.has('wrist')) {
  try {
    localStorage.setItem(WRIST_KEY, params.get('wrist') === '0' ? '0' : '1');
  } catch {
    // storage may be unavailable
  }
}
const wristEnabled = (() => {
  if (params.has('wrist')) return params.get('wrist') !== '0';
  try {
    return localStorage.getItem(WRIST_KEY) !== '0';
  } catch {
    return true;
  }
})();

const app = document.getElementById('app')!;

// WebMCP (beta, off by default): register immediately at launch, before the
// catalog loads, because eligibility is decided when the Web App launches.
// The tools forward to the real implementation once the app is ready.
// mosaic_get_state and mosaic_search stay registered for the whole session;
// the per-screen set starts as the mosaic's (mosaic_open_item) and is swapped
// for the viewer's when it opens (see syncAgentTools below).
let agentImpl: AgentApi | null = null;
const ready = (): AgentApi => {
  if (!agentImpl) throw new AgentNotReady('Glass Mosaic is still loading. Try again in a moment.');
  return agentImpl;
};
const forwardingApi: AgentApi = {
  state: () => ready().state(),
  search: (query) => ready().search(query),
  open: (position) => ready().open(position),
  step: (delta) => ready().step(delta),
  close: () => ready().close(),
};
// `?webmcp=simple`: a field test mirroring facebook/meta_glasses_webmcp
// (webmcp-simple.ts). All six tools, once, no signal, no per-screen swaps.
const simpleMode = isSimpleMode(location.search);
const callLog = createCallLog();
const simpleReg = simpleMode ? registerSimpleTools(
      simpleToolDefinitions(forwardingApi, callLog.record, {
        // The viewer closes through history.back(): wait for its popstate (at most 500 ms).
        settle: () =>
          new Promise<void>((resolve) => {
            const done = () => {
              window.removeEventListener('popstate', done);
              window.setTimeout(resolve, 0);
            };
            window.addEventListener('popstate', done);
            window.setTimeout(done, 500);
          }),
      }),
    ) : null;
if (simpleMode) {
  document.title = simpleTitle({ mode: 'mosaic', query: '', matches: 0, item: null });
  document.querySelector('meta[name="description"]')?.setAttribute('content', SIMPLE_DESCRIPTION);
  Object.defineProperty(window, 'GlassMosaic', {
    value: Object.freeze({ webmcp: 'simple', log: callLog.log, registration: simpleReg }),
  });
}
const agentTools: ReturnType<typeof registerAgentTools> = simpleMode
  ? {
      available: Boolean(simpleReg?.available),
      screen: 'browse',
      ready: Promise.resolve(),
      setScreen: () => Promise.resolve(),
      onChange: () => {},
      dispose: () => {},
    }
  : registerAgentTools(forwardingApi);

// Diagnostics: always for ~4 s at launch, permanently with `?debug=1`.
const diag = document.createElement('p');
diag.className = 'diag';
diag.setAttribute('role', 'status');
if (debug) diag.classList.add('debug'); // full text, wrapped, so tool names are readable
const diagParts = { webmcp: 'WebMCP: …', wrist: 'Wrist: …' };
const renderDiag = () => {
  diag.textContent = `${diagParts.webmcp} · ${diagParts.wrist}`;
};
renderDiag();
app.append(diag);
// Without ?debug=1: hide after 4 s, or as soon as the wrist check has
// resolved after that (the sensor marker can take a few seconds), at most 8 s.
const launchedAt = performance.now();
let diagResolved = false;
const maybeHideDiag = () => {
  const age = performance.now() - launchedAt;
  if (debug || !diag.isConnected) return;
  if ((age >= 4000 && diagResolved) || age >= 8000) diag.remove();
};
if (!debug) {
  window.setTimeout(maybeHideDiag, 4000);
  window.setTimeout(maybeHideDiag, 8000);
}
// The tool count changes per screen: refresh on every `toolchange` (when the
// host fires it) and after every screen swap. A sequence number keeps a slow,
// stale getTools() answer from overwriting a newer one.
let diagSeq = 0;
const refreshWebmcpDiag = () => {
  const seq = ++diagSeq;
  void (simpleReg ? simpleStatus(simpleReg, debug) : webmcpStatus(debug))
    .catch(() => 'WebMCP: status failed')
    .then((text) => {
      if (seq !== diagSeq) return;
      diagParts.webmcp = text;
      renderDiag();
    });
};
agentTools.onChange(refreshWebmcpDiag);
void agentTools.ready.catch(() => undefined).then(refreshWebmcpDiag);

const fieldHost = document.createElement('main');
fieldHost.className = 'field-host';
fieldHost.setAttribute('aria-label', 'Mosaic');

async function loadIndex(items: MediaItem[]): Promise<{ index: SearchIndex; source: string }> {
  try {
    const response = await fetch(new URL('data/search-index.json', document.baseURI));
    if (response.ok) {
      const index = await response.json();
      const ids = new Set(items.map((item) => item.id));
      if (isSearchIndex(index) && index.ids.length === items.length && index.ids.every((id) => ids.has(id))) {
        // The index addresses documents by catalog id, so order does not matter.
        return { index, source: 'prebuilt' };
      }
    }
  } catch {
    // Fall through to the in-browser build.
  }
  return { index: buildIndex(items), source: 'built in browser' };
}

function showFatal(message: string): void {
  app.replaceChildren();
  const panel = document.createElement('div');
  panel.className = 'fatal';
  panel.innerHTML = '<h1>Glass Mosaic</h1><p></p><button type="button">Try again</button>';
  panel.querySelector('p')!.textContent = message;
  const button = panel.querySelector('button')!;
  button.addEventListener('click', () => location.reload());
  app.append(panel);
  button.focus();
}

async function start(): Promise<void> {
  const loading = document.createElement('p');
  loading.className = 'loading';
  loading.textContent = 'Loading the mosaic…';
  app.append(loading);

  const catalog = await loadCatalog(new URL('data/catalog.json', document.baseURI));
  if (!catalog.length) throw new Error('The catalog is empty.');
  const items = displayOrder(catalog, resolveSeed());
  const byId = new Map(items.map((item) => [item.id, item]));
  const { index, source: indexSource } = await loadIndex(items);
  const ranker = new Ranker(index);
  loading.remove();

  // Assigned right below; the pool's callback needs a forward reference.
  // eslint-disable-next-line prefer-const
  let field: GlassField;
  const pool = new MediaPool({ onChange: () => field?.invalidate(), videoFps: 12 });
  pool.setLiveEnabled(!reduced);

  let lastResult: SearchResult | null = null;
  let committedQuery = '';
  const idleStatus = () => `${items.length} items · Wikimedia Commons · ↑↓←→ ⏎ · ↑↑ search`;

  const toolbar = new Toolbar(app, {
    onPreview: (query) => runSearch(query, { commit: false, focus: false }),
    onCommit: (query) => runSearch(query, { commit: true, focus: true }),
    onClear: () => clearResults(false),
    onExitDown: () => field.restoreFocusOrEntry(),
  });
  app.append(fieldHost);

  field = new GlassField(fieldHost, {
    items,
    pool,
    render: forceDom ? 'dom' : 'webgl',
    reduced,
    topInset: () => toolbar.inset,
    onOpen: (instance) => openViewer(instance),
    onExitUp: () => toolbar.focus(),
    onExitDown: () => {
      if (resultsSearch.hidden) return;
      resultsSearch.focus({ preventScroll: true });
    },
    onSlow: () => setReduced(true),
  });

  const viewer = new Viewer(app, {
    onStep: (delta) => stepViewer(delta),
    onClose: () => closeViewer(false),
    onSearch: () => openSearch(),
  });

  // "New search" at the end of the results: Down from the bottom row of the
  // spiral lands on it, Up goes back to the cards. A real <button>, so
  // spatial navigation and Enter work as usual.
  const resultsSearch = document.createElement('button');
  resultsSearch.type = 'button';
  resultsSearch.className = 'results-search';
  resultsSearch.textContent = 'New search';
  resultsSearch.hidden = true;
  resultsSearch.addEventListener('click', () => openSearch());
  resultsSearch.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      field.restoreFocusOrEntry();
    }
  });
  app.append(resultsSearch);

  function setHasResults(has: boolean): void {
    toolbar.setHasResults(has);
    resultsSearch.hidden = !has;
  }

  /** Every "open search" path: closes the viewer (through history, as Close does), then focuses + activates the field. */
  function openSearch(): void {
    if (viewer.isOpen) closeViewer(false);
    toolbar.openComposer();
  }

  // Double ArrowUp from anywhere → search. Not from the field itself.
  installDoubleArrowUp({
    isBlocked: () => toolbar.hasFocus,
    onDoubleTap: () => openSearch(),
  });

  // Experimental wrist twist → search (see wrist.ts). Silent when absent.
  const wristHint = document.createElement('p');
  wristHint.className = 'wrist-hint';
  wristHint.hidden = true;
  wristHint.setAttribute('aria-hidden', 'true');
  wristHint.textContent = '⟲ twist: search';
  app.append(wristHint);
  const wristLabel: Record<WristStatus, string> = {
    checking: 'checking…',
    unavailable: 'unavailable',
    off: 'off',
    starting: 'on (starting)',
    settling: 'on (settling)',
    on: 'on',
    denied: 'off (permission denied)',
    error: 'off (error)',
  };
  const wrist = new WristGesture({
    enabled: wristEnabled,
    onStatus: (status, detail) => {
      wristHint.hidden = status !== 'on';
      diagParts.wrist = `Wrist: ${wristLabel[status]}${debug && detail ? ` – ${detail}` : ''}`;
      diag.classList.toggle('above-hint', status === 'on');
      renderDiag();
      if (status !== 'checking') {
        diagResolved = true;
        maybeHideDiag();
      }
    },
    onPhase: (update) => wristHint.classList.toggle('is-armed', update.phase === 'armed'),
    onTrigger: () => {
      if (toolbar.hasFocus) return;
      wristHint.classList.remove('is-fired');
      void wristHint.offsetWidth;
      wristHint.classList.add('is-fired');
      openSearch();
    },
  });

  toolbar.setStatus(idleStatus());
  document.documentElement.dataset.render = field.renderMode;
  document.documentElement.dataset.reduced = String(reduced);

  function setReduced(value: boolean): void {
    reduced = value;
    pool.setLiveEnabled(!value);
    field.setReduced(value);
    document.documentElement.dataset.reduced = String(value);
  }

  // ---------------------------------------------------------------- search

  function runSearch(query: string, options: { commit: boolean; focus: boolean }): SearchResult | null {
    const trimmed = query.trim();
    if (!trimmed) {
      if (field.currentMode === 'results' || options.commit) clearResults(false);
      return null;
    }
    const same = field.currentMode === 'results' && lastResult && lastResult.query.trim() === trimmed;
    const result = same && lastResult ? lastResult : ranker.search(trimmed, { limit: reduced ? 40 : 60 });
    if (!same) {
      lastResult = result;
      if (result.hits.length) {
        field.showResults(result.hits.map((hit) => ({ item: byId.get(hit.id)!, relevance: hit.relevance })));
      }
    }
    const ms = result.elapsedMs < 1 ? '<1' : result.elapsedMs.toFixed(0);
    toolbar.setStatus(
      result.hits.length
        ? `${result.hits.length} matches · ${ms} ms${result.typeIntent ? ` · ${result.typeIntent}` : ''}`
        : `No matches for “${trimmed}”`,
    );
    setHasResults(field.currentMode === 'results');
    if (options.commit && result.hits.length) {
      const state: HistoryState = { gm: 'results', q: trimmed };
      if ((history.state as HistoryState)?.gm === 'results') history.replaceState(state, '');
      else history.pushState(state, '');
      if (options.focus && !(same && committedQuery === trimmed && fieldHost.contains(document.activeElement))) {
        field.focusEntry();
      }
      committedQuery = trimmed;
    } else if (!options.commit && result.hits.length && (history.state as HistoryState)?.gm !== 'results') {
      history.pushState({ gm: 'results', q: trimmed } satisfies HistoryState, '');
    } else if (!options.commit && result.hits.length) {
      history.replaceState({ gm: 'results', q: trimmed } satisfies HistoryState, '');
    }
    updateTitle();
    return result;
  }

  function clearResults(fromHistory: boolean): void {
    const hadFocus = fieldHost.contains(document.activeElement);
    lastResult = null;
    committedQuery = '';
    toolbar.setQuery('');
    setHasResults(false);
    toolbar.setStatus(idleStatus());
    if (field.currentMode === 'results') field.showBrowse();
    if (!fromHistory && (history.state as HistoryState)?.gm === 'results') history.back();
    if (!hadFocus) toolbar.focus();
    updateTitle();
  }

  // ---------------------------------------------------------------- viewer

  function contextFor(instance: Instance): ViewerContext {
    const position =
      field.currentMode === 'results' ? `${instance.rank + 1} of ${field.resultCount}` : 'Browsing';
    return { item: instance.item, relevance: instance.relevance, position };
  }

  function openViewer(instance: Instance): void {
    if (viewer.isOpen) return;
    field.setActive(false);
    pool.setLive(null);
    fieldHost.inert = true;
    toolbar.element.inert = true;
    resultsSearch.inert = true;
    viewer.open(contextFor(instance));
    history.pushState({ gm: 'viewer', id: instance.item.id } satisfies HistoryState, '');
    updateTitle();
    syncAgentTools();
  }

  function stepViewer(delta: 1 | -1): ViewerContext | null {
    const current = field.focused;
    let next: Instance | null = null;
    if (field.currentMode === 'results' && current) {
      next = field.instanceAtRank(current.rank + delta);
      if (next) field.focusOn(next, false);
    } else {
      next = field.move(delta === 1 ? 'right' : 'left', false);
    }
    pool.setLive(null);
    if (!next) return null;
    if ((history.state as HistoryState)?.gm === 'viewer') {
      history.replaceState({ gm: 'viewer', id: next.item.id } satisfies HistoryState, '');
    }
    queueMicrotask(updateTitle);
    return contextFor(next);
  }

  function closeViewer(fromHistory: boolean): void {
    if (!viewer.isOpen) return;
    viewer.close();
    fieldHost.inert = false;
    toolbar.element.inert = false;
    resultsSearch.inert = false;
    field.setActive(true);
    field.restoreFocus();
    if (!fromHistory && (history.state as HistoryState)?.gm === 'viewer') history.back();
    updateTitle();
    syncAgentTools();
  }

  // Per-screen WebMCP tools (docs: register only what makes sense now). The
  // swap is idempotent, so repeated or rapid open/close calls are safe.
  function syncAgentTools(): void {
    try {
      void agentTools.setScreen(viewer.isOpen ? 'viewer' : 'browse').catch(() => undefined);
    } catch (error) {
      console.warn('[webmcp] screen swap failed', error);
    }
  }

  window.addEventListener('popstate', (event) => {
    const state = event.state as HistoryState;
    if (viewer.isOpen && state?.gm !== 'viewer') closeViewer(true);
    if (!state && field.currentMode === 'results') clearResults(true);
    if (state?.gm === 'results' && (field.currentMode !== 'results' || lastResult?.query.trim() !== state.q)) {
      toolbar.setQuery(state.q);
      runSearch(state.q, { commit: false, focus: false });
    }
  });

  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    pool.setLivePaused(hidden);
    field.setActive(!hidden && !viewer.isOpen);
  });

  // ---------------------------------------------------------------- agent tools (BETA)

  function agentState(): AgentState {
    const mode = viewer.isOpen ? 'viewer' : field.currentMode === 'results' ? 'results' : 'mosaic';
    const instance = field.focused;
    const item = viewer.isOpen ? viewer.item : instance?.item ?? null;
    const position =
      field.currentMode === 'results' && instance ? `${instance.rank + 1} of ${field.resultCount}` : 'browsing the mosaic';
    return {
      mode,
      query: field.currentMode === 'results' ? (lastResult?.query.trim() ?? committedQuery) : '',
      matches: field.currentMode === 'results' ? field.resultCount : 0,
      item: item ? { title: item.title, type: item.type, position } : null,
    };
  }

  // Samples (todo/src/view.ts): the title keeps the standing rule and names
  // the live screen, updated on every screen change.
  function updateTitle(): void {
    document.title = simpleMode ? simpleTitle(agentState()) : liveTitle(agentState());
  }

  const agent: AgentApi = {
    state: agentState,
    search(query) {
      toolbar.setQuery(query);
      if (viewer.isOpen) closeViewer(false);
      const result = runSearch(query, { commit: true, focus: true });
      const hits = result?.hits ?? [];
      return {
        count: hits.length,
        top: hits.slice(0, 5).map((hit, i) => ({
          position: i + 1,
          title: byId.get(hit.id)!.title,
          type: byId.get(hit.id)!.type,
          relevance: hit.relevance,
        })),
      };
    },
    open(position) {
      let instance: Instance | null;
      if (position === null) instance = field.focused;
      else if (field.currentMode !== 'results') {
        return { error: 'no_results', next_action: 'Call mosaic_search first, then mosaic_open_item with a position.' };
      } else instance = field.instanceAtRank(position - 1);
      if (!instance) {
        return {
          error: 'not_found',
          next_action: field.resultCount ? `Use a position from 1 to ${field.resultCount}.` : 'Call mosaic_search first.',
        };
      }
      if (viewer.isOpen) closeViewer(false);
      field.focusOn(instance, true);
      openViewer(instance);
      return { title: instance.item.title, type: instance.item.type, position };
    },
    step(delta) {
      if (viewer.isOpen) {
        if (!viewer.step(delta)) return { error: 'end_of_list', next_action: 'There is nothing further in that direction.' };
        const item = viewer.item!;
        const focused = field.focused;
        return {
          title: item.title,
          type: item.type,
          position: focused && field.currentMode === 'results' ? `${focused.rank + 1} of ${field.resultCount}` : 'browsing',
        };
      }
      const next = field.move(delta === 1 ? 'right' : 'left');
      if (!next) return { error: 'end_of_list', next_action: 'There is nothing further in that direction.' };
      return { title: next.item.title, type: next.item.type, position: 'focused in the mosaic' };
    },
    close() {
      if (!viewer.isOpen) return false;
      closeViewer(false);
      return true;
    },
  };
  agentImpl = agent;
  updateTitle();

  // A small, read-only hook for tests and debugging.
  Object.defineProperty(window, 'glassMosaic', {
    value: Object.freeze({
      get state() {
        return {
          mode: field.currentMode,
          render: field.renderMode,
          reduced,
          focused: field.focused?.item.id ?? null,
          viewer: viewer.isOpen ? viewer.item?.id ?? null : null,
          items: items.length,
          index: indexSource,
          wrist: wrist.status,
        };
      },
    }),
  });

  // Start on a card in the middle of the mosaic; Up from the top row reaches
  // the search box.
  field.focusEntry();
}

start().catch((error: unknown) => {
  console.error(error);
  showFatal(error instanceof Error ? error.message : 'Something went wrong.');
});

/**
 * Optional WebMCP tools (BETA) for Meta AI on the glasses.
 *
 * Aligned with Meta's official samples and skill:
 *   - docs:   https://wearables.developer.meta.com/docs/develop/webapps/agent-tools/
 *   - samples: https://github.com/facebook/meta_glasses_webmcp (examples/todo,
 *     examples/market): `appprefix_verb_noun` names, a read-only `*_get_state`
 *     registered FIRST,
 *     results that carry state, the standing instruction in `<title>` and
 *     `<meta name="description">`, and a persona file in `public/`;
 *   - skill:  https://github.com/facebook/meta-wearables-webapp/blob/main/plugins/meta-wearables-webapp/skills/ai-glasses-webapp-webmcp/SKILL.md
 *     register on the host `document.modelContext` (no polyfill), one guarded
 *     call per tool (`safeRegister`: `registerTool` may throw synchronously and
 *     may return a promise, a handle or nothing), only scalar parameters,
 *     handled conditions returned as `{ error, message, next_action }` JSON
 *     (there is no failure flag: `isError` is dropped), throw only for what the
 *     model cannot act on, every result ends with an explicit `next_action`.
 *
 * Per-screen registration (docs, "Unregistering": register only the tools
 * that make sense right now and abort when that screen unmounts):
 *   - always on, registered once at launch and never aborted:
 *     mosaic_get_state, mosaic_search;
 *   - mosaic / results screen: mosaic_open_item;
 *   - full-screen viewer: mosaic_next_item, mosaic_previous_item,
 *     mosaic_close_viewer.
 * Each screen set has one AbortController passed as `registerTool(tool,
 * { signal })`; switching screens aborts the previous set first (a duplicate
 * name rejects with InvalidStateError, it does not replace), and switching to
 * the current screen is a no-op, so rapid open/close cannot double-register.
 *
 * Annotations: only the two the docs define, `readOnlyHint` (get_state) and
 * `untrustedContentHint` (every tool: each result carries catalog titles
 * written by Wikimedia Commons contributors, still sanitised by `clean()`).
 * WebMCP is off by default: it reaches the assistant only on devices in
 * Developer Mode or in the rollout.
 */

export type AgentMode = 'mosaic' | 'results' | 'viewer';

export interface AgentState {
  mode: AgentMode;
  /** The committed query, or '' while browsing. */
  query: string;
  matches: number;
  /** The card focused in the field, or the item open in the viewer. */
  item: { title: string; type: string; position: string } | null;
}

export interface AgentApi {
  state: () => AgentState;
  search: (query: string) => { count: number; top: Array<{ position: number; title: string; type: string; relevance: number }> };
  open: (position: number | null) => { title: string; type: string; position: number | null } | { error: string; next_action: string };
  step: (delta: 1 | -1) => { title: string; type: string; position: string } | { error: string; next_action: string };
  close: () => boolean;
}

/** Thrown by the app while it is still loading; turned into a handled result. */
export class AgentNotReady extends Error {}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** Docs: only `readOnlyHint` and `untrustedContentHint` exist (both default to false). */
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown, options?: { signal?: AbortSignal }) => Promise<string>;
}

interface ModelContextLike {
  registerTool: (tool: ToolDefinition, options?: { signal?: AbortSignal }) => unknown;
  /** Docs ("Listing your tools"): resolves to the tools this document registered. */
  getTools?: () => Promise<unknown[]> | unknown[];
  /** Docs: a `toolchange` event fires when this document's registrations change. */
  addEventListener?: (type: string, listener: () => void) => void;
}

/** Which per-screen tool set applies: the mosaic/results screen or the full-screen viewer. */
export type ToolScreen = 'browse' | 'viewer';

/** Registered once at launch and never aborted. */
export const ALWAYS_ON_TOOLS = ['mosaic_get_state', 'mosaic_search'] as const;
/** Registered while their screen is shown, aborted when it goes away. */
export const SCREEN_TOOLS: Record<ToolScreen, readonly string[]> = {
  browse: ['mosaic_open_item'],
  viewer: ['mosaic_next_item', 'mosaic_previous_item', 'mosaic_close_viewer'],
};

export const screenFor = (mode: AgentMode): ToolScreen => (mode === 'viewer' ? 'viewer' : 'browse');

const toolsOn = (mode: AgentMode): string[] => [...ALWAYS_ON_TOOLS, ...SCREEN_TOOLS[screenFor(mode)]];

/** Titles come from Wikimedia Commons contributors: strip control characters and markup. */
const clean = (text: string) => text.replace(/[\p{Cc}<>`]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** A handled condition (skill pattern): an ordinary result Meta AI can explain and act on. */
function problem(message: string, next_action: string): string {
  return JSON.stringify({ error: true, message, next_action });
}

function describeState(s: AgentState): string {
  const item = s.item ? `"${clean(s.item.title)}" (${s.item.type}, ${s.item.position})` : 'nothing';
  if (s.mode === 'viewer') return `Viewer is open on ${item}${s.query ? ` from the results for "${clean(s.query)}"` : ''}.`;
  if (s.mode === 'results') return `Showing ${s.matches} matches for "${clean(s.query)}"; focused: ${item}.`;
  return `Browsing the whole mosaic; focused: ${item}.`;
}

function stateJson(s: AgentState): Record<string, unknown> {
  return {
    mode: s.mode,
    query: s.query ? clean(s.query) : null,
    matches: s.matches,
    item: s.item ? { title: clean(s.item.title), type: s.item.type, position: s.item.position } : null,
    summary: describeState(s),
  };
}

/** Runs a tool body; "still loading" becomes a handled result, other errors propagate (unactionable). */
async function guard(body: () => string): Promise<string> {
  try {
    return body();
  } catch (error) {
    if (error instanceof AgentNotReady) {
      return problem('Glass Mosaic is still loading.', 'Wait a moment and call the same tool again.');
    }
    throw error;
  }
}

export function agentToolDefinitions(api: AgentApi): ToolDefinition[] {
  return [
    // Registered first on purpose (samples): a host probing the first
    // argument-less tool gets a read-only one.
    {
      name: 'mosaic_get_state',
      description:
        'Read what the wearer is looking at, without changing anything: the screen (mosaic, results or viewer), the current search and match count, and the focused or open item with its type and position. Call it first when unsure, e.g. "what am I looking at?" or "what is this?".',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () =>
        guard(() => {
          const state = api.state();
          return JSON.stringify({ ...stateJson(state), tools_now: toolsOn(state.mode), next_action: 'Answer in one short sentence. Stop and talk.' });
        }),
    },
    {
      name: 'mosaic_search',
      description:
        'Search the on-screen mosaic of photos, videos and sounds and rearrange it around the best matches. Use for every "show me X", "find X", "search for X in the mosaic", "any videos of X?" or "play rain sounds". Pass the subject in a few words. Returns the match count and the top titles with positions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The subject the wearer named, in a few words: <subject>, optionally with a media type, as in <subject> video or <subject> sounds.' },
        },
        required: ['query'],
      },
      annotations: { untrustedContentHint: true },
      execute: (input) =>
        guard(() => {
          const query = record(input).query;
          if (typeof query !== 'string' || !query.trim()) {
            return problem('The search needs a subject.', 'Call mosaic_search again with the subject the wearer named, in a few words.');
          }
          const result = api.search(query.slice(0, 80));
          if (!result.count) {
            return problem(`Nothing matched "${clean(query)}".`, 'Try one simpler or different word with mosaic_search.');
          }
          return JSON.stringify({
            query: clean(query),
            matches: result.count,
            top: result.top.map((hit) => ({ position: hit.position, title: clean(hit.title), type: hit.type })),
            next_action: 'The results are on screen. Confirm in one short sentence and stop. Call mosaic_open_item only if the wearer asks to open one.',
          });
        }),
    },
    {
      name: 'mosaic_open_item',
      description:
        'Open one item of the mosaic or the search results full screen: "open the first one", "show me number 3", "open this". position is the 1-based position from mosaic_search; omit it to open the card that is focused now. Offered on the mosaic and results screens; in the viewer use mosaic_close_viewer first.',
      inputSchema: {
        type: 'object',
        properties: { position: { type: 'number', description: 'Whole number, 1-based position in the current results (1 is the best match). Omit to open the card that is focused now.' } },
      },
      annotations: { untrustedContentHint: true },
      execute: (input) =>
        guard(() => {
          const raw = record(input).position;
          let position: number | null = null;
          if (raw !== undefined && raw !== null && raw !== '') {
            const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
            if (!Number.isInteger(n) || n < 1) {
              return problem('position must be a whole number starting at 1.', 'Call mosaic_open_item with a position such as 1, or with none.');
            }
            position = n;
          }
          const result = api.open(position);
          if ('error' in result) return problem(result.error.replace(/_/g, ' '), result.next_action);
          return JSON.stringify({ ...stateJson(api.state()), next_action: 'Say the title in one short sentence. Stop and talk.' });
        }),
    },
    {
      name: 'mosaic_next_item',
      description: 'In the full-screen viewer, show the next item: "next", "the next one", "skip". Steps to the next result, or the next card when browsing. Offered only while the viewer is open.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { untrustedContentHint: true },
      execute: () =>
        guard(() => {
          const result = api.step(1);
          if ('error' in result) return problem('There is nothing further in that direction.', result.next_action);
          return JSON.stringify({ ...stateJson(api.state()), next_action: 'Say the title in one short sentence. Stop and talk.' });
        }),
    },
    {
      name: 'mosaic_previous_item',
      description: 'In the full-screen viewer, show the previous item: "previous", "go back one", "the one before". Offered only while the viewer is open.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { untrustedContentHint: true },
      execute: () =>
        guard(() => {
          const result = api.step(-1);
          if ('error' in result) return problem('There is nothing further in that direction.', result.next_action);
          return JSON.stringify({ ...stateJson(api.state()), next_action: 'Say the title in one short sentence. Stop and talk.' });
        }),
    },
    {
      name: 'mosaic_close_viewer',
      description: 'Close the full-screen viewer and return to the mosaic or the results: "close", "close this", "back to the mosaic". Offered only while the viewer is open.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { untrustedContentHint: true },
      execute: () =>
        guard(() => {
          const closed = api.close();
          return JSON.stringify({
            closed,
            ...stateJson(api.state()),
            next_action: closed ? 'Confirm in a few words. Stop and talk.' : 'The viewer was not open. Say so briefly.',
          });
        }),
    },
  ];
}

/** Registration failures of this session, for the diagnostics line. */
export const registrationErrors: string[] = [];
/** Names whose registration settled and has not been aborted (fallback when there is no getTools). */
const liveNames = new Set<string>();

function note(name: string, error: unknown): void {
  const entry = `${name}: ${(error as Error)?.name ?? 'Error'}`;
  // Screens are swapped many times a session: log each distinct failure once.
  if (!registrationErrors.includes(entry)) registrationErrors.push(entry);
  console.warn(`[webmcp] ${name} was not registered`, error);
}

/**
 * Skill pattern: `registerTool` may throw synchronously, and may return a
 * promise, a handle or nothing, so only chain on a thenable and with
 * `then(undefined, …)`. One call per tool, so a failure cannot strand the rest.
 * A rejection caused by our own abort (a screen left before the registration
 * settled) is expected and not reported as a failure.
 */
function safeRegister(context: ModelContextLike, tool: ToolDefinition, signal: AbortSignal): Promise<void> {
  const settled = () => {
    if (signal.aborted) return;
    liveNames.add(tool.name);
    signal.addEventListener('abort', () => liveNames.delete(tool.name), { once: true });
  };
  const failed = (error: unknown) => {
    if (!signal.aborted) note(tool.name, error);
  };
  try {
    const result = context.registerTool(tool, { signal });
    if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
      return new Promise((resolve) => {
        (result as PromiseLike<unknown>).then(
          () => {
            settled();
            resolve();
          },
          (error: unknown) => {
            failed(error);
            resolve();
          },
        );
      });
    }
    settled();
  } catch (error) {
    failed(error);
  }
  return Promise.resolve();
}

export interface AgentTools {
  /** False when `document.modelContext` is absent: every method is then a no-op. */
  readonly available: boolean;
  /** The screen whose tool set is registered now. */
  readonly screen: ToolScreen;
  /** Settles when the always-on tools and the initial screen's tools have settled. */
  readonly ready: Promise<void>;
  /**
   * Swaps the per-screen tool set: aborts the previous set first, then
   * registers the new one. Idempotent: the current screen is a no-op.
   * Resolves when the new registrations have settled.
   */
  setScreen: (screen: ToolScreen) => Promise<void>;
  /** Calls `listener` on every `toolchange` event (when the host fires it) and after every screen swap settles. */
  onChange: (listener: () => void) => void;
  /** Aborts every registration (tests / teardown). */
  dispose: () => void;
}

/**
 * Registers the always-on tools and the `initial` screen's tools on the host
 * `document.modelContext` when it exists. Call it at launch: eligibility is
 * decided when the Web App launches.
 */
export function registerAgentTools(api: AgentApi, initial: ToolScreen = 'browse'): AgentTools {
  const context = (document as Document & { modelContext?: ModelContextLike }).modelContext;
  if (!context || typeof context.registerTool !== 'function') {
    let screen = initial;
    return {
      available: false,
      get screen() {
        return screen;
      },
      ready: Promise.resolve(),
      setScreen: (next) => {
        screen = next;
        return Promise.resolve();
      },
      onChange: () => {},
      dispose: () => {},
    };
  }
  const byName = new Map(agentToolDefinitions(api).map((tool) => [tool.name, tool]));
  const listeners: Array<() => void> = [];
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.warn('[webmcp] toolchange listener failed', error);
      }
    }
  };
  try {
    context.addEventListener?.('toolchange', emit);
  } catch {
    // An odd host must not break the app; screen swaps still notify.
  }
  const register = (names: readonly string[], signal: AbortSignal) =>
    Promise.all(names.map((name) => safeRegister(context, byName.get(name)!, signal))).then(() => undefined);

  const always = new AbortController();
  const alwaysReady = register(ALWAYS_ON_TOOLS, always.signal);
  let screen = initial;
  let controller = new AbortController();
  const screenReady = register(SCREEN_TOOLS[screen], controller.signal);

  return {
    available: true,
    get screen() {
      return screen;
    },
    ready: Promise.all([alwaysReady, screenReady]).then(() => undefined),
    setScreen(next) {
      if (next === screen && !controller.signal.aborted) return Promise.resolve();
      // Unregister first: a duplicate name rejects, it does not replace.
      controller.abort();
      screen = next;
      controller = new AbortController();
      return register(SCREEN_TOOLS[next], controller.signal).then(emit);
    },
    onChange(listener) {
      listeners.push(listener);
    },
    dispose() {
      controller.abort();
      always.abort();
    },
  };
}

/**
 * One-line WebMCP diagnostic: "WebMCP: unavailable" when `document.modelContext`
 * is undefined, else "WebMCP: N tools" from `getTools()` (with their names when
 * `withNames`), plus any registration errors. The count changes per screen.
 * Per the docs, `getTools()` only reflects this page's registry; it does not
 * prove that Meta AI sees the tools.
 */
export async function webmcpStatus(withNames = false): Promise<string> {
  const context = (document as Document & { modelContext?: ModelContextLike }).modelContext;
  if (!context) return 'WebMCP: unavailable';
  let names: string[] = [...liveNames];
  let text: string;
  if (typeof context.getTools === 'function') {
    try {
      const tools = await context.getTools();
      const list = Array.isArray(tools) ? tools : [];
      names = list.map((t) => String((t as { name?: unknown })?.name ?? '?'));
      text = `WebMCP: ${list.length} tools`;
    } catch (error) {
      text = `WebMCP: getTools failed (${(error as Error)?.name ?? 'Error'})`;
    }
  } else {
    text = `WebMCP: ${liveNames.size} registered (no getTools)`;
  }
  if (withNames && names.length) text += ` (${names.join(', ')})`;
  if (registrationErrors.length) text += ` · ${registrationErrors.length} failed: ${registrationErrors.join(', ')}`;
  return text;
}

/** Clears the registration log (tests). */
export function resetRegistrationLog(): void {
  registrationErrors.length = 0;
  liveNames.clear();
}

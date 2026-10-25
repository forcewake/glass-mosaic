/**
 * "Sample-style" WebMCP mode, opt-in with `?webmcp=simple` (a field test).
 *
 * Mirrors facebook/meta_glasses_webmcp (examples/magic-ball, examples/todo)
 * as closely as possible, to rule our own registration choices in or out:
 *   - all six mosaic_* tools registered once, synchronously, at module load,
 *     mosaic_get_state first;
 *   - `registerTool(tool)` with no options argument and no AbortSignal, and
 *     no per-screen re-registration;
 *   - only the annotations the samples use: `readOnlyHint` on get_state;
 *   - results are JSON strings with `ok` and `next_action`;
 *   - every tool works on every screen and never throws;
 *   - a call log ring buffer (window.GlassMosaic.log), as magic-ball's.
 *
 * The default mode (webmcp.ts) is untouched by this file.
 */
import { AgentNotReady, type AgentApi, type AgentState } from './webmcp';

export const SIMPLE_TOOL_NAMES = [
  'mosaic_get_state',
  'mosaic_search',
  'mosaic_open_item',
  'mosaic_next_item',
  'mosaic_previous_item',
  'mosaic_close_viewer',
] as const;

/** Short title in the samples' style (examples/todo/index.html). */
export const SIMPLE_TITLE =
  'Glass Mosaic — a mosaic of photos, videos and sounds. Always act with a mosaic_* tool: search, open, next, previous, close. Never answer with a description of what you would do.';

export const SIMPLE_DESCRIPTION =
  'Glass Mosaic. For any "show me X" or "find X", call mosaic_search. The wearer watches the screen: reply in one short sentence.';

export function simpleTitle(state: AgentState): string {
  return `${SIMPLE_TITLE} Screen: ${state.mode}.`;
}

export function isSimpleMode(search: string): boolean {
  return new URLSearchParams(search).get('webmcp') === 'simple';
}

export interface SimpleTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean };
  execute: (input: unknown) => Promise<string>;
}

export interface CallRecord {
  tool: string;
  args: unknown;
  ok: boolean;
  detail: string;
  at: string;
}

const CALL_LOG_LIMIT = 25;

/** Ring buffer of every tool invocation and how it ended (magic-ball/src/mcp.ts). */
export function createCallLog(limit = CALL_LOG_LIMIT) {
  const log: CallRecord[] = [];
  const record = (tool: string, args: unknown, ok: boolean, detail: string) => {
    log.push({ tool, args, ok, detail, at: new Date().toISOString() });
    if (log.length > limit) log.shift();
  };
  return { log, record };
}

const clean = (text: string) => text.replace(/[\p{Cc}<>`]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);

function stateJson(s: AgentState): Record<string, unknown> {
  return {
    screen: s.mode,
    query: s.query ? clean(s.query) : null,
    matches: s.matches,
    item: s.item ? { title: clean(s.item.title), type: s.item.type, position: s.item.position } : null,
  };
}

function args(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

const ok = (payload: Record<string, unknown>, next_action: string) => JSON.stringify({ ok: true, ...payload, next_action });
const fail = (message: string, next_action: string) => JSON.stringify({ ok: false, message, next_action });

export interface SimpleOptions {
  /**
   * Resolves once a viewer close has settled. Closing the viewer goes through
   * `history.back()`, whose popstate arrives asynchronously; a search or open
   * pushed before it lands would be undone by it.
   */
  settle?: () => Promise<void>;
}

export function simpleToolDefinitions(
  api: AgentApi,
  record: (tool: string, args: unknown, ok: boolean, detail: string) => void = () => {},
  options: SimpleOptions = {},
): SimpleTool[] {
  const settle = options.settle ?? (() => Promise.resolve());
  /** Leaves the viewer first (and waits for history) when it is open. */
  const leaveViewer = async () => {
    if (api.state().mode === 'viewer' && api.close()) await settle();
  };
  const run =
    (name: string, body: (a: Record<string, unknown>) => string, before?: () => Promise<void>) =>
    async (input: unknown): Promise<string> => {
      let result: string;
      try {
        if (before) await before();
        result = body(args(input));
      } catch (error) {
        result =
          error instanceof AgentNotReady
            ? fail('Glass Mosaic is still loading.', 'Wait a moment and call the same tool again.')
            : fail(`${name} failed: ${error instanceof Error ? error.message : String(error)}`, 'Call mosaic_get_state, then try again.');
      }
      let good = false;
      try {
        good = JSON.parse(result).ok === true;
      } catch {
        // keep false
      }
      record(name, input, good, result.slice(0, 200));
      return result;
    };

  const step = (delta: 1 | -1, name: string) =>
    run(name, () => {
      if (api.state().mode !== 'viewer') {
        // Outside the viewer: open the focused card instead of failing.
        const opened = api.open(null);
        if ('error' in opened) return fail('Nothing is focused to open.', 'Call mosaic_search, then mosaic_open_item.');
        return ok({ opened: true, ...stateJson(api.state()) }, 'Say the title in one short sentence, then stop.');
      }
      const result = api.step(delta);
      if ('error' in result) return fail('There is nothing further in that direction.', 'Tell the wearer briefly, then stop.');
      return ok(stateJson(api.state()), 'Say the title in one short sentence, then stop.');
    });

  return [
    {
      name: 'mosaic_get_state',
      description: 'Read what is on screen without changing anything: the screen, the search, and the focused or open item.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: run('mosaic_get_state', () => ok(stateJson(api.state()), 'Answer in one short sentence.')),
    },
    {
      name: 'mosaic_search',
      description: 'Search the mosaic and show the matches on screen. Use for "show me X", "find X" or "search for X".',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to search for, in a few words.' } },
        required: ['query'],
      },
      execute: run('mosaic_search', (a) => {
        const query = typeof a.query === 'string' ? a.query.trim() : '';
        if (!query) return fail('The search needs a subject.', 'Call mosaic_search with what the wearer asked for.');
        const result = api.search(query.slice(0, 80));
        if (!result.count) return fail(`Nothing matched "${clean(query)}".`, 'Try one simpler word with mosaic_search.');
        return ok(
          { query: clean(query), matches: result.count, top: result.top.map((h) => ({ position: h.position, title: clean(h.title), type: h.type })) },
          'The results are on screen. Confirm in one short sentence, then stop.',
        );
      }, leaveViewer),
    },
    {
      name: 'mosaic_open_item',
      description: 'Open one item full screen. position is 1-based in the search results; omit it to open the focused item.',
      inputSchema: {
        type: 'object',
        properties: { position: { type: 'number', description: '1-based position in the results. Optional.' } },
      },
      execute: run('mosaic_open_item', (a) => {
        const raw = a.position;
        let position: number | null = null;
        if (raw !== undefined && raw !== null && raw !== '') {
          const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
          if (!Number.isInteger(n) || n < 1) return fail('position must be a whole number from 1.', 'Call mosaic_open_item with a position, or none.');
          position = n;
        }
        const result = api.open(position);
        if ('error' in result) return fail(result.error.replace(/_/g, ' '), result.next_action);
        return ok(stateJson(api.state()), 'Say the title in one short sentence, then stop.');
      }, leaveViewer),
    },
    {
      name: 'mosaic_next_item',
      description: 'Show the next item in the viewer. Outside the viewer it opens the focused item.',
      inputSchema: { type: 'object', properties: {} },
      execute: step(1, 'mosaic_next_item'),
    },
    {
      name: 'mosaic_previous_item',
      description: 'Show the previous item in the viewer. Outside the viewer it opens the focused item.',
      inputSchema: { type: 'object', properties: {} },
      execute: step(-1, 'mosaic_previous_item'),
    },
    {
      name: 'mosaic_close_viewer',
      description: 'Close the full-screen viewer and go back to the mosaic or the results.',
      inputSchema: { type: 'object', properties: {} },
      execute: run('mosaic_close_viewer', () => {
        if (!api.close()) return fail('The viewer is not open.', 'Say so briefly, then stop.');
        return ok(stateJson(api.state()), 'Confirm in a few words, then stop.');
      }),
    },
  ];
}

interface SimpleContext {
  registerTool?: (tool: unknown) => unknown;
  getTools?: () => Promise<unknown[]> | unknown[];
}

export interface SimpleRegistration {
  available: boolean;
  registered: string[];
  errors: string[];
}

/**
 * Samples' handoff (examples/magic-ball/src/webmcp.ts publishToContext): one
 * `registerTool(tool)` per tool, no options, best effort. Synchronous.
 */
export function registerSimpleTools(tools: SimpleTool[], doc: { modelContext?: SimpleContext } = document as never): SimpleRegistration {
  const ctx = doc.modelContext;
  const out: SimpleRegistration = { available: false, registered: [], errors: [] };
  if (!ctx || typeof ctx.registerTool !== 'function') return out;
  out.available = true;
  for (const tool of tools) {
    try {
      const result = ctx.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: tool.execute,
      });
      out.registered.push(tool.name);
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, (error: unknown) => {
          out.errors.push(`${tool.name}: ${(error as Error)?.name ?? 'Error'}`);
          out.registered = out.registered.filter((n) => n !== tool.name);
        });
      }
    } catch (error) {
      out.errors.push(`${tool.name}: ${(error as Error)?.name ?? 'Error'}`);
    }
  }
  return out;
}

/** "WebMCP simple: N tools", from getTools() when present. */
export async function simpleStatus(reg: SimpleRegistration, withNames = false, doc: { modelContext?: SimpleContext } = document as never): Promise<string> {
  if (!reg.available) return 'WebMCP simple: unavailable';
  let names = [...reg.registered];
  const ctx = doc.modelContext;
  if (ctx && typeof ctx.getTools === 'function') {
    try {
      const list = await ctx.getTools();
      if (Array.isArray(list)) names = list.map((t) => String((t as { name?: unknown })?.name ?? '?'));
    } catch {
      // fall back to the local list
    }
  }
  let text = `WebMCP simple: ${names.length} tools`;
  if (withNames && names.length) text += ` (${names.join(', ')})`;
  if (reg.errors.length) text += ` · ${reg.errors.length} failed: ${reg.errors.join(', ')}`;
  return text;
}

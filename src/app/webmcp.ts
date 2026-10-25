/**
 * Optional WebMCP tools (BETA) for Meta AI on the glasses.
 *
 * Follows https://wearables.developer.meta.com/docs/webapps/guides/agent-tools:
 *   - feature-detect `document.modelContext`; the app is fully usable without it;
 *   - `registerTool({ name, description, inputSchema, annotations, execute })`;
 *   - `execute(input, { signal })` validates `input` itself, returns short
 *     text, throws only for conditions the assistant cannot act on;
 *   - names are short, distinct and not reserved;
 *   - `untrustedContentHint` is set because results quote Wikimedia Commons
 *     titles that this app did not author.
 *
 * All four tools are registered once at start-up and stay valid on every
 * screen (each one works whether or not the viewer is open), so there is
 * nothing to unregister. WebMCP is off by default: it reaches the assistant
 * only on devices in Developer Mode or in the rollout.
 */

export interface AgentApi {
  search: (query: string) => { count: number; top: Array<{ position: number; title: string; type: string; relevance: number }> };
  open: (position: number | null) => { title: string; type: string; position: number | null } | { error: string; next_action: string };
  step: (delta: 1 | -1) => { title: string; type: string; position: string } | { error: string; next_action: string };
  close: () => boolean;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
}

interface ModelContextLike {
  registerTool: (tool: ToolDefinition) => Promise<void> | void;
  /** Docs ("Listing your tools"): resolves to the tools this document registered. */
  getTools?: () => Promise<unknown[]> | unknown[];
}

/** Registration failures of this session, for the `?debug=1` diagnostics. */
export const registrationErrors: string[] = [];
let registeredCount = 0;

const clean = (text: string) => text.replace(/[\p{Cc}<>`]/gu, ' ').slice(0, 90);

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

export function agentToolDefinitions(api: AgentApi): ToolDefinition[] {
  return [
    {
      name: 'search_mosaic',
      description:
        'Search the photo, video and sound mosaic on screen and rearrange it around the best matches. Use for requests like "show me mountains" or "find rain sounds". Returns how many matched and the top five titles with their positions.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in a few words, e.g. "snowy mountains" or "ocean video".' },
        },
        required: ['query'],
      },
      annotations: { untrustedContentHint: true },
      async execute(input) {
        const query = record(input).query;
        if (typeof query !== 'string' || !query.trim()) throw new Error('query must be a non-empty string.');
        const result = api.search(query.slice(0, 80));
        if (!result.count) {
          return { error: 'no_matches', message: `Nothing matched "${clean(query)}".`, next_action: 'Try a simpler or different word.' };
        }
        const top = result.top.map((hit) => `${hit.position}. ${clean(hit.title)} (${hit.type}, relevance ${hit.relevance.toFixed(2)})`);
        return `Found ${result.count} matches for "${clean(query)}". Best: ${top.join('; ')}. Call open_item with a position to view one.`;
      },
    },
    {
      name: 'open_item',
      description:
        'Open one item of the current search results full screen. position is the 1-based position from search_mosaic; omit it to open the card that is currently focused.',
      inputSchema: {
        type: 'object',
        properties: { position: { type: 'number', description: '1-based position in the current results, e.g. 1 for the best match.' } },
      },
      annotations: { untrustedContentHint: true },
      async execute(input) {
        const raw = record(input).position;
        let position: number | null = null;
        if (raw !== undefined && raw !== null) {
          const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
          if (!Number.isInteger(n) || n < 1) throw new Error('position must be a whole number starting at 1.');
          position = n;
        }
        const result = api.open(position);
        if ('error' in result) return result;
        return `Opened ${clean(result.title)} (${result.type}).`;
      },
    },
    {
      name: 'next_item',
      description: 'Show the next item: the next result in the viewer, or the next card in the mosaic.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { untrustedContentHint: true },
      async execute() {
        const result = api.step(1);
        return 'error' in result ? result : `Now showing ${clean(result.title)} (${result.type}, ${result.position}).`;
      },
    },
    {
      name: 'previous_item',
      description: 'Show the previous item: the previous result in the viewer, or the previous card in the mosaic.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { untrustedContentHint: true },
      async execute() {
        const result = api.step(-1);
        return 'error' in result ? result : `Now showing ${clean(result.title)} (${result.type}, ${result.position}).`;
      },
    },
    {
      name: 'close_viewer',
      description: 'Close the full-screen viewer and return to the mosaic.',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return api.close() ? 'Closed the viewer.' : 'The viewer was not open.';
      },
    },
  ];
}

/** Registers the tools when WebMCP exists. Returns how many registrations were attempted. */
export async function registerAgentTools(api: AgentApi): Promise<number> {
  const context = (document as Document & { modelContext?: ModelContextLike }).modelContext;
  if (!context || typeof context.registerTool !== 'function') return 0;
  const tools = agentToolDefinitions(api);
  await Promise.all(
    tools.map(async (tool) => {
      try {
        await context.registerTool(tool);
        registeredCount++;
      } catch (error) {
        registrationErrors.push(`${tool.name}: ${(error as Error)?.name ?? 'Error'}`);
        console.warn(`[webmcp] ${tool.name} was not registered`, error);
      }
    }),
  );
  return tools.length;
}

/**
 * One-line WebMCP diagnostic for the debug status: "WebMCP: unavailable" when
 * `document.modelContext` is undefined (WebMCP not enabled on this device, or
 * not running as a Web App), else "WebMCP: N tools" from `getTools()`, plus
 * any registration errors. Per the docs, `getTools()` reflects the page's own
 * registry only; it does not prove that Meta AI can see the tools.
 */
export async function webmcpStatus(): Promise<string> {
  const context = (document as Document & { modelContext?: ModelContextLike }).modelContext;
  if (!context) return 'WebMCP: unavailable';
  let text: string;
  if (typeof context.getTools === 'function') {
    try {
      const tools = await context.getTools();
      text = `WebMCP: ${Array.isArray(tools) ? tools.length : '?'} tools`;
    } catch (error) {
      text = `WebMCP: getTools failed (${(error as Error)?.name ?? 'Error'})`;
    }
  } else {
    text = `WebMCP: ${registeredCount} registered (no getTools)`;
  }
  if (registrationErrors.length) text += ` · ${registrationErrors.length} failed: ${registrationErrors.join(', ')}`;
  return text;
}

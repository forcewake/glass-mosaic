import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALWAYS_ON_TOOLS,
  AgentNotReady,
  SCREEN_TOOLS,
  agentToolDefinitions,
  registerAgentTools,
  registrationErrors,
  resetRegistrationLog,
  webmcpStatus,
  type AgentApi,
  type AgentState,
} from '../src/app/webmcp';
import { TITLE_RULE, liveTitle } from '../src/app/title';

const RESERVED = ['openUrl', 'goBack', 'goForward', 'reload', 'getCurrentUrl', 'getPageTitle', 'getPageText'];
const NAMES = [
  'mosaic_get_state',
  'mosaic_search',
  'mosaic_open_item',
  'mosaic_next_item',
  'mosaic_previous_item',
  'mosaic_close_viewer',
];

function api(state: Partial<AgentState> = {}): AgentApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    state: () => ({
      mode: 'results',
      query: 'peaks',
      matches: 2,
      item: { title: 'Peak <b>one</b>', type: 'image', position: '1 of 2' },
      ...state,
    }),
    search: (q) => {
      calls.push(`search:${q}`);
      return q === 'zzz'
        ? { count: 0, top: [] }
        : { count: 2, top: [{ position: 1, title: 'Peak <b>one</b>', type: 'image', relevance: 1 }] };
    },
    open: (p) => {
      calls.push(`open:${p}`);
      return p === 99 ? { error: 'not_found', next_action: 'Use a position from 1 to 2.' } : { title: 'Peak', type: 'image', position: p };
    },
    step: (d) => {
      calls.push(`step:${d}`);
      return { title: 'Next', type: 'image', position: '2 of 2' };
    },
    close: () => {
      calls.push('close');
      return true;
    },
  };
}

const signal = new AbortController().signal;
const parse = async (p: Promise<string>) => JSON.parse(await p) as Record<string, unknown>;

describe('WebMCP tool definitions', () => {
  const tools = agentToolDefinitions(api());

  it('uses mosaic_* names, the read-only state tool first, valid schemas', () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(NAMES);
    expect(new Set(names.map((n) => n.slice(0, 57))).size).toBe(names.length);
    for (const tool of tools) {
      expect(RESERVED).not.toContain(tool.name);
      expect(tool.name).toMatch(/^mosaic_[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.description.length).toBeLessThan(1024);
      expect(tool.inputSchema.type).toBe('object');
      for (const prop of Object.values(tool.inputSchema.properties) as Array<{ type: string; description: string }>) {
        expect(['string', 'number', 'integer', 'boolean']).toContain(prop.type);
        expect(prop.description.length).toBeLessThan(256);
      }
    }
  });

  it('uses only the documented annotations: readOnlyHint on get_state, untrustedContentHint everywhere', () => {
    expect(tools[0].annotations).toEqual({ readOnlyHint: true, untrustedContentHint: true });
    for (const tool of tools) {
      expect(tool.annotations?.untrustedContentHint).toBe(true);
      for (const key of Object.keys(tool.annotations ?? {})) expect(['readOnlyHint', 'untrustedContentHint']).toContain(key);
    }
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(['mosaic_get_state']);
  });

  it('puts no example values in parameter descriptions', () => {
    for (const tool of tools) {
      for (const prop of Object.values(tool.inputSchema.properties) as Array<{ description: string }>) {
        expect(prop.description).not.toMatch(/e\.g\.|"/);
      }
    }
    const search = tools.find((t) => t.name === 'mosaic_search')!;
    expect((search.inputSchema.properties.query as { description: string }).description).toContain('<subject>');
    const open = tools.find((t) => t.name === 'mosaic_open_item')!;
    expect((open.inputSchema.properties.position as { description: string }).description).toMatch(/1-based.*Omit/);
  });

  it('get_state reports the tools offered on the current screen', async () => {
    const [state] = agentToolDefinitions(api({ mode: 'viewer' }));
    expect((await parse(state.execute({}, { signal }))).tools_now).toEqual([...ALWAYS_ON_TOOLS, ...SCREEN_TOOLS.viewer]);
    const [browse] = agentToolDefinitions(api({ mode: 'mosaic' }));
    expect((await parse(browse.execute({}, { signal }))).tools_now).toEqual(['mosaic_get_state', 'mosaic_search', 'mosaic_open_item']);
  });

  it('describes search with the wearer’s phrases', () => {
    const search = tools.find((t) => t.name === 'mosaic_search')!;
    for (const phrase of ['show me X', 'find X', 'search for X in the mosaic']) expect(search.description).toContain(phrase);
  });

  it('runs the app actions, sanitizes text and ends results with next_action', async () => {
    const a = api();
    const [state, search, open, next, prev, close] = agentToolDefinitions(a);
    const s = await parse(state.execute({}, { signal }));
    expect(s).toMatchObject({ mode: 'results', query: 'peaks', matches: 2, item: { type: 'image', position: '1 of 2' } });
    expect(String(s.summary)).toContain('2 matches for "peaks"');
    const result = await search.execute({ query: 'peaks' }, { signal });
    expect(result).not.toContain('<b>');
    expect(JSON.parse(result).next_action).toBeTruthy();
    await open.execute({ position: 1 }, { signal });
    await open.execute({ position: '2' }, { signal });
    await open.execute({}, { signal });
    await next.execute({}, { signal });
    await prev.execute({}, { signal });
    expect((await parse(close.execute({}, { signal }))).closed).toBe(true);
    expect(a.calls).toEqual(['search:peaks', 'open:1', 'open:2', 'open:null', 'step:1', 'step:-1', 'close']);
  });

  it('returns handled conditions as {error, message, next_action} instead of throwing', async () => {
    const [, search, open] = agentToolDefinitions(api());
    for (const p of [
      search.execute({ query: '  ' }, { signal }),
      search.execute({}, { signal }),
      search.execute({ query: 'zzz' }, { signal }),
      open.execute({ position: 0 }, { signal }),
      open.execute({ position: 'two' }, { signal }),
      open.execute({ position: 99 }, { signal }),
    ]) {
      const r = await parse(p);
      expect(r.error).toBe(true);
      expect(typeof r.message).toBe('string');
      expect(typeof r.next_action).toBe('string');
      expect('isError' in r).toBe(false);
    }
  });

  it('reports still-loading as a handled result', async () => {
    const loading = api();
    loading.state = () => {
      throw new AgentNotReady('loading');
    };
    const r = await parse(agentToolDefinitions(loading)[0].execute({}, { signal }));
    expect(r).toMatchObject({ error: true, next_action: expect.stringContaining('again') });
  });
});

describe('Document head guidance', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  it('keeps <title> equal to the standing rule and names every tool', () => {
    const title = /<title>([^<]*)<\/title>/.exec(html)![1];
    expect(title).toBe(TITLE_RULE);
    for (const name of NAMES) expect(title).toContain(name);
    expect(title).toContain('Never answer with a description of what you would do.');
  });

  it('has a meta description with the same guidance', () => {
    const description = /<meta\s+name="description"\s+content="([^"]*)"/.exec(html)![1];
    expect(description).toContain('mosaic_search');
    expect(description).toContain('mosaic_get_state');
  });

  it('appends the live screen to the title', () => {
    expect(liveTitle({ mode: 'mosaic', query: '', matches: 0, item: null })).toBe(`${TITLE_RULE} Live screen: mosaic.`);
    expect(liveTitle({ mode: 'results', query: 'peaks', matches: 3, item: null })).toContain('results for "peaks" (3 matches)');
    expect(
      liveTitle({ mode: 'viewer', query: 'peaks', matches: 3, item: { title: 'A "peak"', type: 'video', position: '2 of 3' } }),
    ).toContain('viewer, "A peak" (video, 2 of 3)');
  });

  it('ships the persona as llms.txt and agent.md', () => {
    const llms = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8');
    expect(readFileSync(new URL('../public/agent.md', import.meta.url), 'utf8')).toBe(llms);
    for (const name of NAMES) expect(llms).toContain(name);
  });
});

/**
 * A fake `document.modelContext` that behaves like the real registry:
 * a duplicate name rejects with InvalidStateError (it does not replace),
 * a pre-aborted signal rejects with signal.reason, aborting the signal
 * unregisters, and every change fires `toolchange`.
 */
function fakeContext(mode: 'promise' | 'handle' | 'sync-throw' = 'promise', throwFor: string[] = []) {
  const tools = new Map<string, { name: string; execute: (i: unknown, o: { signal: AbortSignal }) => Promise<string> }>();
  const changes: Array<() => void> = [];
  const log: string[] = [];
  const fire = () => changes.forEach((l) => l());
  const registerTool = vi.fn((tool: { name: string; execute: never }, options?: { signal?: AbortSignal }) => {
    if (throwFor.includes(tool.name) && mode === 'sync-throw') throw new TypeError('bad definition');
    const attempt = () => {
      if (tools.has(tool.name)) throw new DOMException('Tool already registered', 'InvalidStateError');
      if (options?.signal?.aborted) throw options.signal.reason;
      tools.set(tool.name, tool);
      log.push(`+${tool.name}`);
      options?.signal?.addEventListener('abort', () => {
        if (tools.get(tool.name) === tool) {
          tools.delete(tool.name);
          log.push(`-${tool.name}`);
          fire();
        }
      });
      fire();
    };
    if (mode === 'promise') {
      try {
        attempt();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    attempt(); // 'handle' / 'sync-throw': a non-thenable return, or a synchronous throw
    return { unregister() {} };
  });
  return {
    tools,
    log,
    registerTool,
    context: {
      registerTool,
      getTools: async () => [...tools.values()].map((t) => ({ name: t.name })),
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'toolchange') changes.push(listener);
      },
    },
  };
}

const BROWSE = ['mosaic_get_state', 'mosaic_search', 'mosaic_open_item'];
const VIEWER = ['mosaic_get_state', 'mosaic_search', 'mosaic_next_item', 'mosaic_previous_item', 'mosaic_close_viewer'];

describe('WebMCP registration', () => {
  beforeEach(() => resetRegistrationLog());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does nothing when the API is absent (default)', async () => {
    vi.stubGlobal('document', {});
    const handle = registerAgentTools(api());
    expect(handle.available).toBe(false);
    await handle.setScreen('viewer');
    expect(handle.screen).toBe('viewer');
  });

  it('registers the always-on tools and the mosaic set at launch, get_state first', async () => {
    const fake = fakeContext();
    vi.stubGlobal('document', { modelContext: fake.context });
    const handle = registerAgentTools(api());
    await handle.ready;
    expect(fake.registerTool.mock.calls.map(([t]) => t.name)).toEqual(BROWSE);
    for (const [, options] of fake.registerTool.mock.calls) expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect([...fake.tools.keys()]).toEqual(BROWSE);
    expect(await webmcpStatus()).toBe('WebMCP: 3 tools');
  });

  it('swaps the per-screen set on viewer open/close and never touches the always-on tools', async () => {
    const fake = fakeContext();
    vi.stubGlobal('document', { modelContext: fake.context });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = registerAgentTools(api());
    await handle.ready;
    await handle.setScreen('viewer');
    expect([...fake.tools.keys()].sort()).toEqual([...VIEWER].sort());
    expect(await webmcpStatus()).toBe('WebMCP: 5 tools');
    await handle.setScreen('browse');
    expect([...fake.tools.keys()].sort()).toEqual([...BROWSE].sort());
    expect(fake.log.filter((e) => e.startsWith('-')).sort()).toEqual(
      ['-mosaic_close_viewer', '-mosaic_next_item', '-mosaic_open_item', '-mosaic_previous_item'],
    );
    expect(fake.log).not.toContain('-mosaic_get_state');
    expect(fake.log).not.toContain('-mosaic_search');
    expect(warn).not.toHaveBeenCalled();
    expect(registrationErrors).toEqual([]);
  });

  it('is idempotent and race-safe under rapid open/close (duplicate names would reject)', async () => {
    const fake = fakeContext();
    vi.stubGlobal('document', { modelContext: fake.context });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = registerAgentTools(api());
    // No awaits between swaps: open, open again, close, open, close, close, open.
    const swaps = (['viewer', 'viewer', 'browse', 'viewer', 'browse', 'browse', 'viewer'] as const).map((s) => handle.setScreen(s));
    await Promise.all([handle.ready, ...swaps]);
    expect([...fake.tools.keys()].sort()).toEqual([...VIEWER].sort());
    expect(warn).not.toHaveBeenCalled();
    expect(registrationErrors).toEqual([]);
    // Repeating the current screen registers nothing new.
    const before = fake.registerTool.mock.calls.length;
    await handle.setScreen('viewer');
    expect(fake.registerTool.mock.calls.length).toBe(before);
  });

  it('notifies on toolchange and after each swap', async () => {
    const fake = fakeContext();
    vi.stubGlobal('document', { modelContext: fake.context });
    const handle = registerAgentTools(api());
    const seen: number[] = [];
    handle.onChange(() => seen.push(fake.tools.size));
    await handle.ready;
    await handle.setScreen('viewer');
    expect(seen).toContain(5);
    expect(seen.at(-1)).toBe(5);
  });

  it('logs a genuine duplicate (a name registered elsewhere) and keeps the rest', async () => {
    const fake = fakeContext();
    fake.tools.set('mosaic_next_item', { name: 'mosaic_next_item', execute: async () => '' });
    vi.stubGlobal('document', { modelContext: fake.context });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = registerAgentTools(api());
    await handle.setScreen('viewer');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(registrationErrors).toEqual(['mosaic_next_item: InvalidStateError']);
    expect(fake.tools.has('mosaic_previous_item')).toBe(true);
    expect(fake.tools.has('mosaic_close_viewer')).toBe(true);
  });

  it('survives a stub that returns a non-thenable (skill), on every screen', async () => {
    const fake = fakeContext('handle');
    vi.stubGlobal('document', { modelContext: { registerTool: fake.registerTool } }); // no getTools
    const handle = registerAgentTools(api());
    await handle.ready;
    expect(await webmcpStatus()).toBe('WebMCP: 3 registered (no getTools)');
    await handle.setScreen('viewer');
    expect([...fake.tools.keys()].sort()).toEqual([...VIEWER].sort());
    expect(await webmcpStatus(true)).toBe(
      'WebMCP: 5 registered (no getTools) (mosaic_get_state, mosaic_search, mosaic_next_item, mosaic_previous_item, mosaic_close_viewer)',
    );
    await handle.setScreen('browse');
    expect(await webmcpStatus()).toBe('WebMCP: 3 registered (no getTools)');
  });

  it('survives a stub that throws synchronously: the other tools still register', async () => {
    const fake = fakeContext('sync-throw', ['mosaic_search', 'mosaic_close_viewer']);
    vi.stubGlobal('document', { modelContext: fake.context });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = registerAgentTools(api());
    await handle.ready;
    expect([...fake.tools.keys()]).toEqual(['mosaic_get_state', 'mosaic_open_item']);
    await handle.setScreen('viewer');
    expect([...fake.tools.keys()].sort()).toEqual(['mosaic_get_state', 'mosaic_next_item', 'mosaic_previous_item']);
    expect(await webmcpStatus()).toBe('WebMCP: 3 tools · 2 failed: mosaic_search: TypeError, mosaic_close_viewer: TypeError');
  });

  it('survives a registerTool whose every call throws', async () => {
    vi.stubGlobal('document', {
      modelContext: {
        registerTool: () => {
          throw new TypeError('nope');
        },
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = registerAgentTools(api());
    await expect(handle.ready).resolves.toBeUndefined();
    await expect(handle.setScreen('viewer')).resolves.toBeUndefined();
    await handle.setScreen('browse');
    await handle.setScreen('viewer');
    // 2 always-on + 1 mosaic + 3 viewer, each distinct failure logged once.
    expect(registrationErrors).toHaveLength(6);
  });
});

describe('WebMCP diagnostics', () => {
  beforeEach(() => resetRegistrationLog());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says unavailable without document.modelContext', async () => {
    vi.stubGlobal('document', {});
    expect(await webmcpStatus()).toBe('WebMCP: unavailable');
  });

  it('lists names on request and reports getTools failures', async () => {
    const fake = fakeContext();
    vi.stubGlobal('document', { modelContext: fake.context });
    await registerAgentTools(api()).ready;
    expect(await webmcpStatus(true)).toBe('WebMCP: 3 tools (mosaic_get_state, mosaic_search, mosaic_open_item)');
    fake.context.getTools = async () => {
      throw new DOMException('x', 'NotAllowedError');
    };
    expect(await webmcpStatus()).toBe('WebMCP: getTools failed (NotAllowedError)');
  });
});

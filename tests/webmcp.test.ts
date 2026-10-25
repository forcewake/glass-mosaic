import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentNotReady,
  agentToolDefinitions,
  registerAgentTools,
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

  it('uses only the samples’ annotations, never untrustedContentHint', () => {
    expect(tools[0].annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
    for (const tool of tools) {
      expect(Object.keys(tool.annotations ?? {})).not.toContain('untrustedContentHint');
      for (const key of Object.keys(tool.annotations ?? {})) {
        expect(['readOnlyHint', 'idempotentHint', 'destructiveHint', 'openWorldHint']).toContain(key);
      }
    }
    expect(tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(['mosaic_get_state']);
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

describe('WebMCP registration', () => {
  beforeEach(() => resetRegistrationLog());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does nothing when the API is absent (default)', async () => {
    vi.stubGlobal('document', {});
    expect(await registerAgentTools(api())).toBe(0);
  });

  it('registers each tool once and survives a rejected registration', async () => {
    const registerTool = vi.fn(async (tool: { name: string }) => {
      if (tool.name === 'mosaic_close_viewer') throw new DOMException('dup', 'InvalidStateError');
    });
    vi.stubGlobal('document', { modelContext: { registerTool } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await registerAgentTools(api())).toBe(6);
    expect(registerTool.mock.calls.map(([t]) => t.name)).toEqual(NAMES);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('survives a synchronous throw and a non-thenable return (skill)', async () => {
    const names: string[] = [];
    const registerTool = vi.fn((tool: { name: string }) => {
      if (tool.name === 'mosaic_search') throw new TypeError('bad');
      names.push(tool.name);
      return { unregister() {} };
    });
    vi.stubGlobal('document', { modelContext: { registerTool } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await registerAgentTools(api())).toBe(6);
    expect(names).toEqual(NAMES.filter((n) => n !== 'mosaic_search'));
    expect(await webmcpStatus()).toBe('WebMCP: 5 registered (no getTools) · 1 failed: mosaic_search: TypeError');
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

  it('counts tools with getTools(), lists names on request and registration errors', async () => {
    const registered: string[] = [];
    vi.stubGlobal('document', {
      modelContext: {
        registerTool: async (tool: { name: string }) => {
          if (tool.name === 'mosaic_open_item') throw new DOMException('dup', 'InvalidStateError');
          registered.push(tool.name);
        },
        getTools: async () => registered.map((name) => ({ name })),
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await registerAgentTools(api());
    expect(await webmcpStatus()).toBe('WebMCP: 5 tools · 1 failed: mosaic_open_item: InvalidStateError');
    expect(await webmcpStatus(true)).toBe(
      'WebMCP: 5 tools (mosaic_get_state, mosaic_search, mosaic_next_item, mosaic_previous_item, mosaic_close_viewer) · 1 failed: mosaic_open_item: InvalidStateError',
    );
  });
});

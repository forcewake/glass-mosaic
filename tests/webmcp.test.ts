import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentToolDefinitions, registerAgentTools, type AgentApi } from '../src/app/webmcp';

const RESERVED = ['openUrl', 'goBack', 'goForward', 'reload', 'getCurrentUrl', 'getPageTitle', 'getPageText'];

function api(): AgentApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    search: (q) => {
      calls.push(`search:${q}`);
      return { count: 2, top: [{ position: 1, title: 'Peak <b>one</b>', type: 'image', relevance: 1 }] };
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

describe('WebMCP tool definitions', () => {
  const tools = agentToolDefinitions(api());

  it('uses valid, unique, non-reserved names with schemas', () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(['search_mosaic', 'open_item', 'next_item', 'previous_item', 'close_viewer']);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of tools) {
      expect(RESERVED).not.toContain(tool.name);
      expect(tool.name.length).toBeLessThanOrEqual(57);
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(20);
      if (tool.inputSchema) expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('marks tools returning catalog text as untrusted content', () => {
    for (const name of ['search_mosaic', 'open_item', 'next_item', 'previous_item']) {
      expect(tools.find((t) => t.name === name)?.annotations?.untrustedContentHint).toBe(true);
    }
  });

  it('runs the app actions and sanitizes text', async () => {
    const a = api();
    const [search, open, next, prev, close] = agentToolDefinitions(a);
    const result = JSON.stringify(await search.execute({ query: 'peaks' }, { signal }));
    expect(result).not.toContain('<b>');
    await open.execute({ position: 1 }, { signal });
    await open.execute({}, { signal });
    await next.execute({}, { signal });
    await prev.execute({}, { signal });
    await close.execute({}, { signal });
    expect(a.calls).toEqual(['search:peaks', 'open:1', 'open:null', 'step:1', 'step:-1', 'close']);
  });

  it('throws on invalid input but returns handled conditions', async () => {
    const [search, open] = agentToolDefinitions(api());
    await expect(search.execute({ query: '  ' }, { signal })).rejects.toThrow();
    await expect(search.execute({}, { signal })).rejects.toThrow();
    await expect(open.execute({ position: 0 }, { signal })).rejects.toThrow();
    await expect(open.execute({ position: 'two' }, { signal })).rejects.toThrow();
    expect(await open.execute({ position: 99 }, { signal })).toMatchObject({ error: 'not_found' });
  });
});

describe('WebMCP registration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing when the API is absent (default)', async () => {
    vi.stubGlobal('document', {});
    expect(await registerAgentTools(api())).toBe(0);
  });

  it('registers each tool once and survives a rejected registration', async () => {
    const registerTool = vi.fn(async (tool: { name: string }) => {
      if (tool.name === 'close_viewer') throw new DOMException('dup', 'InvalidStateError');
    });
    vi.stubGlobal('document', { modelContext: { registerTool } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await registerAgentTools(api())).toBe(5);
    expect(registerTool).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

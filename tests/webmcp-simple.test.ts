import { describe, expect, it } from 'vitest';
import { AgentNotReady, type AgentApi, type AgentState } from '../src/app/webmcp';
import {
  SIMPLE_TITLE,
  SIMPLE_TOOL_NAMES,
  createCallLog,
  isSimpleMode,
  registerSimpleTools,
  simpleStatus,
  simpleTitle,
  simpleToolDefinitions,
} from '../src/app/webmcp-simple';

function fakeApp(initial: AgentState['mode'] = 'mosaic') {
  let mode: AgentState['mode'] = initial;
  const calls: string[] = [];
  const api: AgentApi = {
    state: () => ({ mode, query: mode === 'mosaic' ? '' : 'peaks', matches: mode === 'mosaic' ? 0 : 2, item: { title: 'Peak <b>one</b>', type: 'image', position: '1 of 2' } }),
    search: (q) => {
      calls.push(`search:${q}`);
      mode = 'results';
      return q === 'zzz' ? { count: 0, top: [] } : { count: 2, top: [{ position: 1, title: 'Peak <b>one</b>', type: 'image', relevance: 1 }] };
    },
    open: (p) => {
      calls.push(`open:${p}`);
      if (p === 99) return { error: 'not_found', next_action: 'Use a position from 1 to 2.' };
      mode = 'viewer';
      return { title: 'Peak', type: 'image', position: p };
    },
    step: (d) => {
      calls.push(`step:${d}`);
      return { title: 'Next', type: 'image', position: '2 of 2' };
    },
    close: () => {
      calls.push('close');
      if (mode !== 'viewer') return false;
      mode = 'results';
      return true;
    },
  };
  return { api, calls, setMode: (m: AgentState['mode']) => (mode = m) };
}

const parse = async (p: Promise<string>) => JSON.parse(await p) as Record<string, unknown>;

describe('?webmcp=simple', () => {
  it('is opt-in by query only', () => {
    expect(isSimpleMode('?webmcp=simple')).toBe(true);
    expect(isSimpleMode('?debug=1&webmcp=simple')).toBe(true);
    expect(isSimpleMode('')).toBe(false);
    expect(isSimpleMode('?webmcp=1')).toBe(false);
  });

  it('defines all six tools, get_state first, only readOnlyHint, short descriptions', () => {
    const tools = simpleToolDefinitions(fakeApp().api);
    expect(tools.map((t) => t.name)).toEqual([...SIMPLE_TOOL_NAMES]);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });
    for (const t of tools.slice(1)) expect(t.annotations).toBeUndefined();
    for (const t of tools) expect(t.description.length).toBeLessThan(140);
    expect(SIMPLE_TITLE.length).toBeLessThan(200);
    expect(simpleTitle({ mode: 'viewer', query: '', matches: 0, item: null })).toMatch(/Screen: viewer\.$/);
  });

  it('registers each tool once with exactly one argument (no options, no signal)', () => {
    const seen: unknown[][] = [];
    const doc = { modelContext: { registerTool: (...a: unknown[]) => void seen.push(a) } };
    const reg = registerSimpleTools(simpleToolDefinitions(fakeApp().api), doc);
    expect(reg).toMatchObject({ available: true, errors: [] });
    expect(reg.registered).toEqual([...SIMPLE_TOOL_NAMES]);
    expect(seen).toHaveLength(6);
    for (const call of seen) {
      expect(call).toHaveLength(1);
      expect(Object.keys(call[0] as object).sort()).toEqual(['annotations', 'description', 'execute', 'inputSchema', 'name']);
    }
  });

  it('is a no-op without document.modelContext and survives a throwing host', async () => {
    expect(registerSimpleTools(simpleToolDefinitions(fakeApp().api), {})).toEqual({ available: false, registered: [], errors: [] });
    const doc = {
      modelContext: {
        registerTool: (t: unknown) => {
          if ((t as { name: string }).name === 'mosaic_search') throw new TypeError('bad');
        },
      },
    };
    const reg = registerSimpleTools(simpleToolDefinitions(fakeApp().api), doc);
    expect(reg.registered).toHaveLength(5);
    expect(reg.errors).toEqual(['mosaic_search: TypeError']);
    expect(await simpleStatus(reg, false, doc)).toBe('WebMCP simple: 5 tools · 1 failed: mosaic_search: TypeError');
  });

  it('reports "WebMCP simple: N tools" from getTools', async () => {
    const doc = { modelContext: { registerTool: () => {}, getTools: async () => SIMPLE_TOOL_NAMES.map((name) => ({ name })) } };
    const reg = registerSimpleTools(simpleToolDefinitions(fakeApp().api), doc);
    expect(await simpleStatus(reg, false, doc)).toBe('WebMCP simple: 6 tools');
    expect(await simpleStatus(reg, true, doc)).toContain('(mosaic_get_state, mosaic_search,');
    expect(await simpleStatus({ available: false, registered: [], errors: [] }, false, {})).toBe('WebMCP simple: unavailable');
  });

  it('every result is a JSON string with ok and next_action, sanitized', async () => {
    const app = fakeApp();
    const [state, search, open, next, prev, close] = simpleToolDefinitions(app.api);
    const steps = [() => state.execute({}), () => search.execute({ query: 'peaks' }), () => open.execute({ position: 1 }), () => next.execute({}), () => prev.execute({}), () => close.execute({})];
    for (const runStep of steps) {
      const raw = await runStep();
      expect(raw).not.toContain('<b>');
      const r = JSON.parse(raw);
      expect(r.ok).toBe(true);
      expect(typeof r.next_action).toBe('string');
    }
    expect(app.calls).toEqual(['search:peaks', 'open:1', 'step:1', 'step:-1', 'close']);
  });

  it('next/previous outside the viewer open the focused item; close outside returns ok:false', async () => {
    const app = fakeApp('mosaic');
    const [, , , next, prev, close] = simpleToolDefinitions(app.api);
    expect(await parse(close.execute({}))).toMatchObject({ ok: false, next_action: expect.any(String) });
    expect(await parse(next.execute({}))).toMatchObject({ ok: true, opened: true, screen: 'viewer' });
    app.setMode('results');
    expect(await parse(prev.execute({}))).toMatchObject({ ok: true, opened: true });
    expect(app.calls).toEqual(['close', 'open:null', 'open:null']);
  });

  it('open works from the viewer, and handled problems are ok:false', async () => {
    const app = fakeApp('viewer');
    let settled = 0;
    const [, search, open] = simpleToolDefinitions(app.api, undefined, { settle: async () => void settled++ });
    expect(await parse(open.execute({ position: 2 }))).toMatchObject({ ok: true, screen: 'viewer' });
    // From the viewer: close first, wait for history, then open.
    expect(app.calls).toEqual(['close', 'open:2']);
    expect(settled).toBe(1);
    expect(await parse(open.execute({ position: 99 }))).toMatchObject({ ok: false, next_action: 'Use a position from 1 to 2.' });
    expect(await parse(open.execute({ position: 0 }))).toMatchObject({ ok: false });
    expect(await parse(search.execute({ query: ' ' }))).toMatchObject({ ok: false });
    expect(await parse(search.execute({ query: 'zzz' }))).toMatchObject({ ok: false });
    expect(await parse(search.execute('{"query":"peaks"}'))).toMatchObject({ ok: true, matches: 2 });
  });

  it('never throws: not-ready and unexpected errors become ok:false', async () => {
    const boom = (e: Error): AgentApi => ({
      state: () => {
        throw e;
      },
      search: () => {
        throw e;
      },
      open: () => {
        throw e;
      },
      step: () => {
        throw e;
      },
      close: () => {
        throw e;
      },
    });
    for (const err of [new AgentNotReady('loading'), new Error('kaput')]) {
      for (const tool of simpleToolDefinitions(boom(err))) {
        const r = await parse(tool.execute({ query: 'x' }));
        expect(r.ok).toBe(false);
        expect(r.next_action).toBeTruthy();
      }
    }
  });

  it('keeps a bounded call log', async () => {
    const { log, record } = createCallLog(3);
    const [state, search] = simpleToolDefinitions(fakeApp().api, record);
    await state.execute({});
    await search.execute({ query: '' });
    await search.execute({ query: 'a' });
    await search.execute({ query: 'b' });
    expect(log).toHaveLength(3);
    expect(log.map((r) => [r.tool, r.ok])).toEqual([
      ['mosaic_search', false],
      ['mosaic_search', true],
      ['mosaic_search', true],
    ]);
  });
});

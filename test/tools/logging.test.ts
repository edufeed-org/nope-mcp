import { describe, it, expect, vi } from 'vitest';
import { instrumentToolLogging, summarizeArgs, type ToolLogLine } from '../../src/tools/logging.js';

function fakeServer() {
  const registered: Record<string, (...a: any[]) => any> = {};
  return {
    registered,
    registerTool(name: string, _cfg: unknown, cb: (...a: any[]) => any) { registered[name] = cb; return {} as any; },
  };
}

describe('instrumentToolLogging', () => {
  it('logs name, duration, ok and summarized args for a successful call', async () => {
    const lines: ToolLogLine[] = [];
    const s = fakeServer();
    instrumentToolLogging(s as any, (l) => lines.push(l));
    s.registerTool('search_passages', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
    await s.registered.search_passages({ question: 'x'.repeat(300), kinds: [30142] }, { sessionId: 'sess-1' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ tool: 'search_passages', ok: true, session: 'sess-1' });
    expect((lines[0].args.question as string).length).toBeLessThanOrEqual(121);
    expect(lines[0].args.kinds).toEqual([30142]);
  });
  it('marks isError results and thrown errors as ok:false, rethrowing', async () => {
    const lines: ToolLogLine[] = [];
    const s = fakeServer();
    instrumentToolLogging(s as any, (l) => lines.push(l));
    s.registerTool('a', {}, async () => ({ isError: true, content: [] }));
    s.registerTool('b', {}, async () => { throw new Error('boom'); });
    await s.registered.a({}, {});
    await expect(s.registered.b({}, {})).rejects.toThrow('boom');
    expect(lines.map((l) => l.ok)).toEqual([false, false]);
    expect(lines[1].error).toBe('boom');
  });
  it('marks a JSON text payload carrying an error code as ok:false with that code', async () => {
    const lines: ToolLogLine[] = [];
    const s = fakeServer();
    instrumentToolLogging(s as any, (l) => lines.push(l));
    const payload = JSON.stringify({ error: 'relay_unreachable', message: 'content relay did not answer' });
    s.registerTool('typed', {}, async () => ({ content: [{ type: 'text', text: payload }] }));
    s.registerTool('plainJson', {}, async () => ({ content: [{ type: 'text', text: JSON.stringify({ passages: [] }) }] }));
    s.registerTool('plainText', {}, async () => ({ content: [{ type: 'text', text: 'not json {' }] }));
    await s.registered.typed({}, {});
    await s.registered.plainJson({}, {});
    await s.registered.plainText({}, {});
    expect(lines.map((l) => l.ok)).toEqual([false, true, true]);
    expect(lines[0].error).toBe('relay_unreachable');
  });
});

describe('summarizeArgs', () => {
  it('truncates long strings and abbreviates long arrays', () => {
    const out = summarizeArgs({ s: 'a'.repeat(500), arr: Array.from({ length: 50 }, (_, i) => i), n: 3 });
    expect((out.s as string).endsWith('…')).toBe(true);
    expect(out.arr).toEqual({ length: 50, head: [0, 1, 2, 3, 4] });
    expect(out.n).toBe(3);
  });
});

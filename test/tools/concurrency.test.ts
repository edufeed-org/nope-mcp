import { describe, it, expect } from 'vitest';
import { limitConcurrency, limitToolCalls, parseMaxConcurrent } from '../../src/tools/concurrency.js';

describe('limitConcurrency', () => {
  const gate = () => {
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    return { done, release };
  };

  it('rejects the call above the limit with a busy result, and a finished call frees its slot', async () => {
    const limit = limitConcurrency(2);
    const a = gate();
    const b = gate();
    const slow = (g: { done: Promise<void> }) => limit(async () => (await g.done, 'ok'));
    const first = slow(a)();
    const second = slow(b)();

    const busy = (await limit(async () => 'ok')()) as { isError: boolean; content: { text: string }[] };
    expect(busy.isError).toBe(true);
    expect(busy.content[0].text).toMatch(/busy.*retry/i);

    a.release();
    expect(await first).toBe('ok');
    expect(await limit(async () => 'again')()).toBe('again');
    b.release();
    await second;
  });

  it('frees the slot of a handler that throws', async () => {
    const limit = limitConcurrency(1);
    await expect(limit(async () => { throw new Error('boom'); })()).rejects.toThrow('boom');
    expect(() => limit(() => { throw new Error('sync'); })()).toThrow('sync');
    expect(await limit(async (x: number) => x + 1)(1)).toBe(2);
  });
});

describe('limitToolCalls', () => {
  it('wraps every handler registered afterwards with one shared limit', async () => {
    const handlers: Record<string, (...a: unknown[]) => unknown> = {};
    const server = { registerTool: (name: string, _config: unknown, cb: (...a: unknown[]) => unknown) => { handlers[name] = cb; } };
    limitToolCalls(server as never, 1);
    let release!: () => void;
    server.registerTool('slow', {}, () => new Promise<string>((r) => (release = () => r('done'))));
    server.registerTool('fast', {}, async () => 'fast');

    const running = handlers.slow();
    expect(await handlers.fast()).toMatchObject({ isError: true });
    release();
    await running;
    expect(await handlers.fast()).toBe('fast');
  });
});

describe('parseMaxConcurrent', () => {
  it('defaults to 8 and takes a positive integer', () => {
    expect(parseMaxConcurrent({})).toBe(8);
    expect(parseMaxConcurrent({ CVM_MAX_CONCURRENT: '3' })).toBe(3);
    for (const bad of ['0', '-1', 'abc', '']) expect(parseMaxConcurrent({ CVM_MAX_CONCURRENT: bad })).toBe(8);
  });
});

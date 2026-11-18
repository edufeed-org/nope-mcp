import type { McpServer } from '@modelcontextprotocol/server';

const BUSY = {
  content: [{ type: 'text' as const, text: 'The server is busy with other requests. Retry in a few seconds.' }],
  isError: true,
};

/** CVM_MAX_CONCURRENT: tool calls the Nostr entry runs at the same time (default 8). */
export function parseMaxConcurrent(env: { CVM_MAX_CONCURRENT?: string }): number {
  const n = Number(env.CVM_MAX_CONCURRENT);
  return Number.isInteger(n) && n > 0 ? n : 8;
}

/**
 * At most `max` wrapped handlers run at the same time, counted across all of
 * them; a call above that is answered at once with a busy error result
 * (no queue: a caller that floods must not build up work).
 */
export function limitConcurrency(max: number) {
  let running = 0;
  return <A extends unknown[], R>(handler: (...args: A) => R) =>
    (...args: A): R | typeof BUSY | Promise<Awaited<R>> => {
      if (running >= max) return BUSY;
      running++;
      let result: R;
      try {
        result = handler(...args);
      } catch (err) {
        running--;
        throw err;
      }
      if (!(result instanceof Promise)) {
        running--;
        return result;
      }
      return result.finally(() => running--) as Promise<Awaited<R>>;
    };
}

/** Limit every tool registered on the server from now on. Call before registerTools. */
export function limitToolCalls(server: McpServer, max: number): void {
  const limit = limitConcurrency(max);
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, config: unknown, cb: (...args: unknown[]) => unknown) =>
    original(name, config, limit(cb))) as unknown as McpServer['registerTool'];
}

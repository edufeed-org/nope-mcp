import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** One line per tool call, emitted as JSON on stderr by the default sink. */
export interface ToolLogLine {
  ts: string;
  tool: string;
  ms: number;
  ok: boolean;
  session?: string;
  error?: string;
  args: Record<string, unknown>;
}

const ARRAY_HEAD = 5;

/**
 * Compacts tool arguments for a single log line: strings longer than
 * `maxString` are cut and marked with an ellipsis, arrays longer than five
 * elements collapse to `{ length, head }`, nested objects become truncated
 * JSON. Non-object input is wrapped as `{ value }`.
 */
export function summarizeArgs(args: unknown, maxString = 120): Record<string, unknown> {
  const cut = (s: string): string => (s.length > maxString ? `${s.slice(0, maxString)}…` : s);
  const one = (v: unknown): unknown => {
    if (typeof v === 'string') return cut(v);
    if (Array.isArray(v)) {
      return v.length > ARRAY_HEAD ? { length: v.length, head: v.slice(0, ARRAY_HEAD).map(one) } : v.map(one);
    }
    if (v !== null && typeof v === 'object') return cut(JSON.stringify(v));
    return v;
  };
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { value: one(args) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = one(v);
  return out;
}

type LogLevel = 'silent' | 'error' | 'warn' | 'info';

function logLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw === 'silent' || raw === 'error' || raw === 'warn' ? raw : 'info';
}

/**
 * Writes the line as JSON to stderr — stdout belongs to the stdio transport.
 * LOG_LEVEL=silent suppresses everything; warn/error keep failures only.
 */
export function defaultSink(line: ToolLogLine): void {
  const level = logLevel();
  if (level === 'silent') return;
  if ((level === 'warn' || level === 'error') && line.ok) return;
  console.error(JSON.stringify(line));
}

type RegisterTool = McpServer['registerTool'];
type AnyCallback = (...cbArgs: unknown[]) => unknown;

/**
 * Patches `server.registerTool` so every registered callback is wrapped:
 * duration, outcome (`ok` is false for `isError` results and for thrown
 * errors, which are rethrown unchanged), session id when the transport
 * provides one, and summarized arguments go to `sink` as one ToolLogLine.
 * Must run before the tools are registered.
 */
export function instrumentToolLogging(
  server: Pick<McpServer, 'registerTool'>,
  sink: (line: ToolLogLine) => void = defaultSink,
): void {
  const original = server.registerTool.bind(server) as RegisterTool;
  const patched = ((name: string, config: Parameters<RegisterTool>[1], cb: AnyCallback) => {
    const wrapped: AnyCallback = async (...cbArgs) => {
      // The SDK calls cb(args, extra) for tools with an inputSchema and cb(extra) otherwise.
      const hasArgs = cbArgs.length > 1;
      const args = hasArgs ? cbArgs[0] : {};
      const extra = (hasArgs ? cbArgs[1] : cbArgs[0]) as { sessionId?: string } | undefined;
      const start = performance.now();
      const finish = (ok: boolean, error?: string) => {
        sink({
          ts: new Date().toISOString(),
          tool: name,
          ms: Math.round(performance.now() - start),
          ok,
          ...(extra?.sessionId ? { session: extra.sessionId } : {}),
          ...(error !== undefined ? { error } : {}),
          args: summarizeArgs(args),
        });
      };
      try {
        const result = (await cb(...cbArgs)) as { isError?: boolean } | undefined;
        finish(!result?.isError);
        return result;
      } catch (err) {
        finish(false, err instanceof Error ? err.message : String(err));
        throw err;
      }
    };
    return original(name, config, wrapped as unknown as Parameters<RegisterTool>[2]);
  }) as unknown as RegisterTool;
  server.registerTool = patched;
}

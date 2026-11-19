import { describe, it, expect } from 'vitest';
import { withPublishDeadline } from '../../src/transport/publishDeadline.js';

describe('withPublishDeadline', () => {
  it('gives every publish an abort signal that fires after the deadline', async () => {
    const seen: AbortSignal[] = [];
    class Pool {
      async publish(_event: unknown, opts?: { abortSignal?: AbortSignal }) {
        seen.push(opts!.abortSignal!);
      }
    }
    const Limited = withPublishDeadline(Pool, 20);
    await new Limited().publish({});
    expect(seen[0].aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(seen[0].aborted).toBe(true);
  });
});

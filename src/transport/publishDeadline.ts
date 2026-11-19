/**
 * The SDK's relay pool retries a publish forever unless given an abort signal,
 * and the Nostr transport passes none. An answer a relay will never take (one
 * larger than its message limit, seen live with a 50-result search) then loops
 * and keeps the relay connections resetting. This gives each publish a deadline.
 */
export function withPublishDeadline<T extends new (...args: any[]) => { publish(event: any, opts?: any): Promise<any> }>(
  Pool: T,
  ms: number
): T {
  return class extends Pool {
    publish(event: any, opts?: any) {
      return super.publish(event, { ...opts, abortSignal: AbortSignal.timeout(ms) });
    }
  };
}

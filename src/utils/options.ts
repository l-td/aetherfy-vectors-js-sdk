/**
 * Runtime guard for kwarg-allowlist contracts on options-object methods.
 *
 * Why this exists: TypeScript guards typed callers at compile time, but the
 * SDK ships as JS too. Untyped JS consumers, `as any` casts, and user-input
 * pass-through all bypass type checking, which means a caller passing
 * `{ batchSize: 256, limit: 100 }` to `scrollIter` would silently see the
 * iterator page at the default 256 with `limit` ignored. The Python SDK's
 * keyword-only `def scroll_iter(self, *, batch_size=...)` raises TypeError
 * for unknown kwargs at runtime; this helper gives the JS side the same
 * contract.
 *
 * Sites currently guarded:
 *   - AetherfyVectorsClient.scrollIter  (src/client.ts)
 *   - Namespace.iter                    (src/memory/namespace.ts)
 *   - Thread.iterHistory                (src/memory/thread.ts)
 *
 * Positional-arg methods (set/overwrite/deletePayload, setMetadata) are
 * gap-free by signature and don't need the guard.
 */
export function assertAllowedOptionKeys(
  options: Record<string, unknown>,
  allowed: readonly string[],
  methodName: string,
  guidance?: string
): void {
  const unknown = Object.keys(options).filter(k => !allowed.includes(k));
  if (unknown.length > 0) {
    const guidanceLine = guidance ? ` ${guidance}` : '';
    throw new Error(
      `${methodName}: unknown option(s): ${unknown.join(', ')}.${guidanceLine}`
    );
  }
}

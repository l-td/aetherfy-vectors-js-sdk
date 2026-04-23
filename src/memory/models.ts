/**
 * Models for the Aetherfy Memory SDK.
 */

/**
 * Default vector dimension for auto-created scopes.
 *
 * Matches sentence-transformers `all-MiniLM-L6-v2` (the planned T2-0
 * server-side default embedding model).
 */
export const DEFAULT_VECTOR_SIZE = 384;

/**
 * A single message within a conversation Thread.
 *
 * `ts` is a Unix timestamp (seconds) used to order `thread.history()`.
 * The SDK sets it to `Date.now() / 1000` on add unless the caller
 * provides one explicitly (useful for backfilling historical messages).
 */
export interface Message {
  id: string;
  role: string;
  content: string;
  ts: number;
  vector?: number[];
  metadata?: Record<string, unknown>;
}

/**
 * Reconstruct a Message from a retrieved Qdrant point.
 * @internal
 */
export function messageFromPoint(point: {
  id: string | number;
  vector?: number[];
  payload?: Record<string, unknown>;
}): Message | null {
  const payload = point.payload;
  if (!payload) return null;
  const ts = payload.ts;
  if (typeof ts !== 'number') return null;

  return {
    id: String(point.id),
    role: typeof payload.role === 'string' ? payload.role : '',
    content: typeof payload.content === 'string' ? payload.content : '',
    ts,
    vector: point.vector,
    metadata:
      (payload.metadata as Record<string, unknown> | undefined) ?? undefined,
  };
}

/**
 * UUID-like point ID generator (32 hex chars).
 *
 * Uses `crypto.randomUUID` when available (Node ≥14.17, modern browsers);
 * falls back to `Math.random` — point IDs don't need cryptographic
 * uniqueness, only per-collection uniqueness.
 * @internal
 */
export function generateId(): string {
  const g =
    typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (g?.randomUUID) return g.randomUUID().replace(/-/g, '');
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return out.slice(0, 32);
}

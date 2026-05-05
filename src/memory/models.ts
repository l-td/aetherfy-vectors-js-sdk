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
 * Canonical UUID point ID generator (8-4-4-4-12 hex with hyphens).
 *
 * Returns the same canonical form Qdrant emits on read. The hyphenated
 * form is what scroll/retrieve return; emitting the un-hyphenated 32-char
 * form here would make round-trip ID equality (caller tracks SDK-returned
 * IDs and compares against scroll output) silently fail.
 *
 * Uses `crypto.randomUUID` when available (Node ≥14.17, modern browsers);
 * falls back to `Math.random` formatted into the canonical layout. The
 * fallback is non-cryptographic — point IDs need only per-collection
 * uniqueness, not unforgeability.
 * @internal
 */
export function generateId(): string {
  const g =
    typeof globalThis !== 'undefined'
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (g?.randomUUID) return g.randomUUID();
  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

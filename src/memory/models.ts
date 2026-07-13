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
  /**
   * Point id — a number if the message was stored under an integer id, a
   * string for a UUID. Preserved as stored so `msg.id === <what you wrote>`
   * round-trips intact (no String() coercion on read).
   */
  id: string | number;
  role: string;
  content: string;
  ts: number;
  vector?: number[];
  metadata?: Record<string, unknown>;
}

/**
 * Reconstruct a Message from a retrieved point.
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
    // Preserve the id as stored — an integer point id comes back a number,
    // a UUID a string. String()-coercing here would make `add(id=42)` then
    // `history()` return id "42", breaking the caller's `msg.id === 42` check
    // (the read-side twin of the write-side str() bug).
    id: point.id,
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
 * Returns the same canonical form scroll/retrieve emit on read. Emitting
 * the un-hyphenated 32-char form here would make round-trip ID equality
 * (caller tracks SDK-returned IDs and compares against scroll output)
 * silently fail.
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

/**
 * Namespace — a named, scoped memory bucket backed by one collection.
 *
 * The generic primitive for any agent shape. Extends `Scope` (the shared
 * read / delete / schema / analytics / metadata surface) and adds its own
 * generic-memory write API (`add` / `addMany`).
 *
 * All collection-lifecycle operations (create, list, exists, delete) live
 * on MemoryClient — a Namespace instance always points at an existing scope.
 */

import { EmbeddingNotSupportedError } from './errors';
import { generateId } from './models';
import { Scope } from './scope';

/** Parameters for adding a memory to a Namespace. */
export interface NamespaceAddOptions {
  /** Original text; stored under `text` on the point payload. */
  text?: string;
  /** The embedding vector. Required today (server-side embedding → T2-0). */
  vector?: number[];
  /** Arbitrary user metadata; stored under `metadata` (no reserved-field collisions). */
  metadata?: Record<string, unknown>;
  /** Optional point ID. UUID-like string generated if omitted. */
  id?: string | number;
}

export class Namespace extends Scope {
  /**
   * Namespace payload top-level reserved fields — a Namespace payload is
   * `{ text?, metadata? }`, so `text` is the name that shouldn't appear in
   * a user metadata partial. See `Scope.mergeMetadata`.
   * @internal
   */
  protected static override readonly RESERVED_KEYS: ReadonlySet<string> =
    new Set(['text']);

  // -------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------

  /**
   * Add a memory to this namespace.
   * Returns the point ID used for the write.
   */
  async add(options: NamespaceAddOptions): Promise<string | number> {
    const { vector, text, metadata, id } = options;
    if (!vector) throw new EmbeddingNotSupportedError();

    // Pass an explicit id through as-authored — a number stays a number (a
    // valid unsigned-integer point id). String()-coercing it would turn 42
    // into "42", a numeric string the ingress validator rejects. Default to
    // a UUID when omitted; a non-int/non-uuid explicit id is left for
    // validatePointId (in client.upsert) to reject loudly.
    const pointId = id !== undefined ? id : generateId();
    const payload: Record<string, unknown> = {};
    if (text !== undefined) payload.text = text;
    if (metadata) payload.metadata = metadata;

    await this.client.upsert(this.collection, [
      { id: pointId, vector, payload },
    ]);
    return pointId;
  }

  /**
   * Add many memories in a single round trip.
   *
   * Each item is validated like `add` (vector required), and missing
   * IDs get a UUID generated per item. Returns IDs in input order so
   * callers can correlate.
   *
   * Server handles streaming-chunking of the resulting upsert, so this
   * method does NOT itself chunk — pass however many items you want.
   *
   * Empty input returns `[]` without a round trip (degenerate-input
   * tolerance for dynamically-built lists).
   */
  async addMany(items: NamespaceAddOptions[]): Promise<Array<string | number>> {
    if (!Array.isArray(items)) {
      throw new TypeError('addMany requires an array of NamespaceAddOptions');
    }
    if (items.length === 0) return [];

    const points = items.map((item, idx) => {
      const { vector, text, metadata, id } = item;
      if (!vector) {
        throw new EmbeddingNotSupportedError(`addMany[${idx}]`);
      }
      // Explicit id as-authored (a number stays a number); default UUID when
      // omitted. See add() — no blanket String() coercion.
      const pointId = id !== undefined ? id : generateId();
      const payload: Record<string, unknown> = {};
      if (text !== undefined) payload.text = text;
      if (metadata) payload.metadata = metadata;
      return { id: pointId, vector, payload };
    });

    await this.client.upsert(this.collection, points);
    return points.map(p => p.id);
  }
}

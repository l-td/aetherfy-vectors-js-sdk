/**
 * Thread — a conversation-shaped scope.
 *
 * Payloads follow a `{ role, content, ts, metadata }` schema. Adds expose
 * `history(limit, order)` for ordered retrieval of messages.
 *
 * Every add writes three reserved fields on the point payload:
 * `role`, `content`, and `ts` (Unix seconds). User metadata lives
 * under `metadata` so it can't shadow reserved fields.
 *
 * Thread does NOT extend Namespace: their write APIs differ (a message
 * requires `role`/`content`; a memory uses `text`), so a Thread is not
 * add-substitutable for a Namespace. Both share the read/scope surface via
 * `Scope`.
 */

import { AetherfyVectorsClient } from '../client';
import { assertAllowedOptionKeys } from '../utils/options';
import { EmbeddingNotSupportedError } from './errors';
import { generateId, Message, messageFromPoint } from './models';
import { Scope } from './scope';

export interface ThreadAddOptions {
  role: string;
  content: string;
  /** Embedding vector. Required today; server-side embedding → T2-0. */
  vector?: number[];
  /** Optional metadata; stored nested (cannot shadow role/content/ts). */
  metadata?: Record<string, unknown>;
  /** Optional point ID. UUID-like string generated if omitted. */
  id?: string | number;
  /** Optional Unix-seconds timestamp. `Date.now()/1000` if omitted. */
  ts?: number;
}

export interface ThreadHistoryOptions {
  /** Max messages to return (default 50). */
  limit?: number;
  /** "asc" (oldest first, default) or "desc" (newest first). */
  order?: 'asc' | 'desc';
}

export class Thread extends Scope {
  /**
   * Thread payload top-level reserved fields — a Thread payload is
   * `{ role, content, ts, metadata }`, so role/content/ts are the names
   * that shouldn't appear in a user metadata partial. See
   * `Scope.mergeMetadata`.
   * @internal
   */
  protected static override readonly RESERVED_KEYS: ReadonlySet<string> =
    new Set(['role', 'content', 'ts']);

  /**
   * Internal — callers use MemoryClient.thread(id) to construct.
   * @internal
   */
  constructor(
    threadId: string,
    collection: string,
    client: AetherfyVectorsClient
  ) {
    super(threadId, collection, client);
  }

  /** The thread id (same as `name`; provided for parity with Python SDK). */
  get id(): string {
    return this.name;
  }

  // -------------------------------------------------------------------
  // Write — a role/content message schema
  // -------------------------------------------------------------------

  async add(options: ThreadAddOptions): Promise<string | number> {
    const { role, content, vector, metadata, id, ts } = options;
    if (!vector) throw new EmbeddingNotSupportedError();
    if (typeof role !== 'string' || role.length === 0) {
      throw new Error('role must be a non-empty string');
    }
    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }

    // Explicit id as-authored (a number stays a number); default UUID when
    // omitted. No blanket String() coercion — see Namespace.add.
    const pointId = id !== undefined ? id : generateId();
    const timestamp = ts ?? Date.now() / 1000;

    const payload: Record<string, unknown> = {
      role,
      content,
      ts: timestamp,
    };
    if (metadata) payload.metadata = metadata;

    await this.client.upsert(this.collection, [
      { id: pointId, vector, payload },
    ]);
    return pointId;
  }

  /**
   * Append many messages in a single round trip.
   *
   * Each message is validated like `add` (vector required, non-empty
   * role, string content). Missing IDs get a UUID per message; missing
   * timestamps get `Date.now()/1000` per message (each gets its own —
   * NOT one shared timestamp, otherwise history ordering for messages
   * appended in the same call would be undefined).
   *
   * Returns IDs in input order. Empty input returns `[]` without a
   * round trip. Server handles streaming-chunking; this method does
   * not chunk client-side.
   */
  async appendMany(
    messages: ThreadAddOptions[]
  ): Promise<Array<string | number>> {
    if (!Array.isArray(messages)) {
      throw new TypeError('appendMany requires an array of ThreadAddOptions');
    }
    if (messages.length === 0) return [];

    const points = messages.map((msg, idx) => {
      const { role, content, vector, metadata, id, ts } = msg;
      if (!vector) {
        throw new EmbeddingNotSupportedError(`appendMany[${idx}]`);
      }
      if (typeof role !== 'string' || role.length === 0) {
        throw new Error(`appendMany[${idx}]: role must be a non-empty string`);
      }
      if (typeof content !== 'string') {
        throw new Error(`appendMany[${idx}]: content must be a string`);
      }
      // Explicit id as-authored (a number stays a number); default UUID when
      // omitted. See Namespace.add — no blanket String() coercion.
      const pointId = id !== undefined ? id : generateId();
      const timestamp = ts ?? Date.now() / 1000;
      const payload: Record<string, unknown> = { role, content, ts: timestamp };
      if (metadata) payload.metadata = metadata;
      return { id: pointId, vector, payload };
    });

    await this.client.upsert(this.collection, points);
    return points.map(p => p.id);
  }

  // -------------------------------------------------------------------
  // Read — ordered history
  // -------------------------------------------------------------------

  /**
   * Return messages ordered by timestamp.
   *
   * The underlying scroll API has no server-side order_by over payload
   * fields, so we pull up to a bounded cap and sort client-side by `ts`.
   * Long histories can paginate via `offset` in a future iteration.
   */
  async history(options: ThreadHistoryOptions = {}): Promise<Message[]> {
    const limit = options.limit ?? 50;
    const order = options.order ?? 'asc';

    if (order !== 'asc' && order !== 'desc') {
      throw new Error("order must be 'asc' or 'desc'");
    }
    if (limit <= 0) {
      throw new Error('limit must be positive');
    }

    // Bounded cap — pull min(limit * 20, 5000) points max.
    const cap = Math.min(Math.max(limit * 20, 100), 5000);

    const result = await this.client.scroll(this.collection, {
      limit: cap,
      withPayload: true,
      withVectors: false,
    });

    const messages: Message[] = [];
    for (const point of result.points) {
      const msg = messageFromPoint(point);
      if (msg) messages.push(msg);
    }

    messages.sort((a, b) => (order === 'asc' ? a.ts - b.ts : b.ts - a.ts));

    return messages.slice(0, limit);
  }

  /**
   * Iterate all messages in this thread, sorted by timestamp.
   *
   * Unlike `history({ limit })` which caps at 5000 for the client-side
   * sort, `iterHistory()` walks the entire thread by paging through the
   * underlying scroll iterator and sorting in memory. For threads larger
   * than 5000 messages the in-memory sort can be expensive; use
   * `history({ limit })` if you only need the most recent slice.
   */
  async *iterHistory(
    options: { order?: 'asc' | 'desc' } = {}
  ): AsyncGenerator<Message, void, undefined> {
    assertAllowedOptionKeys(
      options as Record<string, unknown>,
      ['order'],
      'Thread.iterHistory',
      'iterHistory walks the entire thread; pass order to control sort direction.'
    );
    const order = options.order ?? 'asc';
    if (order !== 'asc' && order !== 'desc') {
      throw new Error("order must be 'asc' or 'desc'");
    }

    // Reuse Scope.iter for paging — same scrollIter under the hood.
    // Skip points without payload or without ts (matches history()).
    const messages: Message[] = [];
    for await (const point of this.iter({
      withPayload: true,
      withVectors: false,
    })) {
      const msg = messageFromPoint(point);
      if (msg) messages.push(msg);
    }

    messages.sort((a, b) => (order === 'asc' ? a.ts - b.ts : b.ts - a.ts));

    for (const msg of messages) {
      yield msg;
    }
  }
}

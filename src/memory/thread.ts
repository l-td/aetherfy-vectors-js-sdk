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
 *
 * EVERY THREAD IN A WORKSPACE SHARES ONE COLLECTION (`__threads__`), and a
 * thread is a FILTER over it: `thread_id` is stamped on every point and
 * every read and write this class issues carries the matching clause. The
 * clause is assembled here, never from a caller-supplied string, because
 * the proxy forwards filters verbatim and a misspelled key fails OPEN — a
 * successful response with every thread's points in it. A caller's own
 * filter is COMBINED with the thread clause, never substituted for it.
 *
 * One MARKER point per thread (written by `createThread`) is what makes an
 * empty thread exist. It is not a message and must never read as one, so
 * `history`, `iterHistory`, `search`, `count`, `iter` and the filtered
 * `delete` all exclude it explicitly.
 */

import { AetherfyVectorsClient } from '../client';
import { PointNotFoundError } from '../exceptions';
import { Filter, Point, ScrollPoint } from '../models';
import { assertAllowedOptionKeys } from '../utils/options';
import { EmbeddingNotSupportedError } from './errors';
import {
  generateId,
  Message,
  messageFromPoint,
  THREAD_ID_KEY,
  THREAD_MARKER_KEY,
} from './models';
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
    new Set(['role', 'content', 'ts', THREAD_ID_KEY, THREAD_MARKER_KEY]);

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
  // Scoping — the thread clause
  // -------------------------------------------------------------------

  /** The one condition that scopes an operation to this thread. */
  private threadClause(): Record<string, unknown> {
    return { key: THREAD_ID_KEY, match: { value: this.name } };
  }

  /** Matches the thread's marker point and nothing else. */
  private static markerClause(): Record<string, unknown> {
    return { key: THREAD_MARKER_KEY, match: { value: true } };
  }

  /**
   * Combine a caller filter with the thread clause. Never replaces it.
   *
   * The thread clause always lands in `must` and the marker exclusion
   * always lands in `mustNot`; a caller's clauses are APPENDED to those
   * arrays. Since Aetherfy composes the three clause arrays as a
   * conjunction (everything in `must` holds AND at least one `should`
   * holds AND nothing in `mustNot` holds), no caller clause — `should`
   * included — can widen the result past this thread.
   *
   * Clause names outside must / mustNot / should are left for
   * `serializeFilter` downstream to reject, so a caller typo at the clause
   * level still fails loudly rather than being merged in as an unknown
   * key.
   */
  protected override combineFilter(filter?: Filter): Filter {
    const caller = (filter ?? {}) as Record<string, unknown>;
    const combined: Record<string, unknown> = {
      must: [this.threadClause(), ...((caller.must as unknown[]) ?? [])],
      mustNot: [
        Thread.markerClause(),
        ...((caller.mustNot as unknown[]) ?? []),
      ],
    };
    for (const key of Object.keys(caller)) {
      if (key !== 'must' && key !== 'mustNot') {
        combined[key] = caller[key];
      }
    }
    return combined as Filter;
  }

  /** Every row of this thread, marker included. Used by `clear`. */
  private ownFilter(): Filter {
    return { must: [this.threadClause()] } as unknown as Filter;
  }

  protected override readsPayloadToScope(): boolean {
    // A thread's point ids are unique within the shared collection, not
    // within the thread, so identifying our own points means reading
    // `thread_id` off the payload.
    return true;
  }

  /**
   * True iff `point` is a thread's marker rather than a message.
   *
   * The filter already excludes markers server-side. This is the second,
   * independent guard, and it earns its place because the FIRST one fails
   * open: the proxy forwards a filter verbatim and never validates it, so
   * a mistyped clause returns a successful response with unfiltered
   * results. A marker reading as a message would put an empty `role` and
   * an empty `content` into a caller's conversation.
   */
  private static isMarker(point: {
    payload?: Record<string, unknown>;
  }): boolean {
    return point.payload?.[THREAD_MARKER_KEY] === true;
  }

  /** True iff `point` is one of THIS thread's messages. */
  private owns(point: { payload?: Record<string, unknown> }): boolean {
    return (
      point.payload?.[THREAD_ID_KEY] === this.name && !Thread.isMarker(point)
    );
  }

  protected override retainOwned(
    points: Point[],
    withPayload: boolean
  ): Point[] {
    const kept = points.filter(p => this.owns(p));
    if (withPayload) return kept;
    // The payload was fetched only to scope the read; the caller asked not
    // to see it.
    return kept.map(p => {
      const { payload: _payload, ...rest } = p;
      return rest as Point;
    });
  }

  /**
   * Address these ids AND this thread, in one request.
   *
   * `has_id` is a first-class Qdrant condition — it is in the pinned
   * client's generated schema (@qdrant/js-client-rest 1.15.0, the version
   * the fleet runs) alongside FieldCondition in the Condition union. That
   * matters because the proxy forwards a filter verbatim and an
   * unrecognised key would quietly do nothing: here, silently dropping the
   * `has_id` clause would widen a single-point delete to the whole thread.
   * It is not an unverified guess.
   *
   * Scoping this way rather than checking ids client-side first means the
   * ENGINE enforces the boundary, so a later caller who reaches past the
   * SDK cannot bypass it, and the round trip that the check used to cost
   * is gone.
   */
  protected override pointSelector(ids: Array<string | number>): Filter {
    return {
      must: [this.threadClause(), { has_id: [...ids] }],
      mustNot: [Thread.markerClause()],
    } as unknown as Filter;
  }

  protected override async ownedIds(
    ids: Array<string | number>
  ): Promise<Array<string | number>> {
    if (ids.length === 0) return [];
    const points = await this.client.retrieve(this.collection, ids, {
      withPayload: true,
      withVectors: false,
    });
    return points.filter(p => this.owns(p)).map(p => p.id);
  }

  /**
   * Refuse a point id belonging to another thread.
   *
   * This one DOES cost a read, and deliberately. The payload endpoints
   * accept a filter, so the metadata writers could scope themselves the
   * way `delete` now does — but a filter that matches nothing is a
   * SUCCESS, and `mergeMetadata` / `deleteMetadataKeys` are documented to
   * throw PointNotFoundError when the point is not there. Scoping them by
   * filter would turn a write to a foreign or missing id into a silent
   * no-op reported as success. The round trip buys the error. `delete`
   * has no such contract to lose: deleting an id that is not there was
   * always a no-op that returns true.
   */
  protected override async assertOwns(
    ids: Array<string | number>
  ): Promise<void> {
    const owned = new Set(await this.ownedIds(ids));
    for (const id of ids) {
      if (!owned.has(id)) {
        throw new PointNotFoundError(String(id), this.collection);
      }
    }
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
    // The thread clause's key is stamped LAST so nothing a caller supplied
    // can displace it — `metadata` is nested a level down and cannot reach
    // this key, but stamping last is what makes that structural rather
    // than incidental.
    payload[THREAD_ID_KEY] = this.name;

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
      payload[THREAD_ID_KEY] = this.name;
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
    //
    // The cap SURVIVES the move to a shared collection. It was never doing
    // the filter's job: even when a thread had a collection to itself this
    // scroll was already thread-scoped, and the cap was what bounded the
    // client-side sort of an arbitrarily long thread. The filter narrows
    // the same scroll to the same rows it used to see, so removing the cap
    // now would make history({ limit: 50 }) pull an unbounded thread into
    // memory. It still truncates silently past 5000 messages — that is
    // iterHistory's job, which is why that method exists.
    const cap = Math.min(Math.max(limit * 20, 100), 5000);

    const result = await this.client.scroll(this.collection, {
      limit: cap,
      withPayload: true,
      withVectors: false,
      scrollFilter: this.combineFilter(),
    });

    const messages: Message[] = [];
    for (const point of result.points) {
      if (Thread.isMarker(point as ScrollPoint)) continue;
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
      if (Thread.isMarker(point)) continue;
      const msg = messageFromPoint(point);
      if (msg) messages.push(msg);
    }

    messages.sort((a, b) => (order === 'asc' ? a.ts - b.ts : b.ts - a.ts));

    for (const msg of messages) {
      yield msg;
    }
  }

  // -------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------

  /**
   * Atomically drop this thread, leaving every sibling thread intact.
   *
   * Keeps the meaning it has always had — after `clear()` the thread no
   * longer exists and `memory.createThread(id)` re-creates it — but it can
   * no longer be a collection drop: the collection now holds every OTHER
   * thread in the workspace too. It is a delete-by-filter on this thread's
   * rows, marker included (dropping the marker is what makes the thread
   * stop existing).
   */
  override async clear(): Promise<boolean> {
    return this.client.delete(this.collection, this.ownFilter());
  }
}

/**
 * Thread — a conversation-shaped specialization of Namespace.
 *
 * Payloads follow a `{ role, content, ts, metadata }` schema. Adds expose
 * `history(limit, order)` for ordered retrieval of messages.
 *
 * Every add writes three reserved fields on the point payload:
 * `role`, `content`, and `ts` (Unix seconds). User metadata lives
 * under `metadata` so it can't shadow reserved fields.
 */

import { AetherfyVectorsClient } from '../client';
import { EmbeddingNotSupportedError } from './errors';
import { generateId, Message, messageFromPoint } from './models';
import { Namespace } from './namespace';

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

export class Thread extends Namespace {
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
  // Write — shadows Namespace.add with a role/content schema
  // -------------------------------------------------------------------

  async add(options: ThreadAddOptions): Promise<string> {
    const { role, content, vector, metadata, id, ts } = options;
    if (!vector) throw new EmbeddingNotSupportedError();
    if (typeof role !== 'string' || role.length === 0) {
      throw new Error('role must be a non-empty string');
    }
    if (typeof content !== 'string') {
      throw new Error('content must be a string');
    }

    const pointId = id !== undefined ? String(id) : generateId();
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

  // -------------------------------------------------------------------
  // Read — ordered history
  // -------------------------------------------------------------------

  /**
   * Return messages ordered by timestamp.
   *
   * Qdrant's scroll API has no server-side order_by over payload fields
   * without an index; for the MVP we pull up to a bounded cap and sort
   * client-side by `ts`. Long histories can paginate via `offset` in
   * a future iteration.
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
}

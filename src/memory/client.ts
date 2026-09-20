/**
 * MemoryClient — agent-memory SDK layered on aetherfy-vectors.
 *
 * Provides an opinionated, agent-first API on top of AetherfyVectorsClient.
 * Every add/search operation goes through a named scope (Namespace or
 * Thread); there is no root-level add/search and no magic default
 * collection. Scopes must be created explicitly (typo protection).
 *
 * For operations not exposed here — custom collection configs, low-level
 * vector operations, any current vectors-SDK surface — use
 * AetherfyVectorsClient directly via `memory.vectors` or its own import.
 */

import { AetherfyVectorsClient } from '../client';
import {
  ClientConfig,
  Collection,
  DistanceMetric,
  Filter,
  UsageStats,
  VectorConfigInput,
} from '../models';
import {
  InvalidNameError,
  NamespaceAlreadyExistsError,
  NamespaceNotFoundError,
  ThreadAlreadyExistsError,
  ThreadNotFoundError,
  ThreadVectorSizeMismatchError,
} from './errors';
import {
  DEFAULT_VECTOR_SIZE,
  generateId,
  THREAD_ID_KEY,
  THREAD_MARKER_KEY,
  THREADS_COLLECTION,
} from './models';
import { Namespace } from './namespace';
import { Thread } from './thread';

/**
 * User-facing names must start with letter/digit and may contain
 * letters, digits, dots, hyphens, underscores. Max 255 chars. The
 * `__threads__` collection name is therefore unreachable from this regex,
 * so no namespace can collide with it.
 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

function validateUserName(name: unknown, kind: string): void {
  if (typeof name !== 'string') {
    throw new InvalidNameError(`${kind} must be a string, got ${typeof name}`);
  }
  if (!NAME_RE.test(name)) {
    throw new InvalidNameError(
      `Invalid ${kind} '${name}'. Must match [a-zA-Z0-9][a-zA-Z0-9._-]* ` +
        `(start with letter/digit; letters, digits, dots, hyphens, ` +
        `underscores allowed; max 255 chars).`
    );
  }
}

export interface MemoryClientConfig extends ClientConfig {
  /**
   * Bring-your-own AetherfyVectorsClient.
   *
   * When supplied, all other config fields (apiKey, endpoint, timeout,
   * workspace) are ignored — the client is used as-is. Useful when:
   *
   * - Sharing a single AetherfyVectorsClient across MemoryClient and
   *   other code that uses the raw vectors API.
   * - You need a custom HTTP client, retry strategy, or connection pool.
   * - You already have an authenticated client configured elsewhere.
   */
  client?: AetherfyVectorsClient;

  /**
   * Embedding dimension for THREADS. Every thread in a workspace lives in
   * one collection and therefore shares one dimension, fixed when that
   * collection is first created; this is where it comes from. Defaults to
   * 384 (all-MiniLM-L6-v2). Namespaces are unaffected — each still takes
   * its own `vectorSize` at `createNamespace`.
   */
  threadVectorSize?: number;

  /**
   * Distance metric for the threads collection, fixed the same way.
   * Default cosine.
   */
  threadDistance?: DistanceMetric;
}

export interface CreateScopeOptions {
  /**
   * Embedding dimension. Defaults to 384 (all-MiniLM-L6-v2 /
   * planned T2-0 default). Override for other models:
   * 1536 (OpenAI small), 3072 (OpenAI large), 1024 (Cohere v3).
   */
  vectorSize?: number;
  /** Distance metric (cosine, dot, euclidean, manhattan). Default cosine. */
  distance?: DistanceMetric;
}

export class MemoryClient {
  private readonly _client: AetherfyVectorsClient;
  private readonly threadVectorSize: number;
  private readonly threadDistance: DistanceMetric;

  constructor(config: MemoryClientConfig = {}) {
    this.threadVectorSize = config.threadVectorSize ?? DEFAULT_VECTOR_SIZE;
    this.threadDistance = config.threadDistance ?? DistanceMetric.COSINE;

    if (config.client !== undefined) {
      this._client = config.client;
    } else {
      // Default to auto-detection of AETHERFY_WORKSPACE unless explicitly
      // overridden. Mirrors Python SDK default.
      const {
        client: _ignored,
        threadVectorSize: _tvs,
        threadDistance: _td,
        ...rest
      } = config;
      const cfg: ClientConfig = { ...rest };
      if (cfg.workspace === undefined) cfg.workspace = 'auto';
      this._client = new AetherfyVectorsClient(cfg);
    }
  }

  /** The active workspace, or undefined if workspace scoping is disabled. */
  get workspace(): string | undefined {
    return this._client.workspace;
  }

  /**
   * Direct access to the underlying AetherfyVectorsClient.
   *
   * Use this as the low-level escape hatch for any operation not exposed
   * on MemoryClient. Collection names are workspace-scoped automatically.
   */
  get vectors(): AetherfyVectorsClient {
    return this._client;
  }

  // -------------------------------------------------------------------
  // Namespace lifecycle
  // -------------------------------------------------------------------

  /**
   * Create a new namespace. Throws if the name is invalid or already
   * exists. Returns a Namespace handle ready for add/search.
   */
  async createNamespace(
    name: string,
    options: CreateScopeOptions = {}
  ): Promise<Namespace> {
    validateUserName(name, 'namespace name');

    if (await this._client.collectionExists(name)) {
      throw new NamespaceAlreadyExistsError(name);
    }

    const vectors: VectorConfigInput = {
      size: options.vectorSize ?? DEFAULT_VECTOR_SIZE,
      distance: options.distance ?? DistanceMetric.COSINE,
    };

    await this._client.createCollection(name, vectors);
    return new Namespace(name, name, this._client);
  }

  /** Open an existing namespace. Throws NamespaceNotFoundError if missing. */
  async namespace(name: string): Promise<Namespace> {
    validateUserName(name, 'namespace name');
    if (!(await this._client.collectionExists(name))) {
      throw new NamespaceNotFoundError(name);
    }
    return new Namespace(name, name, this._client);
  }

  async namespaceExists(name: string): Promise<boolean> {
    validateUserName(name, 'namespace name');
    return this._client.collectionExists(name);
  }

  /**
   * Return metadata for a namespace (name, config, points_count, status).
   *
   * Distinct from `namespace(name)`, which returns an operation handle.
   */
  async getNamespace(name: string): Promise<Collection> {
    validateUserName(name, 'namespace name');
    if (!(await this._client.collectionExists(name))) {
      throw new NamespaceNotFoundError(name);
    }
    return this._client.getCollection(name);
  }

  /**
   * All namespace names in this workspace.
   *
   * Threads are no longer collections, so there is nothing thread-shaped
   * left to filter out of the collection list — except the single
   * `__threads__` collection they all share, which is an implementation
   * detail and not a namespace.
   */
  async listNamespaces(): Promise<string[]> {
    const cols = await this._client.getCollections();
    return cols.filter(c => c.name !== THREADS_COLLECTION).map(c => c.name);
  }

  /** Drop the namespace atomically. Idempotent: returns false if absent. */
  async deleteNamespace(name: string): Promise<boolean> {
    validateUserName(name, 'namespace name');
    if (!(await this._client.collectionExists(name))) {
      return false;
    }
    return this._client.deleteCollection(name);
  }

  // -------------------------------------------------------------------
  // Thread lifecycle
  // -------------------------------------------------------------------

  /** Matches exactly the marker point of one thread. */
  private markerFilter(threadId: string): Filter {
    return {
      must: [
        { key: THREAD_ID_KEY, match: { value: threadId } },
        { key: THREAD_MARKER_KEY, match: { value: true } },
      ],
    } as unknown as Filter;
  }

  /**
   * A valid unit vector of `size` dimensions for a marker point.
   *
   * NOT the zero vector. Under cosine distance Qdrant normalises every stored
   * vector by its length, and a zero-length vector has no defined
   * normalisation — whether the engine rejects it or stores something whose
   * similarity is undefined, neither is a thing to build the existence of a
   * thread on. `[1, 0, ...]` has length 1 and is well defined under cosine,
   * dot and euclid alike.
   */
  private markerVector(size: number): number[] {
    const v = new Array<number>(size).fill(0);
    v[0] = 1;
    return v;
  }

  /**
   * Create the shared threads collection on first use.
   *
   * Indexes both keys the thread clause filters on. An unindexed payload
   * filter is SCANNED rather than looked up, and this is the one collection
   * whose every read carries a tenant filter.
   */
  private async ensureThreadsCollection(): Promise<void> {
    if (await this._client.collectionExists(THREADS_COLLECTION)) {
      const existing = await this._client.getCollection(THREADS_COLLECTION);
      const size = existing.config?.size;
      if (!size) {
        // A missing/zero size means UNKNOWN here, never a zero-dimension
        // collection: it is what a response carrying no vectors config
        // leaves behind. There is nothing to compare against, so the check
        // is skipped — explicitly, because a silent skip of a mismatch
        // check reads as a passing check. A genuinely wrong dimension then
        // surfaces on the first write, from the client's own guard.
        return;
      }
      if (size !== this.threadVectorSize) {
        throw new ThreadVectorSizeMismatchError(size, this.threadVectorSize);
      }
      return;
    }

    const vectors: VectorConfigInput = {
      size: this.threadVectorSize,
      distance: this.threadDistance,
    };
    await this._client.createCollection(THREADS_COLLECTION, vectors);
    await this._client.createFieldIndex(
      THREADS_COLLECTION,
      THREAD_ID_KEY,
      'keyword'
    );
    await this._client.createFieldIndex(
      THREADS_COLLECTION,
      THREAD_MARKER_KEY,
      'bool'
    );
  }

  /** True iff this thread's marker point is present. */
  private async threadMarkerExists(threadId: string): Promise<boolean> {
    if (!(await this._client.collectionExists(THREADS_COLLECTION))) {
      return false;
    }
    const n = await this._client.count(THREADS_COLLECTION, {
      countFilter: this.markerFilter(threadId),
      exact: true,
    });
    return n > 0;
  }

  /**
   * Create a new thread.
   *
   * Threads are rows, not collections: every thread in the workspace lives in
   * one shared collection with `thread_id` as a payload key, so creating one
   * does NOT consume a slot against the account's collection limit and a Free
   * account is not capped at three conversations.
   *
   * That is also why there is no `vectorSize` / `distance` option here any
   * more: one collection has one of each. Both come from the MemoryClient
   * (`threadVectorSize` / `threadDistance`) and are fixed when the collection
   * is first created. `createNamespace` keeps both — a namespace is still one
   * collection.
   *
   * Creating a thread writes ONE marker point. That is what makes an empty
   * thread exist: without it, a thread with no messages would be
   * indistinguishable from a thread that was never created.
   */
  async createThread(threadId: string): Promise<Thread> {
    validateUserName(threadId, 'thread id');
    await this.ensureThreadsCollection();

    if (await this.threadMarkerExists(threadId)) {
      throw new ThreadAlreadyExistsError(threadId);
    }

    await this._client.upsert(THREADS_COLLECTION, [
      {
        id: generateId(),
        vector: this.markerVector(this.threadVectorSize),
        payload: {
          [THREAD_ID_KEY]: threadId,
          [THREAD_MARKER_KEY]: true,
        },
      },
    ]);
    return new Thread(threadId, THREADS_COLLECTION, this._client);
  }

  async thread(threadId: string): Promise<Thread> {
    validateUserName(threadId, 'thread id');
    if (!(await this.threadMarkerExists(threadId))) {
      throw new ThreadNotFoundError(threadId);
    }
    return new Thread(threadId, THREADS_COLLECTION, this._client);
  }

  /**
   * True if the thread exists in this workspace.
   *
   * A filtered count over the marker points, so an EMPTY thread still reads
   * as existing — the property a payload-keyed model would have lost without
   * them.
   */
  async threadExists(threadId: string): Promise<boolean> {
    validateUserName(threadId, 'thread id');
    return this.threadMarkerExists(threadId);
  }

  /**
   * Return metadata for a thread.
   *
   * `name` is the thread id and `pointsCount` is THIS thread's message count
   * (the marker is not a message); `config` and `status` describe the shared
   * threads collection, which is where a thread's vector size and distance
   * actually live now.
   */
  async getThread(threadId: string): Promise<Collection> {
    validateUserName(threadId, 'thread id');
    if (!(await this.threadMarkerExists(threadId))) {
      throw new ThreadNotFoundError(threadId);
    }
    const info = await this._client.getCollection(THREADS_COLLECTION);
    const own = new Thread(threadId, THREADS_COLLECTION, this._client);
    return { ...info, name: threadId, points_count: await own.count() };
  }

  /**
   * All thread ids in this workspace.
   *
   * A scroll over the MARKER points, so the work is bounded by the number of
   * threads rather than the number of messages, and an empty thread is listed
   * like any other.
   *
   * DE-DUPLICATED, because a thread can end up with two markers. Creating one
   * is a check-then-write, so two callers that both pass the check before
   * either marker lands both write one. Nothing else notices — `threadExists`
   * is a count > 0, `count` and `history` exclude markers, and `deleteThread`
   * removes every row with the id — but this method read the id off each
   * marker and would have listed the thread twice. A `Map`/`Set` round-trip
   * keeps first-seen order.
   */
  async listThreads(): Promise<string[]> {
    if (!(await this._client.collectionExists(THREADS_COLLECTION))) {
      return [];
    }
    const ids: string[] = [];
    for await (const point of this._client.scrollIter(THREADS_COLLECTION, {
      scrollFilter: {
        must: [{ key: THREAD_MARKER_KEY, match: { value: true } }],
      } as unknown as Filter,
      withPayload: true,
      withVectors: false,
    })) {
      const id = point.payload?.[THREAD_ID_KEY];
      if (typeof id === 'string') ids.push(id);
    }
    return [...new Set(ids)];
  }

  /**
   * Drop the thread and every message in it. Idempotent.
   *
   * A delete-by-filter on this thread's rows, marker included. It cannot
   * touch a sibling thread, and it no longer drops a collection.
   */
  async deleteThread(threadId: string): Promise<boolean> {
    validateUserName(threadId, 'thread id');
    if (!(await this.threadMarkerExists(threadId))) {
      return false;
    }
    return this._client.delete(THREADS_COLLECTION, {
      must: [{ key: THREAD_ID_KEY, match: { value: threadId } }],
    } as unknown as Filter);
  }

  // -------------------------------------------------------------------
  // Usage stats (parity with AetherfyVectorsClient)
  // -------------------------------------------------------------------

  async getUsageStats(): Promise<UsageStats> {
    return this._client.getUsageStats();
  }

  /**
   * Clear the client-side schema cache for every scope in this workspace.
   *
   * Per-scope clear still lives on `Namespace.clearSchemaCache()` /
   * `Thread.clearSchemaCache()`. Use this when bulk-invalidating is
   * cheaper than tracking each scope.
   */
  clearSchemaCache(): void {
    this._client.clearSchemaCache();
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /** Release any underlying resources. */
  async dispose(): Promise<void> {
    return this._client.dispose();
  }
}

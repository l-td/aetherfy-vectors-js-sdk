/**
 * MemoryClient — agent-memory SDK layered on aetherfy-vectors.
 *
 * Provides an opinionated, agent-first API on top of AetherfyVectorsClient.
 * Every add/search operation goes through a named scope (Namespace or
 * Thread); there is no root-level add/search and no magic default
 * collection. Scopes must be created explicitly (typo protection).
 *
 * For operations not exposed here — custom collection configs, raw Qdrant
 * calls, any current vectors-SDK surface — use AetherfyVectorsClient
 * directly via `memory.vectors` or its own import.
 */

import { AetherfyVectorsClient } from '../client';
import {
  ClientConfig,
  Collection,
  CollectionAnalytics,
  DistanceMetric,
  PerformanceAnalytics,
  UsageStats,
  VectorConfigInput,
} from '../models';
import {
  InvalidNameError,
  NamespaceAlreadyExistsError,
  NamespaceNotFoundError,
  ThreadAlreadyExistsError,
  ThreadNotFoundError,
} from './errors';
import { DEFAULT_VECTOR_SIZE } from './models';
import { Namespace } from './namespace';
import { Thread } from './thread';

/**
 * Internal collection-name prefix for threads.
 *
 * Chosen to be an invalid user-facing name (starts with `_`), so user-
 * facing name validation blocks it at the regex gate — no collisions
 * possible between namespace names and thread backing collections.
 */
const THREAD_PREFIX = '__thread__';

/**
 * User-facing names must start with letter/digit and may contain
 * letters, digits, dots, hyphens, underscores. Max 255 chars.
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

  constructor(config: MemoryClientConfig = {}) {
    if (config.client !== undefined) {
      this._client = config.client;
    } else {
      // Default to auto-detection of AETHERFY_WORKSPACE unless explicitly
      // overridden. Mirrors Python SDK default.
      const { client: _ignored, ...rest } = config;
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

  async listNamespaces(): Promise<string[]> {
    const cols = await this._client.getCollections();
    return cols.filter(c => !c.name.startsWith(THREAD_PREFIX)).map(c => c.name);
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

  async createThread(
    threadId: string,
    options: CreateScopeOptions = {}
  ): Promise<Thread> {
    validateUserName(threadId, 'thread id');
    const collection = THREAD_PREFIX + threadId;

    if (await this._client.collectionExists(collection)) {
      throw new ThreadAlreadyExistsError(threadId);
    }

    const vectors: VectorConfigInput = {
      size: options.vectorSize ?? DEFAULT_VECTOR_SIZE,
      distance: options.distance ?? DistanceMetric.COSINE,
    };

    await this._client.createCollection(collection, vectors);
    return new Thread(threadId, collection, this._client);
  }

  async thread(threadId: string): Promise<Thread> {
    validateUserName(threadId, 'thread id');
    const collection = THREAD_PREFIX + threadId;
    if (!(await this._client.collectionExists(collection))) {
      throw new ThreadNotFoundError(threadId);
    }
    return new Thread(threadId, collection, this._client);
  }

  async threadExists(threadId: string): Promise<boolean> {
    validateUserName(threadId, 'thread id');
    return this._client.collectionExists(THREAD_PREFIX + threadId);
  }

  /**
   * Return metadata for a thread.
   *
   * The returned Collection's `name` is remapped to the thread id
   * (stripping the internal `__thread__` prefix), so callers never
   * see the internal naming.
   */
  async getThread(threadId: string): Promise<Collection> {
    validateUserName(threadId, 'thread id');
    const collection = THREAD_PREFIX + threadId;
    if (!(await this._client.collectionExists(collection))) {
      throw new ThreadNotFoundError(threadId);
    }
    const info = await this._client.getCollection(collection);
    return { ...info, name: threadId };
  }

  async listThreads(): Promise<string[]> {
    const cols = await this._client.getCollections();
    return cols
      .filter(c => c.name.startsWith(THREAD_PREFIX))
      .map(c => c.name.slice(THREAD_PREFIX.length));
  }

  async deleteThread(threadId: string): Promise<boolean> {
    validateUserName(threadId, 'thread id');
    const collection = THREAD_PREFIX + threadId;
    if (!(await this._client.collectionExists(collection))) {
      return false;
    }
    return this._client.deleteCollection(collection);
  }

  // -------------------------------------------------------------------
  // Global analytics (parity with AetherfyVectorsClient)
  // -------------------------------------------------------------------

  async getPerformanceAnalytics(
    timeRange: string = '24h',
    region?: string
  ): Promise<PerformanceAnalytics> {
    return this._client.getPerformanceAnalytics(timeRange, region);
  }

  async getNamespaceAnalytics(
    name: string,
    timeRange: string = '24h'
  ): Promise<CollectionAnalytics> {
    validateUserName(name, 'namespace name');
    if (!(await this._client.collectionExists(name))) {
      throw new NamespaceNotFoundError(name);
    }
    return this._client.getCollectionAnalytics(name, timeRange);
  }

  async getThreadAnalytics(
    threadId: string,
    timeRange: string = '24h'
  ): Promise<CollectionAnalytics> {
    validateUserName(threadId, 'thread id');
    const collection = THREAD_PREFIX + threadId;
    if (!(await this._client.collectionExists(collection))) {
      throw new ThreadNotFoundError(threadId);
    }
    return this._client.getCollectionAnalytics(collection, timeRange);
  }

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

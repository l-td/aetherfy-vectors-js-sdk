/**
 * Namespace — a named, scoped memory bucket backed by one Qdrant collection.
 *
 * The generic primitive for any agent shape. Wraps a single underlying
 * AetherfyVectorsClient collection and exposes only the operations that
 * make sense at the scope level: add, search, retrieve, delete, count,
 * schema management, and atomic clear.
 *
 * All collection-lifecycle operations (create, list, exists, delete) live
 * on MemoryClient — a Namespace instance always points at an existing scope.
 */

import { AetherfyVectorsClient } from '../client';
import {
  AnalysisResult,
  CollectionAnalytics,
  EnforcementMode,
  Filter,
  Point,
  Schema,
  ScrollPoint,
  SearchResult,
} from '../models';
import { assertAllowedOptionKeys } from '../utils/options';
import { EmbeddingNotSupportedError } from './errors';
import { generateId } from './models';

export interface NamespaceIterOptions {
  /** Points per server round-trip. Default 256, server cap 1000. */
  batchSize?: number;
  /** Optional payload filter, same shape as `search`. */
  filter?: Filter;
  /** Include payload in results (default true). */
  withPayload?: boolean;
  /** Include vectors in results (default false; large). */
  withVectors?: boolean;
}

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

export interface NamespaceSearchOptions {
  limit?: number;
  offset?: number;
  filter?: Filter;
  withPayload?: boolean;
  withVectors?: boolean;
  scoreThreshold?: number;
}

export interface NamespaceRetrieveOptions {
  withPayload?: boolean;
  withVectors?: boolean;
}

export interface NamespaceSetSchemaOptions {
  enforcement?: EnforcementMode;
  description?: string;
}

export class Namespace {
  /**
   * Internal — callers use MemoryClient.namespace(name) to construct.
   * @internal
   */
  constructor(
    public readonly name: string,
    protected readonly collection: string,
    protected readonly client: AetherfyVectorsClient
  ) {}

  // -------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------

  /**
   * Add a memory to this namespace.
   * Returns the point ID used for the write.
   */
  async add(options: NamespaceAddOptions): Promise<string> {
    const { vector, text, metadata, id } = options;
    if (!vector) throw new EmbeddingNotSupportedError();

    const pointId = id !== undefined ? String(id) : generateId();
    const payload: Record<string, unknown> = {};
    if (text !== undefined) payload.text = text;
    if (metadata) payload.metadata = metadata;

    await this.client.upsert(this.collection, [
      { id: pointId, vector, payload },
    ]);
    return pointId;
  }

  /**
   * Replace the metadata sub-key of an existing memory.
   *
   * Atomically writes `payload.metadata = metadata`. Reserved fields
   * (`text` for Namespace, plus `role`/`content`/`ts` for Thread) are
   * untouched. To merge into existing metadata, retrieve + merge +
   * setMetadata explicitly:
   *
   * ```ts
   * const [point] = await ns.retrieve([id]);
   * const current = (point?.payload?.metadata ?? {}) as Record<string, unknown>;
   * await ns.setMetadata(id, { ...current, reviewed: true });
   * ```
   *
   * The non-atomic compose pattern is intentional — it keeps races visible
   * at the call site rather than hidden inside an SDK helper.
   */
  async setMetadata(
    id: string | number,
    metadata: Record<string, unknown>
  ): Promise<unknown> {
    return this.client.setPayload(this.collection, { metadata }, [id]);
  }

  // -------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------

  async search(
    vector: number[],
    options: NamespaceSearchOptions = {}
  ): Promise<SearchResult[]> {
    return this.client.search(this.collection, vector, {
      limit: options.limit,
      offset: options.offset,
      queryFilter: options.filter,
      withPayload: options.withPayload,
      withVectors: options.withVectors,
      scoreThreshold: options.scoreThreshold,
    });
  }

  async retrieve(
    ids: Array<string | number>,
    options: NamespaceRetrieveOptions = {}
  ): Promise<Point[]> {
    return this.client.retrieve(this.collection, ids, {
      withPayload: options.withPayload,
      withVectors: options.withVectors,
    });
  }

  async count(
    options: { filter?: Filter; exact?: boolean } = {}
  ): Promise<number> {
    return this.client.count(this.collection, {
      countFilter: options.filter,
      exact: options.exact,
    });
  }

  /**
   * Iterate all points in this namespace.
   *
   * Yields each point one at a time, paging transparently through the
   * underlying scrollIter. Returns cleanly when the namespace is exhausted.
   * Use this for archival, export, or batch-enrichment workflows that
   * exceed what `search` and `retrieve` cover.
   */
  async *iter(
    options: NamespaceIterOptions = {}
  ): AsyncGenerator<ScrollPoint, void, undefined> {
    assertAllowedOptionKeys(
      options as Record<string, unknown>,
      ['batchSize', 'filter', 'withPayload', 'withVectors'],
      'Namespace.iter',
      'Pass batchSize to control page size; limit and offset are owned by the iterator.'
    );
    yield* this.client.scrollIter(this.collection, {
      batchSize: options.batchSize,
      scrollFilter: options.filter,
      withPayload: options.withPayload,
      withVectors: options.withVectors,
    });
  }

  // -------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------

  /** Delete points — by ID list or by filter — without dropping the namespace. */
  async delete(selector: Array<string | number> | Filter): Promise<boolean> {
    return this.client.delete(this.collection, selector);
  }

  /**
   * Atomically drop this namespace (destroys the underlying collection).
   * After `clear()`, the namespace no longer exists; re-create to use again.
   */
  async clear(): Promise<boolean> {
    return this.client.deleteCollection(this.collection);
  }

  // -------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------

  async getSchema(): Promise<Schema | null> {
    return this.client.getSchema(this.collection);
  }

  /** Returns the new schema ETag. */
  async setSchema(
    schema: Schema,
    options: NamespaceSetSchemaOptions = {}
  ): Promise<string> {
    return this.client.setSchema(
      this.collection,
      schema,
      options.enforcement ?? 'strict',
      options.description
    );
  }

  async deleteSchema(): Promise<boolean> {
    return this.client.deleteSchema(this.collection);
  }

  async analyzeSchema(sampleSize: number = 1000): Promise<AnalysisResult> {
    return this.client.analyzeSchema(this.collection, sampleSize);
  }

  async refreshSchema(): Promise<void> {
    return this.client.refreshSchema(this.collection);
  }

  clearSchemaCache(): void {
    this.client.clearSchemaCache(this.collection);
  }

  // -------------------------------------------------------------------
  // Analytics
  // -------------------------------------------------------------------

  async getAnalytics(timeRange: string = '24h'): Promise<CollectionAnalytics> {
    return this.client.getCollectionAnalytics(this.collection, timeRange);
  }
}

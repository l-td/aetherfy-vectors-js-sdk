/**
 * Scope — the shared base for Namespace and Thread.
 *
 * Holds every operation that behaves identically for both scope shapes:
 * read (search / retrieve / count / iter), delete / clear, schema management,
 * analytics, and the payload-metadata helpers. The two *write* APIs differ by
 * shape — a Namespace stores a generic memory (`{ text?, metadata? }`), a
 * Thread stores a conversation message (`{ role, content, ts, metadata? }`) —
 * so `add` (and the batch writers) live on the subclasses, not here. That is
 * why Thread does NOT extend Namespace: it is not add-substitutable for one.
 * Both are Scopes that share the substitutable surface.
 *
 * @internal — not part of the public API; use Namespace / Thread.
 */

import { AetherfyVectorsClient } from '../client';
import {
  AetherfyVectorsError,
  CollectionNotFoundError,
  PointNotFoundError,
} from '../exceptions';
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

export class Scope {
  /**
   * Internal — callers use MemoryClient.namespace / .thread to construct.
   * @internal
   */
  constructor(
    public readonly name: string,
    protected readonly collection: string,
    protected readonly client: AetherfyVectorsClient
  ) {}

  /**
   * Top-level reserved keys that cannot appear inside metadata partials.
   * Subclasses override with their own set ({text} for Namespace;
   * {role, content, ts} for Thread).
   * @internal
   */
  protected static readonly RESERVED_KEYS: ReadonlySet<string> =
    new Set<string>();

  // -------------------------------------------------------------------
  // Payload metadata
  // -------------------------------------------------------------------

  /**
   * Replace the entire metadata sub-key of an existing memory.
   *
   * `setMetadata({ tag: 'x' })` nukes every other key. Use
   * `mergeMetadata` if you want additive updates that preserve existing
   * keys.
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

  /**
   * Additive merge into existing metadata.
   *
   * `mergeMetadata({ tag: 'x' })` adds/updates the listed keys and
   * leaves every other key untouched. Use `setMetadata` if you want to
   * fully replace the metadata sub-key. Concurrent patches to different
   * keys all land atomically; concurrent writes to the same key resolve
   * via last-writer-wins per the storage operation order. Throws
   * `PointNotFoundError` if the point doesn't exist.
   *
   * Reserved keys (`text` on Namespace; `role`, `content`, `ts` on
   * Thread) cannot appear in the partial — throws a local `TypeError`
   * before the request is sent.
   */
  async mergeMetadata(
    id: string | number,
    partial: Record<string, unknown>
  ): Promise<unknown> {
    if (
      partial === null ||
      typeof partial !== 'object' ||
      Array.isArray(partial)
    ) {
      throw new TypeError('partial must be a plain object');
    }
    const reserved = (this.constructor as typeof Scope).RESERVED_KEYS;
    const bad = Object.keys(partial).filter(k => reserved.has(k));
    if (bad.length > 0) {
      throw new TypeError(
        `Reserved keys cannot appear in metadata partial: ${JSON.stringify(
          bad.sort()
        )}`
      );
    }
    try {
      return await this.client.setPayload(this.collection, partial, [id], {
        key: 'metadata',
      });
    } catch (error: unknown) {
      throw this.translatePointNotFound(error, id);
    }
  }

  /**
   * Removes the listed keys from metadata.
   *
   * Keys not in the list are left untouched. Throws
   * `PointNotFoundError` if the point doesn't exist.
   *
   * Reserved keys (`text` on Namespace; `role`, `content`, `ts` on
   * Thread) cannot appear in the keys list — throws a local
   * `TypeError` before the request is sent.
   */
  async deleteMetadataKeys(
    id: string | number,
    keys: string[]
  ): Promise<unknown> {
    if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string')) {
      throw new TypeError('keys must be an array of strings');
    }
    const reserved = (this.constructor as typeof Scope).RESERVED_KEYS;
    const bad = keys.filter(k => reserved.has(k));
    if (bad.length > 0) {
      throw new TypeError(
        `Reserved keys cannot appear in delete keys list: ${JSON.stringify(
          bad.sort()
        )}`
      );
    }
    const dotted = keys.map(k => `metadata.${k}`);
    try {
      return await this.client.deletePayload(this.collection, dotted, [id]);
    } catch (error: unknown) {
      throw this.translatePointNotFound(error, id);
    }
  }

  private translatePointNotFound(error: unknown, id: string | number): unknown {
    if (
      error instanceof AetherfyVectorsError &&
      error.statusCode === 404 &&
      !(error instanceof PointNotFoundError) &&
      !(error instanceof CollectionNotFoundError)
    ) {
      return new PointNotFoundError(String(id), this.collection);
    }
    return error;
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
   * Iterate all points in this scope.
   *
   * Yields each point one at a time, paging transparently through the
   * underlying scrollIter. Returns cleanly when the scope is exhausted.
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

  /** Delete points — by ID list or by filter — without dropping the scope. */
  async delete(selector: Array<string | number> | Filter): Promise<boolean> {
    return this.client.delete(this.collection, selector);
  }

  /**
   * Atomically drop this scope (destroys the underlying collection).
   * After `clear()`, the scope no longer exists; re-create to use again.
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

/**
 * Scope — the shared base for Namespace and Thread.
 *
 * Holds every operation that behaves identically for both scope shapes:
 * read (search / retrieve / count / iter), delete / clear, and the
 * payload-metadata helpers. Schema management is NOT here: a schema belongs
 * to a collection, and a Thread no longer has one to itself (see Namespace). The two *write* APIs differ by
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
  EnforcementMode,
  Filter,
  Point,
  ScrollPoint,
  SearchResult,
} from '../models';
import { assertAllowedOptionKeys, optionKeys } from '../utils/options';

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
  /**
   * Search-time engine parameters, forwarded verbatim as the request body's
   * `params` field. The headline use is `{ hnsw_ef: 256 }`: a larger ef makes
   * the HNSW graph walk visit more candidates, buying recall at the cost of
   * latency. Recall matters here — retrieving the *right* memory usually
   * beats saving a millisecond. Omit it to keep the tuned server-side default
   * (hnsw_ef=100).
   *
   * Different params values produce different request bodies and therefore
   * different server cache entries, so the same query at a different ef is a
   * separate entry, never a wrong hit.
   *
   * Passed through untranslated; see {@link SearchOptions.searchParams}.
   */
  searchParams?: Record<string, unknown>;
}

export interface NamespaceRetrieveOptions {
  withPayload?: boolean;
  withVectors?: boolean;
}

export interface NamespaceSetSchemaOptions {
  enforcement?: EnforcementMode;
  description?: string;
}

// Derived from the types by optionKeys(): see src/utils/options.ts.
const SEARCH_OPTION_KEYS = optionKeys<NamespaceSearchOptions>({
  limit: true,
  offset: true,
  filter: true,
  withPayload: true,
  withVectors: true,
  scoreThreshold: true,
  searchParams: true,
});
const RETRIEVE_OPTION_KEYS = optionKeys<NamespaceRetrieveOptions>({
  withPayload: true,
  withVectors: true,
});
const COUNT_OPTION_KEYS = optionKeys<
  NonNullable<Parameters<Scope['count']>[0]>
>({ filter: true, exact: true });
const ITER_OPTION_KEYS = optionKeys<NamespaceIterOptions>({
  batchSize: true,
  filter: true,
  withPayload: true,
  withVectors: true,
});

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

  /**
   * The public class name a method is reported under in an error, so a
   * Thread's refusal says `Thread.search`, not `Namespace.search`. A literal
   * rather than `constructor.name`, which a minifier may rename.
   * @internal
   */
  protected static readonly SCOPE_KIND: string = 'Scope';

  /** `<Namespace|Thread>.<method>`, for error messages. @internal */
  protected methodLabel(method: string): string {
    return `${(this.constructor as typeof Scope).SCOPE_KIND}.${method}`;
  }

  // -------------------------------------------------------------------
  // Scoping hooks
  //
  // A Namespace IS its collection, so all four hooks are identities. A
  // Thread shares one collection with every other thread in the workspace
  // and overrides them to carry its own clause. They exist so that every
  // read and write below goes through ONE place that can narrow it — a
  // scope clause bolted onto each call site individually is a scope clause
  // that gets forgotten at the next call site added.
  // -------------------------------------------------------------------

  /** Narrow a caller's filter to this scope. Identity for a Namespace. */
  protected combineFilter(filter?: Filter): Filter | undefined {
    return filter;
  }

  /** Refuse point ids that do not belong to this scope. No-op here. */
  protected async assertOwns(_ids: Array<string | number>): Promise<void> {
    return undefined;
  }

  /** Narrow an id list to the ids this scope owns. Identity here. */
  protected async ownedIds(
    ids: Array<string | number>
  ): Promise<Array<string | number>> {
    return ids;
  }

  /**
   * How this scope addresses a list of its own point ids on the wire.
   *
   * A Namespace owns its whole collection, so a bare id list is already
   * exact. A Thread shares its collection, so it returns a FILTER that
   * pins the ids AND the thread — the engine enforces the scope, rather
   * than the SDK checking it first and trusting itself afterwards.
   */
  protected pointSelector(
    ids: Array<string | number>
  ): Array<string | number> | Filter {
    return ids;
  }

  /** True when this scope needs payloads to identify its own points. */
  protected readsPayloadToScope(): boolean {
    return false;
  }

  /** Drop points belonging to another scope. Identity for a Namespace. */
  protected retainOwned(points: Point[], _withPayload: boolean): Point[] {
    return points;
  }

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
    // Read-then-check, NOT a scoped filter — see assertOwns.
    await this.assertOwns([id]);
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
    await this.assertOwns([id]);
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
    await this.assertOwns([id]);
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
    // The client's own search() guard cannot cover this layer: the object
    // below is rebuilt key by key, so an unknown option would die here
    // silently rather than reach it. The same holds for every method below.
    assertAllowedOptionKeys(
      options,
      SEARCH_OPTION_KEYS,
      this.methodLabel('search'),
      'Engine-level search tuning goes in searchParams, e.g. { searchParams: { hnsw_ef: 256 } }.'
    );

    return this.client.search(this.collection, vector, {
      limit: options.limit,
      offset: options.offset,
      queryFilter: this.combineFilter(options.filter),
      withPayload: options.withPayload,
      withVectors: options.withVectors,
      scoreThreshold: options.scoreThreshold,
      searchParams: options.searchParams,
    });
  }

  /**
   * Fetch specific points by ID.
   *
   * Ids that exist in the underlying collection but belong to another
   * scope are not returned: a Thread's point ids are unique within the
   * shared threads collection, not within the thread.
   */
  async retrieve(
    ids: Array<string | number>,
    options: NamespaceRetrieveOptions = {}
  ): Promise<Point[]> {
    assertAllowedOptionKeys(
      options,
      RETRIEVE_OPTION_KEYS,
      this.methodLabel('retrieve')
    );
    const withPayload = options.withPayload ?? true;
    const points = await this.client.retrieve(this.collection, ids, {
      // A Thread has to read payloads to tell its own points from a
      // sibling's. The caller's withPayload choice is still honoured:
      // retainOwned strips what the caller did not ask for.
      withPayload: this.readsPayloadToScope() ? true : options.withPayload,
      withVectors: options.withVectors,
    });
    return this.retainOwned(points, withPayload);
  }

  async count(
    options: { filter?: Filter; exact?: boolean } = {}
  ): Promise<number> {
    assertAllowedOptionKeys(
      options,
      COUNT_OPTION_KEYS,
      this.methodLabel('count')
    );
    return this.client.count(this.collection, {
      countFilter: this.combineFilter(options.filter),
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
  iter(
    options: NamespaceIterOptions = {}
  ): AsyncGenerator<ScrollPoint, void, undefined> {
    // At the call, not in the generator body: see client.scrollIter.
    assertAllowedOptionKeys(
      options,
      ITER_OPTION_KEYS,
      this.methodLabel('iter'),
      'Pass batchSize to control page size; limit and offset are owned by the iterator.'
    );
    return this.client.scrollIter(this.collection, {
      batchSize: options.batchSize,
      scrollFilter: this.combineFilter(options.filter),
      withPayload: options.withPayload,
      withVectors: options.withVectors,
    });
  }

  // -------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------

  /**
   * Delete points — by ID list or by filter — without dropping the scope.
   *
   * An id list is narrowed to the ids this scope owns before the request is
   * sent, so a Thread cannot delete a sibling thread's point by naming its
   * id.
   */
  async delete(selector: Array<string | number> | Filter): Promise<boolean> {
    if (Array.isArray(selector)) {
      if (selector.length === 0) {
        // An empty id list is a no-op, and NOT a request. This is a
        // safety property, not a micro-optimisation: a Thread turns an id
        // list into a `has_id` filter, and a request carrying an empty
        // `has_id` is one engine-side semantic away from matching the
        // whole thread. Never send it.
        return true;
      }
      return this.client.delete(
        this.collection,
        this.pointSelector(selector) as Array<string | number> | Filter
      );
    }
    return this.client.delete(
      this.collection,
      this.combineFilter(selector) as Filter
    );
  }

  /**
   * Atomically drop this scope (destroys the underlying collection).
   * After `clear()`, the scope no longer exists; re-create to use again.
   */
  async clear(): Promise<boolean> {
    return this.client.deleteCollection(this.collection);
  }
}

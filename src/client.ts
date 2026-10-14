import { HttpClient } from './http/client';
import { APIKeyManager } from './auth';
import {
  VectorConfig,
  VectorConfigInput,
  Point,
  SearchResult,
  Collection,
  SearchOptions,
  RetrieveOptions,
  CountOptions,
  CreateFieldIndexOptions,
  ScrollOptions,
  ScrollResult,
  ScrollPoint,
  ScrollIterOptions,
  Filter,
  UsageStats,
  ClientConfig,
  DistanceMetric,
  Schema,
  SchemaData,
  EnforcementMode,
  AnalysisResult,
  FieldAnalysis,
} from './models';
import {
  AetherfyVectorsError,
  CollectionNotFoundError,
  PointNotFoundError,
  ValidationError,
  NetworkError,
  SchemaNotFoundError,
  SchemaValidationError,
  PartialUpsertError,
  RequestTimeoutError,
  WorkspaceNotFoundError,
  createErrorFromResponse,
} from './exceptions';
import { HttpResponse } from './http/types';
import { retryWithBackoff, validatePointId } from './utils';
import { OPERATIONS, Operation } from './retry-policy';
import { assertAllowedOptionKeys, optionKeys } from './utils/options';
import { serializeFilter } from './utils/filter';
import { chunkPointsByBytes, MAX_REQUEST_BYTES } from './utils/chunking';
import { validateVectors } from './schema';

// The accepted keys of every public options object on this client, derived
// from its type by optionKeys(): a key added to or removed from the type
// without the same change here does not compile. See src/utils/options.ts.
// CLIENT_CONFIG_KEYS is exported for MemoryClient, which refuses these keys
// beside a bring-your-own client (not part of the package's exports).
// Every collection lives in a workspace, so a client without one is refused
// at construction rather than on its first request.
const NO_WORKSPACE_MESSAGE =
  'A workspace is required: every collection lives in one. Pass a workspace ' +
  "name (workspace: 'my-workspace'), or run inside an Aetherfy agent and keep " +
  "the default workspace: 'auto'.";
const NO_WORKSPACE_MESSAGE_AUTO =
  "workspace: 'auto' reads AETHERFY_WORKSPACE_ID, which is not set: it is set " +
  'only inside an Aetherfy agent. Pass a workspace name ' +
  "(workspace: 'my-workspace'), or run inside an Aetherfy agent.";

export const CLIENT_CONFIG_KEYS = optionKeys<ClientConfig>({
  apiKey: true,
  endpoint: true,
  timeout: true,
  enableConnectionPooling: true,
  workspace: true,
  apiRegion: true,
});
const SET_PAYLOAD_OPTION_KEYS = optionKeys<
  NonNullable<Parameters<AetherfyVectorsClient['setPayload']>[3]>
>({ key: true });
const RETRIEVE_OPTION_KEYS = optionKeys<RetrieveOptions>({
  withPayload: true,
  withVectors: true,
});
const SEARCH_OPTION_KEYS = optionKeys<SearchOptions>({
  limit: true,
  offset: true,
  queryFilter: true,
  withPayload: true,
  withVectors: true,
  scoreThreshold: true,
  searchParams: true,
});
const SCROLL_OPTION_KEYS = optionKeys<ScrollOptions>({
  limit: true,
  offset: true,
  scrollFilter: true,
  withPayload: true,
  withVectors: true,
});
const SCROLL_ITER_OPTION_KEYS = optionKeys<ScrollIterOptions>({
  batchSize: true,
  scrollFilter: true,
  withPayload: true,
  withVectors: true,
});
const COUNT_OPTION_KEYS = optionKeys<CountOptions>({
  countFilter: true,
  exact: true,
});
const CREATE_FIELD_INDEX_OPTION_KEYS = optionKeys<CreateFieldIndexOptions>({
  timeout: true,
});

// Payload-index writes (create and delete). The server holds ONE of them for
// up to INDEX_WAIT_BUDGET_MS while Qdrant applies it, then answers
// "acknowledged" (still in progress). Mirrors vectordb
// backend/config/timeouts.js INDEX_WAIT_BUDGET_MS. When the region that answers
// does not host the collection it forwards the write first, which vectordb
// allows INDEX_FORWARD_MARGIN_MS for (FORWARD_MARGIN_MS in the same file). Each
// attempt's HTTP timeout, INDEX_ATTEMPT_TIMEOUT_MS (or the client's timeout if
// that is longer), must outlast both, plus this client's own hop, or the SDK
// times out before the server's answer arrives. The default 30 s did not leave
// room for the forward. The relation is pinned against vectordb's and the
// Python SDK's source by aetherfy-e2e-tests
// tests/pyunit/test_index_timeouts_pair.py, and locally in
// tests/unit/field-index.test.ts. Mirrors the Python SDK's client.py.
// Exported for the tests, not from the package.
export const INDEX_WAIT_BUDGET_MS = 25000;
export const INDEX_FORWARD_MARGIN_MS = 5000;
export const INDEX_ATTEMPT_TIMEOUT_MS = 45000;
// createFieldIndex is never unbounded: with no options.timeout it stops at
// INDEX_DEFAULT_DEADLINE_MS with the same "still building" error. And an
// "acknowledged" that came back faster than INDEX_WAIT_BUDGET_MS means the
// server did not hold the create (a vectordb from before db26396 answers every
// create that way, at once), so the next create waits first:
// INDEX_RESEND_PAUSE_FIRST_MS, doubling up to INDEX_RESEND_PAUSE_MAX_MS. An
// "acknowledged" the server held for its budget is re-sent at once. Mirrors
// the Python SDK's client.py.
export const INDEX_DEFAULT_DEADLINE_MS = 600000;
export const INDEX_RESEND_PAUSE_FIRST_MS = 1000;
export const INDEX_RESEND_PAUSE_MAX_MS = 10000;

/**
 * Aetherfy Vectors JavaScript SDK
 *
 * Global vector database client with automatic replication,
 * intelligent caching, and worldwide sub-50ms latency.
 *
 * Works in both Node.js and browser environments.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const client = new AetherfyVectorsClient({
 *   apiKey: 'afy_live_your_api_key_here'
 * });
 *
 * // Create a collection
 * await client.createCollection('products', {
 *   size: 128,
 *   distance: DistanceMetric.COSINE
 * });
 *
 * // Add points — id is an unsigned integer (≤ 2^53 − 1) or a UUID string
 * await client.upsert('products', [
 *   {
 *     id: 1,
 *     vector: [0.1, 0.2, ...], // 128-dimensional
 *     payload: { name: 'Product A' }
 *   }
 * ]);
 *
 * // Search
 * const results = await client.search('products', queryVector, {
 *   limit: 10,
 *   withPayload: true
 * });
 *
 * // Every collection lives in a workspace. Inside an Aetherfy agent the
 * // default, workspace: 'auto', is the agent's workspace (by id, from
 * // AETHERFY_WORKSPACE_ID); anywhere else, name one.
 * const workspaceClient = new AetherfyVectorsClient({
 *   apiKey: 'afy_live_your_api_key_here',
 *   workspace: 'my-workspace'
 * });
 *
 * // All operations are scoped to the workspace
 * await workspaceClient.search('documents', queryVector);
 * await workspaceClient.upsert('metadata', points);
 * ```
 */
export class AetherfyVectorsClient {
  private static readonly DEFAULT_ENDPOINT = 'https://vectors.aetherfy.com';
  private static readonly DEFAULT_TIMEOUT = 30000;
  /**
   * The first retry's wait, in ms (then doubled, each jittered to 50-100%).
   * @internal The unit tests shorten it, as the Python suite patches sleep.
   */
  static retryBaseDelayMs = 1000;
  private static readonly VALID_REGIONS: ReadonlySet<string> = new Set([
    'us-east-1',
    'eu-central-1',
    'ap-southeast-1',
  ]);
  /**
   * The pinned API/connection endpoint region (when `apiRegion` was
   * provided to `create()`); null otherwise. This is the regional API
   * endpoint the client connects to — a transport/routing pin, NOT where
   * collections live. Read-only after construction.
   */
  public readonly apiRegion:
    | 'us-east-1'
    | 'eu-central-1'
    | 'ap-southeast-1'
    | null = null;

  private httpClient: HttpClient;
  private authManager: APIKeyManager;
  private readonly endpoint: string;
  /** The per-attempt request timeout this client was built with, in ms. */
  private readonly requestTimeoutMs: number;
  /**
   * The workspace name, or `undefined` when the client addresses its
   * workspace by id (`workspace: 'auto'`; see `workspaceId`). Read-only.
   */
  readonly workspace?: string;
  /**
   * The workspace id (`workspace: 'auto'`, from AETHERFY_WORKSPACE_ID), or
   * `undefined` when the client was given a workspace name. Read-only.
   */
  readonly workspaceId?: string;
  private schemaCache: Map<
    string,
    { size: number; distance: string; etag?: string }
  >;
  private payloadSchemaCache: Map<string, SchemaData | null>;

  /**
   * Construct a client with a pre-resolved endpoint.
   *
   * Use {@link AetherfyVectorsClient.create} when you need apiRegion= /
   * /api/v1/regions discovery — `create()` runs the async discovery
   * before constructing, so by the time you have a client every
   * field (endpoint, analytics, apiRegion) is already final.
   *
   * `new` works for the synchronous resolution paths:
   *   - Explicit `endpoint=`
   *   - `AETHERFY_VECTORS_URL` env var
   *   - Default global endpoint
   *
   * Passing `apiRegion=` to `new` throws — apiRegion= requires `create()`.
   * The constructor cannot do async discovery, and silently deferring
   * to first method call (the previous behavior) is a footgun. apiRegion
   * is the API/connection endpoint pin (which regional backend to talk
   * to), a standalone/local-dev/debug override — in integrated agents
   * the injected `AETHERFY_VECTORS_URL` wins. Distinct from a
   * collection's placement `regions`.
   *
   * @param config - Configuration options
   */
  constructor(config: ClientConfig = {}) {
    assertAllowedOptionKeys(
      config,
      CLIENT_CONFIG_KEYS,
      'AetherfyVectorsClient constructor'
    );

    // Initialize authentication
    const apiKey = APIKeyManager.resolveApiKey(config.apiKey);
    this.authManager = new APIKeyManager(apiKey);

    this.requestTimeoutMs =
      config.timeout || AetherfyVectorsClient.DEFAULT_TIMEOUT;
    this.httpClient = new HttpClient({
      timeout: this.requestTimeoutMs,
      defaultHeaders: this.authManager.getAuthHeaders(),
      enableConnectionPooling: config.enableConnectionPooling,
    });

    // Resolve endpoint synchronously. apiRegion= cannot be honored here —
    // that's create()'s job — so reject it explicitly to avoid the
    // previous "looks like it works but discovery isn't done yet"
    // footgun. The exception to this rule: create() calls the
    // constructor with a pre-resolved endpoint (and apiRegion= cleared);
    // see `_constructWithResolvedEndpoint`.
    /* c8 ignore next 4 */
    const envEndpoint =
      typeof process !== 'undefined'
        ? process.env?.AETHERFY_VECTORS_URL
        : undefined;

    if (config.apiRegion) {
      if (!AetherfyVectorsClient.VALID_REGIONS.has(config.apiRegion)) {
        throw new Error(
          `apiRegion must be one of us-east-1, eu-central-1, ap-southeast-1 (got ${String(config.apiRegion)})`
        );
      }
      // env var wins over apiRegion= regardless of how the caller got here.
      if (envEndpoint) {
        console.warn(
          `Both AETHERFY_VECTORS_URL and apiRegion=${config.apiRegion} are set; ` +
            'using AETHERFY_VECTORS_URL (apiRegion= is a standalone/local-dev ' +
            'override; the injected URL wins in integrated agents)'
        );
        this.endpoint = envEndpoint;
      } else if (config.endpoint) {
        this.endpoint = config.endpoint;
      } else {
        // Direct `new` with apiRegion= and no env-var/endpoint override:
        // this is the footgun case. Tell the caller to use create().
        throw new Error(
          'apiRegion= requires async region discovery. Use ' +
            '`await AetherfyVectorsClient.create({...})` instead of `new`.'
        );
      }
      this.apiRegion = config.apiRegion;
    } else if (config.endpoint) {
      this.endpoint = config.endpoint;
    } else if (envEndpoint) {
      this.endpoint = envEndpoint;
    } else {
      this.endpoint = AetherfyVectorsClient.DEFAULT_ENDPOINT;
    }

    const resolved = AetherfyVectorsClient.resolveWorkspace(config);
    this.workspace = resolved.workspace;
    this.workspaceId = resolved.workspaceId;

    this.schemaCache = new Map();
    this.payloadSchemaCache = new Map();
  }

  /**
   * Async factory — the canonical way to construct a client with
   * apiRegion= or any other future async configuration. Mirrors Python's
   * `AetherfyVectorsClient(api_key=..., api_region='eu-central-1')` contract:
   * when you have a client, it's fully ready.
   *
   * `apiRegion` is the API/connection endpoint pin (which regional
   * backend to connect to) — a standalone/local-dev/debug override, NOT
   * collection placement. In integrated agents the injected
   * `AETHERFY_VECTORS_URL` wins. Distinct from a collection's placement
   * `regions`.
   *
   * Resolution order (same as Python):
   *   1. Explicit `config.endpoint`.
   *   2. `AETHERFY_VECTORS_URL` env var.
   *   3. `config.apiRegion` → `GET /api/v1/regions` discovery.
   *   4. Default global endpoint.
   *
   * When the env var and `apiRegion=` are both set, the env var wins and
   * a warning is logged.
   *
   * @example
   * ```typescript
   * const client = await AetherfyVectorsClient.create({
   *   apiKey: 'afy_test_...',
   *   apiRegion: 'eu-central-1',
   * });
   * ```
   */
  static async create(
    config: ClientConfig = {}
  ): Promise<AetherfyVectorsClient> {
    // Before discovery: an unknown key must not cost a network round trip,
    // and must fail under this method's name, not the constructor's.
    assertAllowedOptionKeys(
      config,
      CLIENT_CONFIG_KEYS,
      'AetherfyVectorsClient.create'
    );
    // Refuse a missing workspace before discovery makes a request.
    AetherfyVectorsClient.resolveWorkspace(config);

    // Validate eagerly — same semantics as Python's __init__.
    if (
      config.apiRegion !== undefined &&
      config.apiRegion !== null &&
      !AetherfyVectorsClient.VALID_REGIONS.has(config.apiRegion)
    ) {
      throw new Error(
        `apiRegion must be one of us-east-1, eu-central-1, ap-southeast-1 (got ${String(config.apiRegion)})`
      );
    }

    /* c8 ignore next 4 */
    const envEndpoint =
      typeof process !== 'undefined'
        ? process.env?.AETHERFY_VECTORS_URL
        : undefined;

    // If apiRegion= is irrelevant (no apiRegion OR an override is present),
    // delegate to the sync constructor — nothing to discover.
    if (!config.apiRegion || config.endpoint || envEndpoint) {
      return new AetherfyVectorsClient(config);
    }

    // apiRegion= without override: run discovery on the default global
    // endpoint, then construct with the resolved per-region URL.
    const apiKey = APIKeyManager.resolveApiKey(config.apiKey);
    const tempAuth = new APIKeyManager(apiKey);
    const tempHttp = new HttpClient({
      timeout: config.timeout || AetherfyVectorsClient.DEFAULT_TIMEOUT,
      defaultHeaders: tempAuth.getAuthHeaders(),
      enableConnectionPooling: config.enableConnectionPooling,
    });
    const url = AetherfyVectorsClient.buildApiUrl(
      AetherfyVectorsClient.DEFAULT_ENDPOINT,
      '/regions'
    );
    let response;
    try {
      response = await tempHttp.get<Record<string, string>>(
        url,
        tempAuth.getAuthHeaders()
      );
    } catch (err) {
      tempHttp.destroy();
      const msg = err instanceof Error ? err.message : 'unknown error';
      throw new AetherfyVectorsError(
        `Could not resolve apiRegion '${config.apiRegion}' via discovery: ${msg}. ` +
          'Check that the default endpoint is reachable, or pass endpoint= directly.'
      );
    }
    tempHttp.destroy();
    if (response.status !== 200) {
      throw new AetherfyVectorsError(
        `Region discovery returned ${response.status} from ${url}. ` +
          'Check that your API key is valid for the discovery endpoint.'
      );
    }
    const cache = (response.data as Record<string, string>) ?? {};
    if (!(config.apiRegion in cache)) {
      throw new AetherfyVectorsError(
        `Region '${config.apiRegion}' not configured at the discovery endpoint ` +
          `(available: ${JSON.stringify(Object.keys(cache).sort())}).`
      );
    }
    // Construct with the resolved URL pinned as endpoint=. The
    // constructor sees both `apiRegion` and `endpoint`, takes the
    // endpoint path, and still assigns this.apiRegion for caller-visible
    // identification.
    return new AetherfyVectorsClient({
      ...config,
      endpoint: cache[config.apiRegion],
    });
  }

  /**
   * The workspace: a name, or (for 'auto', the default) the agent's
   * workspace id. Exactly one is set; there is no workspaceless client.
   * undefined is "not given"; null and '' are refused. Decided before any
   * request (create() calls it ahead of region discovery).
   */
  private static resolveWorkspace(config: ClientConfig): {
    workspace?: string;
    workspaceId?: string;
  } {
    const workspace: unknown =
      config.workspace === undefined ? 'auto' : config.workspace;
    if (workspace === 'auto') {
      /* c8 ignore next 4 */
      const id =
        typeof process !== 'undefined'
          ? process.env?.AETHERFY_WORKSPACE_ID
          : undefined;
      if (!id) {
        throw new Error(NO_WORKSPACE_MESSAGE_AUTO);
      }
      return { workspaceId: id };
    }
    if (typeof workspace === 'string' && workspace) {
      return { workspace };
    }
    throw new Error(NO_WORKSPACE_MESSAGE);
  }

  /** Build a fully-qualified API URL from the endpoint host and a path. */
  private apiUrl(path: string): string {
    return AetherfyVectorsClient.buildApiUrl(this.endpoint, path);
  }

  /** Static counterpart of {@link apiUrl}, for use without an instance. */
  private static buildApiUrl(host: string, path: string): string {
    const base = host.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}/api/v1${p}`;
  }

  /**
   * The local cache-key prefix of this client's workspace: `name/`, or
   * `id:<uuid>/` for 'auto'. Never sent on the wire.
   * @private
   */
  private scopePrefix(): string {
    return this.workspaceId !== undefined
      ? `id:${this.workspaceId}/`
      : `${this.workspace}/`;
  }

  /**
   * Local cache-key for a collection name, never sent on the wire. The
   * prefix keeps same-name collections in different workspaces, and the
   * two ways of addressing a workspace, from ever sharing a cache entry.
   * @private
   */
  private scopeCollection(collection: string): string {
    return `${this.scopePrefix()}${collection}`;
  }

  /**
   * Strip the workspace prefix from a local cache key.
   * @private
   */
  private unscopeCollection(scopedName: string): string {
    const prefix = this.scopePrefix();
    return scopedName.startsWith(prefix)
      ? scopedName.substring(prefix.length)
      : scopedName;
  }

  /**
   * `/workspace-ids/{id}` for 'auto', else `/workspaces/{name}`.
   * @private
   */
  private workspacePath(): string {
    return this.workspaceId !== undefined
      ? `/workspace-ids/${encodeURIComponent(this.workspaceId)}`
      : `/workspaces/${encodeURIComponent(this.workspace ?? '')}`;
  }

  /**
   * The URL path of a collection in this client's workspace.
   *
   * @param collectionName Bare collection name from the caller.
   * @param suffix         Optional path suffix appended after the
   *                       collection segment (e.g. `/points/query`).
   *                       Must already begin with `/` when non-empty.
   * @private
   */
  private buildCollectionPath(
    collectionName: string,
    suffix: string = ''
  ): string {
    const enc = encodeURIComponent(collectionName);
    return `${this.workspacePath()}/collections/${enc}${suffix}`;
  }

  /**
   * The list/create endpoint of this client's workspace.
   * @private
   */
  private buildCollectionsListPath(): string {
    return `${this.workspacePath()}/collections`;
  }

  // Collection Management

  /**
   * Create a new collection with specified vector configuration
   *
   * @param collectionName - Collection name (must be unique)
   * @param vectorsConfig - Vector configuration or legacy config object
   * @param description - Optional collection description (max 500 characters)
   * @param regions - Optional explicit placement regions for this collection.
   *   Omit to default to your full scope — the server resolves it
   *   and the returned Collection echoes the explicit list. Pass a subset of
   *   your scope to pin the collection to those regions; an empty array is
   *   rejected by the server (422). Subset/empty validation is server-side.
   *   Distinct from the constructor's `apiRegion`, which selects the endpoint
   *   to connect to rather than where the collection lives.
   * @returns Promise resolving to the created Collection, including its
   *   resolved `regions` list.
   *
   * @example
   * ```typescript
   * const coll = await client.createCollection('my-collection', {
   *   size: 384,
   *   distance: DistanceMetric.COSINE
   * }, 'My collection', ['us-east-1']);
   * console.log(coll.regions); // ['us-east-1']
   * ```
   */
  async createCollection(
    collectionName: string,
    vectorsConfig: VectorConfig | VectorConfigInput,
    description?: string,
    regions?: string[]
  ): Promise<Collection> {
    this.validateCollectionName(collectionName);

    const config = this.normalizeVectorConfig(vectorsConfig);
    const scopedName = this.scopeCollection(collectionName);

    try {
      // The workspace is in the URL; the body name is bare (vectordb
      // rejects any "/" in it).
      const body: Record<string, unknown> = {
        name: collectionName,
        vectors: config,
        description: description || null,
      };
      // §66: forward `regions` only when the caller provided it. Omission
      // triggers server-side resolve-on-omit (the full scope); an explicit
      // [] IS forwarded so the server returns 422 COLLECTION_REGIONS_EMPTY,
      // rather than the SDK silently treating [] as "all regions". Subset
      // enforcement is the server's job.
      if (regions !== undefined) {
        body.regions = regions;
      }

      const response = await this.send('createCollection', async () =>
        this.httpClient.post<{ regions?: string[] }>(
          this.apiUrl(this.buildCollectionsListPath()),
          body
        )
      );

      if (response.status === 200 || response.status === 201) {
        // Prepopulate the schema cache from the request we just authored.
        // A GET immediately after create can race the read-after-write
        // window; size + distance are ground truth from the caller, so no
        // extra round trip is needed. etag stays undefined until a real GET.
        this.schemaCache.set(scopedName, {
          size: config.size,
          distance: config.distance,
        });
      }

      // §66 Option SDK-B: return the created collection with its resolved
      // placement regions echoed by the server (the full scope on omit, the
      // caller's subset otherwise; the stored list on idempotent re-create).
      return {
        name: collectionName,
        config,
        description,
        regions: response.data?.regions,
      };
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Delete a collection and all its data
   *
   * @param collectionName - Collection name to delete
   * @returns Promise that resolves to true if successful
   */
  async deleteCollection(collectionName: string): Promise<boolean> {
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    try {
      const response = await this.send('deleteCollection', () =>
        this.httpClient.delete(
          this.apiUrl(this.buildCollectionPath(collectionName))
        )
      );

      const ok = response.status === 200 || response.status === 204;
      if (ok) {
        // Drop both caches so a subsequent recreate-with-different-shape
        // doesn't see stale size/distance/etag/payload-schema entries.
        this.schemaCache.delete(scopedName);
        this.payloadSchemaCache.delete(scopedName);
      }
      return ok;
    } catch (error: unknown) {
      // Cover the "already gone" case (cross-client delete that beat us)
      // so we don't leave stale entries when our DELETE hits a 404.
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  /**
   * Get list of all collections
   *
   * @returns Promise that resolves to array of collections
   */
  async getCollections(): Promise<Collection[]> {
    try {
      const response = await this.send('getCollections', () =>
        this.httpClient.get<{ collections: Collection[] }>(
          this.apiUrl(this.buildCollectionsListPath())
        )
      );

      // The workspace's list holds only its own collections, with bare
      // names: nothing to filter or unscope.
      return response.data.collections || [];
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  /**
   * Check if a collection exists
   *
   * @param collectionName - Collection name to check
   * @returns Promise that resolves to true if collection exists
   */
  async collectionExists(collectionName: string): Promise<boolean> {
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    // Fast path: if this client just created (or recently used) the
    // collection, the schema cache holds proof of existence. Skip the
    // network round trip and the read-after-write window of the upstream
    // store. deleteCollection() clears the cache, so a stale `true`
    // after a remote delete is bounded to cross-client deletes only —
    // and any subsequent operation will surface the real 404.
    if (this.getCachedSchema(scopedName) !== undefined) {
      return true;
    }

    try {
      await this.send('collectionExists', () =>
        this.httpClient.get(
          this.apiUrl(this.buildCollectionPath(collectionName))
        )
      );
      return true;
    } catch (error: unknown) {
      if (
        error &&
        typeof error === 'object' &&
        ('status' in error || 'statusCode' in error)
      ) {
        // Only "this collection is not in the workspace" is a false; an
        // unknown workspace (WORKSPACE_NOT_FOUND) or a refusal is thrown.
        if (this.errorCodeOf(error) === 'COLLECTION_NOT_FOUND') {
          // No-op when cache is already empty (we got past the
          // fast-path check above), but the call keeps the contract
          // "collection gone → caches dropped" uniform.
          this.evictCachesIfNotFound(scopedName, error);
          return false;
        }
      }
      throw this.handleError(error);
    }
  }

  /**
   * Get information about a specific collection
   *
   * @param collectionName - Collection name
   * @returns Promise that resolves to collection information
   */
  async getCollection(collectionName: string): Promise<Collection> {
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    try {
      const response = await this.send('getCollection', () =>
        this.httpClient.get<{ result: Collection }>(
          this.apiUrl(this.buildCollectionPath(collectionName))
        )
      );

      // vectordb returns the bare collection name: nothing to unscope.
      return response.data.result;
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  // Point Operations

  /**
   * Insert or update points in a collection.
   *
   * Auto-chunks large batches into multiple HTTP requests to stay under
   * the per-request byte cap (`MAX_REQUEST_BYTES` ~24 MB, sized for the
   * backend's 90 s processing budget under wait=true). Most batches fit
   * in one chunk; the chunker is transparent for small/medium upserts.
   *
   * Failure behaviour:
   *   - Transient errors are retried per chunk under the retry rule
   *     (retry-policy.ts; upsert is repeatable), with exponential backoff.
   *   - Permanent errors on a chunk after retries: if there's only one
   *     chunk, the specific error (Validation, ServiceUnavailable, etc.)
   *     is thrown directly — same as pre-chunking behaviour.
   *   - Permanent errors when there are multiple chunks AND at least one
   *     chunk succeeded: throws `PartialUpsertError` carrying the saved
   *     count and the failed chunks' point IDs + errors. Callers can
   *     retry just those IDs (Qdrant upsert is idempotent by point ID
   *     so a retry of an already-saved point is also safe).
   *   - Permanent errors when ALL chunks fail (multi-chunk): also throws
   *     `PartialUpsertError` with saved=0 and all chunks' IDs in failed.
   *
   * @param collectionName - Name of the collection
   * @param points - Array of points to upsert
   * @returns Promise that resolves to true if all points were saved
   *
   * @throws PartialUpsertError - When multi-chunk upsert has any failed chunks
   * @throws ValidationError - Single-chunk validation / 400 errors
   * @throws ServiceUnavailableError - Single-chunk 503 after retries
   * @throws NetworkError - Single-chunk network failure after retries
   *
   * @example
   * ```typescript
   * // id is an unsigned integer (≤ 2^53 − 1) or a UUID string
   * await client.upsert('products', [
   *   {
   *     id: '550e8400-e29b-41d4-a716-446655440000',
   *     vector: [0.1, 0.2, 0.3, ...],
   *     payload: { name: 'Product A', category: 'electronics' }
   *   }
   * ]);
   * ```
   */
  async upsert(
    collectionName: string,
    points: Point[] | Record<string, unknown>[]
  ): Promise<boolean> {
    this.validateCollectionName(collectionName);
    this.validateBatchSize(points);

    const scopedName = this.scopeCollection(collectionName);

    // Get vector schema (from cache or fetch). fetchAndCacheSchema
    // computes its own scopedName for the cache key from the bare
    // collectionName, and builds the wire URL via buildCollectionPath.
    let schema = this.getCachedSchema(scopedName);
    if (!schema) {
      try {
        schema = await this.fetchAndCacheSchema(collectionName);
      } catch (error: unknown) {
        // The schema GET is a collection-scoped read; a 404 here means
        // the collection is gone (likely a cross-client delete), so
        // self-heal both caches before re-throwing.
        this.evictCachesIfNotFound(scopedName, error);
        if (error instanceof AetherfyVectorsError) {
          throw error;
        }
        throw this.handleError(error);
      }
    }

    // Validate vector dimensions
    const expectedDim = schema.size;
    for (const point of points) {
      const typedPoint = point as Record<string, unknown>;
      const vector = typedPoint.vector;
      if (!vector || !Array.isArray(vector)) {
        throw new ValidationError('Each point must have a vector array');
      }

      if (vector.length !== expectedDim) {
        throw new ValidationError(
          `Vector dimension mismatch: expected ${expectedDim}, got ${vector.length}`
        );
      }
    }

    // Get payload schema for validation (if exists)
    const payloadSchemaData = await this.getCachedPayloadSchema(scopedName);

    // Client-side payload validation
    if (payloadSchemaData && payloadSchemaData.schema) {
      const enforcementMode = payloadSchemaData.enforcementMode || 'off';

      // Only validate if enforcement is not 'off'
      if (enforcementMode !== 'off') {
        const validationErrors = validateVectors(
          points,
          payloadSchemaData.schema
        );
        if (validationErrors.length > 0) {
          // Only raise error in strict mode
          if (enforcementMode === 'strict') {
            throw new SchemaValidationError(validationErrors);
          }
          // In warn mode, just allow the request to proceed
          // (warnings would be logged client-side if we had a logger)
        }
      }
    }

    const formattedPoints = this.formatPointsForUpsert(points);

    // Chunk by byte size. Most upserts produce a single chunk; the
    // multi-chunk path only fires for batches large enough to risk the
    // backend's per-request processing budget (>~24 MB JSON wire size).
    const chunks = Array.from(
      chunkPointsByBytes(formattedPoints, MAX_REQUEST_BYTES)
    );

    if (chunks.length === 1) {
      // Single-chunk fast path: preserves the pre-chunking behaviour
      // exactly — specific errors (ValidationError, NetworkError, etc.)
      // are thrown directly without PartialUpsertError wrapping.
      return this._uploadPointsChunk(
        scopedName,
        collectionName,
        chunks[0],
        schema,
        payloadSchemaData
      );
    }

    // Multi-chunk path: per-chunk error tracking. Each chunk goes through
    // the same upload+retry+412 handling as the single-chunk path; only
    // the outer failure aggregation differs.
    let saved = 0;
    const failed: Array<{
      pointIds: Array<string | number>;
      error: AetherfyVectorsError;
    }> = [];

    for (const chunk of chunks) {
      try {
        await this._uploadPointsChunk(
          scopedName,
          collectionName,
          chunk,
          schema,
          payloadSchemaData
        );
        saved += chunk.length;
      } catch (error: unknown) {
        const chunkError =
          error instanceof AetherfyVectorsError
            ? error
            : this.handleError(error);
        failed.push({
          pointIds: chunk.map(p => p.id),
          error: chunkError,
        });
      }
    }

    if (failed.length > 0) {
      throw new PartialUpsertError(saved, formattedPoints.length, failed);
    }
    return true;
  }

  /**
   * Per-chunk upload. Mirrors the pre-chunking single-PUT logic exactly:
   * If-Match headers from schema ETags, send() (the retry rule) for
   * transient failures, per-status handling (412 schema-change retry, 400, 500+),
   * 404 cache self-heal. Returns true on 200; throws otherwise.
   *
   * Extracted so the multi-chunk loop can call it per-chunk and aggregate
   * failures into PartialUpsertError without duplicating ~150 lines of
   * error-handling logic.
   */
  private async _uploadPointsChunk(
    scopedName: string,
    originalCollectionName: string,
    chunk: Point[],
    schema: { etag?: string },
    payloadSchemaData: SchemaData | null
  ): Promise<boolean> {
    try {
      // Add If-Match headers with ETags
      const headers: Record<string, string> = {};
      if (schema.etag) {
        headers['If-Match'] = schema.etag;
      }
      // Payload schema ETag overrides vector schema ETag
      if (payloadSchemaData && payloadSchemaData.etag) {
        headers['If-Match'] = payloadSchemaData.etag;
      }

      const response = await this.send('upsert', async () =>
        this.httpClient.put(
          this.apiUrl(
            this.buildCollectionPath(originalCollectionName, '/points')
          ),
          { points: chunk },
          headers
        )
      );

      return response.status === 200;
    } catch (error: unknown) {
      // Self-heal first: if the upstream returned 404, the collection
      // is gone (cross-client delete). Drop both caches before the
      // specific-status handlers below decide how to re-throw. No-op
      // for any non-404 error.
      this.evictCachesIfNotFound(scopedName, error);
      // Handle specific HTTP error statuses from HttpClient
      if (error && typeof error === 'object' && 'status' in error) {
        const httpError = error as {
          status: number;
          responseData?: Record<string, unknown>;
        };

        // Handle 412 Precondition Failed (schema changed)
        if (httpError.status === 412) {
          this.schemaCache.delete(scopedName);
          this.payloadSchemaCache.delete(scopedName);

          // Fetch updated schemas and re-validate
          let updatedPayloadSchema: SchemaData | null = null;
          try {
            updatedPayloadSchema =
              await this.getCachedPayloadSchema(scopedName);
            if (updatedPayloadSchema && updatedPayloadSchema.schema) {
              const enforcementMode =
                updatedPayloadSchema.enforcementMode || 'off';
              if (enforcementMode !== 'off') {
                const validationErrors = validateVectors(
                  chunk,
                  updatedPayloadSchema.schema
                );
                if (
                  validationErrors.length > 0 &&
                  enforcementMode === 'strict'
                ) {
                  throw new SchemaValidationError(validationErrors);
                }
              }
            }
          } catch (schemaError) {
            if (schemaError instanceof SchemaValidationError) {
              throw schemaError;
            }
            // Ignore other errors during schema refresh
          }

          // Retry the upsert with updated schemas
          try {
            const updatedVectorSchema = await this.fetchAndCacheSchema(
              originalCollectionName
            );
            const retryHeaders: Record<string, string> = {};
            if (updatedVectorSchema.etag) {
              retryHeaders['If-Match'] = updatedVectorSchema.etag;
            }
            if (updatedPayloadSchema && updatedPayloadSchema.etag) {
              retryHeaders['If-Match'] = updatedPayloadSchema.etag;
            }

            const response = await this.send('upsert', () =>
              this.httpClient.put(
                this.apiUrl(
                  this.buildCollectionPath(originalCollectionName, '/points')
                ),
                { points: chunk },
                retryHeaders
              )
            );

            return response.status === 200;
          } catch {
            // If retry also fails, raise the original 412 error
            throw new ValidationError(
              `Collection schema has changed for '${originalCollectionName}'. Please retry your request.`
            );
          }
        }

        // Handle 400 (validation error from backend)
        if (httpError.status === 400) {
          const responseData = httpError.responseData;
          // Try nested error object first, then flat error/message
          const errorObj = responseData?.error as
            | { message?: string }
            | undefined;
          const errorMessage =
            errorObj?.message ||
            (responseData?.message as string) ||
            (responseData?.error as string) ||
            'Validation error occurred';
          throw new ValidationError(errorMessage);
        }

        // Handle 500+ (server errors)
        if (httpError.status >= 500) {
          const responseData = httpError.responseData;
          const errorObj = responseData?.error as
            | { message?: string }
            | undefined;
          const errorMessage =
            errorObj?.message ||
            (responseData?.message as string) ||
            'Unknown server error';
          throw new AetherfyVectorsError(
            `Server error occurred: ${errorMessage}`
          );
        }
      }

      throw this.handleError(error);
    }
  }

  /**
   * Delete points from a collection
   *
   * @param collectionName - Name of the collection
   * @param pointsSelector - Array of point IDs or filter conditions
   * @returns Promise that resolves to true if successful
   */
  async delete(
    collectionName: string,
    pointsSelector: (string | number)[] | Filter
  ): Promise<boolean> {
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    const isFilter = !Array.isArray(pointsSelector);
    if (!isFilter) {
      pointsSelector.forEach(validatePointId);
    }
    const body = isFilter
      ? { filter: serializeFilter(pointsSelector, 'delete') }
      : { points: pointsSelector };

    try {
      const response = await this.send('delete', () =>
        this.httpClient.post(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/points/delete')
          ),
          body
        )
      );

      return response.status === 200;
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  // ---------------------------------------------------------------------
  // Payload mutation
  //
  // Three helpers for the three payload-mutation endpoints. Server-side
  // cap: body.points.length <= 512.
  // ---------------------------------------------------------------------

  /**
   * Set (additive merge) payload keys on a list of points.
   *
   * POST /collections/{name}/points/payload — keys not on the point are
   * added; keys that already exist are overwritten with the new value;
   * keys present on the point but not in `payload` are left untouched.
   *
   * @param collectionName - Target collection.
   * @param payload - Payload object to merge into each point's payload.
   * @param points - Point IDs to update. Server caps at 512.
   * @param options - Optional. `key` targets the merge inside a nested
   *   payload sub-object instead of the top level — every key in
   *   `payload` is merged into `payload[key]`, preserving siblings not
   *   mentioned. Used by `mergeMetadata` for atomic per-point
   *   partial-merge semantics under `payload.metadata`.
   */
  async setPayload(
    collectionName: string,
    payload: Record<string, unknown>,
    points: Array<string | number>,
    options: { key?: string } = {}
  ): Promise<unknown> {
    assertAllowedOptionKeys(options, SET_PAYLOAD_OPTION_KEYS, 'setPayload');
    this.validateCollectionName(collectionName);
    points.forEach(validatePointId);
    const scopedName = this.scopeCollection(collectionName);

    const body: Record<string, unknown> = { payload, points };
    if (options.key !== undefined) body.key = options.key;

    try {
      const response = await this.send('setPayload', () =>
        this.httpClient.post(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/points/payload')
          ),
          body
        )
      );
      return response.data;
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  /**
   * Replace the entire payload on a list of points.
   *
   * PUT /collections/{name}/points/payload — keys present on the point but
   * absent from `payload` are REMOVED. Use this when the payload should be
   * exactly `payload` after the call.
   */
  async overwritePayload(
    collectionName: string,
    payload: Record<string, unknown>,
    points: Array<string | number>
  ): Promise<unknown> {
    this.validateCollectionName(collectionName);
    points.forEach(validatePointId);
    const scopedName = this.scopeCollection(collectionName);

    try {
      const response = await this.send('overwritePayload', () =>
        this.httpClient.put(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/points/payload')
          ),
          { payload, points }
        )
      );
      return response.data;
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  /**
   * Delete specific payload keys from a list of points.
   *
   * POST /collections/{name}/points/payload/delete — only the named keys
   * are removed; other keys on each point's payload are preserved.
   */
  async deletePayload(
    collectionName: string,
    keys: string[],
    points: Array<string | number>
  ): Promise<unknown> {
    this.validateCollectionName(collectionName);
    points.forEach(validatePointId);
    const scopedName = this.scopeCollection(collectionName);

    try {
      // POST /points/payload/delete (not DELETE /points/payload) —
      // matches the underlying wire contract.
      const response = await this.send('deletePayload', () =>
        this.httpClient.post(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/points/payload/delete')
          ),
          { keys, points }
        )
      );
      return response.data;
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  // -------------------------------------------------------------------
  // Payload field indexes
  //
  // An unindexed payload filter is SCANNED, not looked up. A tenant key
  // you filter on for every read (e.g. a per-conversation id) wants an
  // index the moment the collection holds more than one tenant's rows.
  // -------------------------------------------------------------------

  /**
   * Create a payload index on one field, and resolve once it is built.
   *
   * PUT /collections/{name}/index with `{ field_name, field_schema }`.
   * The server waits for the build for up to 25 s. A build that takes
   * longer is answered "acknowledged" (still building), and this method
   * then sends the create again, which waits for the running build, until
   * the answer is "completed". So when it resolves, a filter or an
   * `orderBy` scroll on the key works in the region that answered.
   * Re-creating an existing index with the same schema resolves at once.
   *
   * There is deliberately no way to resolve before the build finishes: a
   * caller that did would scroll into "No range index for order_by key".
   * The wait is always bounded: by `options.timeout`, or else by
   * INDEX_DEFAULT_DEADLINE_MS (10 minutes). An "acknowledged" that came back
   * before the server's 25 s wait was up (so the server did not hold the
   * create) is re-sent only after a pause, 1 s doubling to 10 s.
   *
   * @param collectionName - Collection to index.
   * @param fieldName - Payload key to index; a dotted path addresses a
   *   nested key (`'metadata.tag'`).
   * @param fieldSchema - Index type. A string for the simple types
   *   (`'keyword'`, `'integer'`, `'float'`, `'bool'`, `'geo'`,
   *   `'datetime'`, `'uuid'`, `'text'`), or an object for the
   *   parameterised forms. Forwarded verbatim.
   * @param options.timeout - Deadline in ms for this whole call, every
   *   create and pause included: a finite number above 0. Unset means
   *   INDEX_DEFAULT_DEADLINE_MS (600000). Each create has an HTTP timeout of
   *   45 s (INDEX_ATTEMPT_TIMEOUT_MS), or the client's timeout if that is
   *   longer, or what remains of the deadline if that is shorter.
   * @returns `true`, and only once the index is built. Never `false`.
   * @throws ValidationError - `options.timeout` is not a finite number above
   *   0. Nothing is sent.
   * @throws RequestTimeoutError - The deadline (`options.timeout`, or the
   *   default) passed while the index was still building. The build carries
   *   on server-side, and calling this method again waits for it. If no
   *   answer at all came back within the deadline, the message says so
   *   instead: it is then not known whether the create was taken.
   * @throws AetherfyVectorsError - The server answered a status other than
   *   "completed" or "acknowledged"; the index is not confirmed.
   */
  async createFieldIndex(
    collectionName: string,
    fieldName: string,
    fieldSchema: string | Record<string, unknown> = 'keyword',
    options: CreateFieldIndexOptions = {}
  ): Promise<boolean> {
    assertAllowedOptionKeys(
      options,
      CREATE_FIELD_INDEX_OPTION_KEYS,
      'createFieldIndex'
    );
    this.validateCollectionName(collectionName);
    if (!fieldName || typeof fieldName !== 'string') {
      throw new ValidationError('fieldName must be a non-empty string');
    }
    const given: unknown = options.timeout;
    if (
      given !== undefined &&
      (typeof given !== 'number' || !Number.isFinite(given) || given <= 0)
    ) {
      throw new ValidationError(
        'options.timeout must be a finite number of milliseconds above 0, ' +
          `got ${typeof given === 'string' ? `'${given}'` : String(given)}`
      );
    }
    const scopedName = this.scopeCollection(collectionName);
    const timeout = options.timeout ?? INDEX_DEFAULT_DEADLINE_MS;
    const deadline = this.now() + timeout;
    // The messages name the deadline in seconds, as the Python SDK's do; the
    // option itself stays in ms, like every other duration in this SDK.
    const seconds = `${timeout / 1000} s`;
    const stillBuilding = (): RequestTimeoutError =>
      new RequestTimeoutError(
        `The payload index on '${fieldName}' in collection ` +
          `'${collectionName}' is still building after the ${seconds} ` +
          'deadline. The build carries on server-side; calling ' +
          'createFieldIndex again waits for it.',
        timeout
      );
    const noAnswer = (): RequestTimeoutError =>
      new RequestTimeoutError(
        `The payload index create on '${fieldName}' in collection ` +
          `'${collectionName}' got no answer within the ${seconds} ` +
          'deadline, so it is not known whether it was taken. Calling ' +
          'createFieldIndex again is safe.',
        timeout
      );
    let acknowledged = false;
    let pause = INDEX_RESEND_PAUSE_FIRST_MS;

    for (;;) {
      const remaining = deadline - this.now();
      // Only a build some answer reported is claimed.
      if (remaining <= 0) throw acknowledged ? stillBuilding() : noAnswer();
      const attemptTimeout = Math.min(
        remaining,
        Math.max(this.requestTimeoutMs, INDEX_ATTEMPT_TIMEOUT_MS)
      );
      const started = this.now();

      let response: HttpResponse<{ result?: unknown }>;
      try {
        response = await this.send(
          'createFieldIndex',
          () =>
            this.httpClient.request<{ result?: unknown }>({
              url: this.apiUrl(
                this.buildCollectionPath(collectionName, '/index')
              ),
              method: 'PUT',
              body: { field_name: fieldName, field_schema: fieldSchema },
              // Each attempt, retries included, gets only the time left
              // (as Python's per-attempt budget): none runs past deadline.
              timeout: Math.min(attemptTimeout, deadline - this.now()),
            }),
          deadline
        );
      } catch (error: unknown) {
        // Before the deadline, this is one create outliving its own HTTP
        // timeout, and that error stands. At the deadline, after an
        // "acknowledged" the build is known to be running; on the first
        // create it is not known the create was even taken, so that is not
        // claimed.
        const answered =
          error !== null && typeof error === 'object' && 'status' in error;
        if (!answered && this.now() >= deadline) {
          throw acknowledged ? stillBuilding() : noAnswer();
        }
        this.evictCachesIfNotFound(scopedName, error);
        throw this.handleError(error);
      }

      const result = response.data?.result;
      const status =
        result !== null && typeof result === 'object'
          ? (result as { status?: unknown }).status
          : undefined;
      if (status === 'completed') return true;
      if (status !== 'acknowledged') {
        throw new AetherfyVectorsError(
          `createFieldIndex got status ${
            typeof status === 'string' ? `'${status}'` : String(status)
          } ` +
            `for the payload index on '${fieldName}' in collection ` +
            `'${collectionName}', expected 'completed' or 'acknowledged'; ` +
            'the index is not confirmed built.'
        );
      }
      acknowledged = true;
      if (this.now() - started < INDEX_WAIT_BUDGET_MS) {
        // The server did not hold this create, so re-sending at once would
        // hammer it.
        await this.pause(Math.min(pause, Math.max(deadline - this.now(), 0)));
        pause = Math.min(pause * 2, INDEX_RESEND_PAUSE_MAX_MS);
      }
    }
  }

  // createFieldIndex's clock and its wait between creates: seams, so the tests
  // run on a fake clock. Monotonic, not Date.now(): a wall-clock jump (NTP, a
  // VM resuming) must not move the deadline or the held-or-not check.
  private now(): number {
    return performance.now();
  }

  private pause(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Drop the payload index on one field.
   *
   * DELETE /collections/{name}/index/{fieldName}. Resolves `true` when the
   * collection exists, INCLUDING when that field was never indexed: the
   * server answers that with 200, like a real drop. Resolves `false` only
   * when the collection itself does not exist (404).
   *
   * One request, not retried. The server may hold it as long as a create (up
   * to 25 s, plus a forward), so its HTTP timeout is INDEX_ATTEMPT_TIMEOUT_MS
   * (45 s), or the client's timeout if that is longer.
   */
  async deleteFieldIndex(
    collectionName: string,
    fieldName: string
  ): Promise<boolean> {
    this.validateCollectionName(collectionName);
    if (!fieldName || typeof fieldName !== 'string') {
      throw new ValidationError('fieldName must be a non-empty string');
    }
    const scopedName = this.scopeCollection(collectionName);

    try {
      await this.send('deleteFieldIndex', () =>
        this.httpClient.request({
          url: this.apiUrl(
            this.buildCollectionPath(
              collectionName,
              `/index/${encodeURIComponent(fieldName)}`
            )
          ),
          method: 'DELETE',
          timeout: Math.max(this.requestTimeoutMs, INDEX_ATTEMPT_TIMEOUT_MS),
        })
      );
      return true;
    } catch (error: unknown) {
      if (this.errorCodeOf(error) === 'COLLECTION_NOT_FOUND') {
        this.evictCachesIfNotFound(scopedName, error);
        return false;
      }
      throw this.handleError(error);
    }
  }

  /**
   * Additive merge into existing `payload.metadata`.
   *
   * `mergeMetadata({ tag: 'x' })` adds/updates the listed keys and
   * leaves every other key untouched. Use `setPayload` with the full
   * metadata object if you want to fully replace the metadata sub-key.
   * Concurrent patches to different keys all land atomically;
   * concurrent writes to the same key resolve via last-writer-wins per
   * the storage operation order. Throws `PointNotFoundError` if the
   * point doesn't exist.
   */
  async mergeMetadata(
    collectionName: string,
    pointId: string | number,
    partial: Record<string, unknown>
  ): Promise<unknown> {
    if (
      partial === null ||
      typeof partial !== 'object' ||
      Array.isArray(partial)
    ) {
      throw new TypeError('partial must be a plain object');
    }
    try {
      return await this.setPayload(collectionName, partial, [pointId], {
        key: 'metadata',
      });
    } catch (error: unknown) {
      throw this.translatePointNotFound(error, collectionName, pointId);
    }
  }

  /**
   * Removes the listed keys from `payload.metadata`.
   *
   * Keys not in the list are left untouched. Throws
   * `PointNotFoundError` if the point doesn't exist.
   */
  async deleteMetadataKeys(
    collectionName: string,
    pointId: string | number,
    keys: string[]
  ): Promise<unknown> {
    if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string')) {
      throw new TypeError('keys must be an array of strings');
    }
    const dotted = keys.map(k => `metadata.${k}`);
    try {
      return await this.deletePayload(collectionName, dotted, [pointId]);
    } catch (error: unknown) {
      throw this.translatePointNotFound(error, collectionName, pointId);
    }
  }

  private translatePointNotFound(
    error: unknown,
    collectionName: string,
    pointId: string | number
  ): unknown {
    if (
      error instanceof AetherfyVectorsError &&
      error.statusCode === 404 &&
      !(error instanceof PointNotFoundError) &&
      !(error instanceof CollectionNotFoundError) &&
      !(error instanceof WorkspaceNotFoundError)
    ) {
      return new PointNotFoundError(String(pointId), collectionName);
    }
    return error;
  }

  /**
   * Retrieve points by their IDs
   *
   * @param collectionName - Name of the collection
   * @param ids - Array of point IDs to retrieve
   * @param options - Retrieval options
   * @returns Promise that resolves to array of points
   */
  async retrieve(
    collectionName: string,
    ids: (string | number)[],
    options: RetrieveOptions = {}
  ): Promise<Point[]> {
    assertAllowedOptionKeys(options, RETRIEVE_OPTION_KEYS, 'retrieve');
    this.validateCollectionName(collectionName);
    ids.forEach(validatePointId);

    const scopedName = this.scopeCollection(collectionName);

    if (!ids.length) {
      return [];
    }

    try {
      // Dedicated retrieve URL — POST /collections/<name>/points was
      // previously dual-purpose (upsert vs retrieve, distinguished by
      // body shape). Backend now serves retrieve at /points/retrieve so
      // /points can be unambiguously upsert (and stream-parsed).
      const response = await this.send('retrieve', () =>
        this.httpClient.post<{
          result: Point[];
        }>(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/points/retrieve')
          ),
          {
            ids,
            with_payload: options.withPayload ?? true,
            // Wire field is singular (with_vector); the caller-facing
            // option name `withVectors` is plural by JS convention.
            with_vector: options.withVectors ?? false,
          }
        )
      );

      return response.data.result || [];
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  // Search Operations

  /**
   * Perform similarity search in a collection
   *
   * Sent as POST /collections/{name}/points/query, Qdrant's search route (the
   * API refuses the retired /points/search with 410 ROUTE_RETIRED). The call
   * and its options are unchanged: the vector goes in the body as `query`, the
   * other options keep their wire names, and the matches come back under
   * `result.points`.
   *
   * @param collectionName - Name of the collection to search
   * @param queryVector - Query vector for similarity search
   * @param options - Search options
   * @returns Promise that resolves to search results
   *
   * `searchParams` trades latency for recall: `{ hnsw_ef: 256 }` makes the
   * HNSW walk visit more candidates than the server-side default of
   * hnsw_ef=100 (recall@10 ≈ 0.996 on a realistic corpus); a smaller ef does
   * the reverse. It is sent verbatim as the body's `params` field — see
   * {@link SearchOptions.searchParams} for the cache-key note.
   *
   * @example
   * ```typescript
   * const results = await client.search('products', queryVector, {
   *   limit: 10,
   *   withPayload: true,
   *   scoreThreshold: 0.7
   * });
   *
   * // Recall-first: spend latency on a wider graph walk.
   * const precise = await client.search('products', queryVector, {
   *   limit: 10,
   *   searchParams: { hnsw_ef: 256 },
   * });
   * ```
   */
  async search(
    collectionName: string,
    queryVector: number[],
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    // `{ hnswEf: 256 }` would otherwise be dropped from the body silently,
    // which is how the missing search-params passthrough stayed invisible on
    // the Python side.
    assertAllowedOptionKeys(
      options,
      SEARCH_OPTION_KEYS,
      'search',
      'Engine-level search tuning goes in searchParams, e.g. { searchParams: { hnsw_ef: 256 } }.'
    );

    this.validateCollectionName(collectionName);
    this.validateVector(queryVector);

    const scopedName = this.scopeCollection(collectionName);

    try {
      const response = await this.send('search', async () =>
        this.httpClient.post<{ result: { points: SearchResult[] } }>(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/points/query')
          ),
          {
            query: queryVector,
            limit: options.limit ?? 10,
            offset: options.offset ?? 0,
            filter: serializeFilter(options.queryFilter, 'search'),
            with_payload: options.withPayload ?? true,
            with_vector: options.withVectors ?? false,
            score_threshold: options.scoreThreshold,
            // Untranslated pass-through: the API and Qdrant own the schema,
            // so the SDK enumerates nothing. Last key, and `undefined` when
            // unset — JSON.stringify omits it, keeping the default body
            // byte-for-byte what it was (server cache keys are body-derived).
            params: options.searchParams,
          }
        )
      );

      return response.data.result?.points || [];
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  /**
   * Scroll through points in a collection (Qdrant-compatible pagination).
   *
   * Unlike `search`, scroll iterates over points without vector similarity —
   * used for bulk reads, history fetches, and payload-filtered iteration.
   *
   * @param collectionName - Name of the collection
   * @param options - Scroll options (limit, offset, filter, with_payload, with_vectors)
   * @returns Promise resolving to `{ points, nextPageOffset }`
   */
  async scroll(
    collectionName: string,
    options: ScrollOptions = {}
  ): Promise<ScrollResult> {
    assertAllowedOptionKeys(options, SCROLL_OPTION_KEYS, 'scroll');
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    const body: Record<string, unknown> = {
      limit: options.limit ?? 10,
      with_payload: options.withPayload ?? true,
      with_vector: options.withVectors ?? false,
    };
    if (options.offset !== undefined) body.offset = options.offset;
    if (options.scrollFilter)
      body.filter = serializeFilter(options.scrollFilter, 'scroll');

    try {
      const response = await this.send('scroll', () =>
        this.httpClient.post<{
          result: {
            points: ScrollResult['points'];
            next_page_offset: string | number | null;
          };
        }>(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/points/scroll')
          ),
          body
        )
      );

      const result = response.data.result ?? {
        points: [] as ScrollResult['points'],
        next_page_offset: null,
      };
      return {
        points: result.points ?? [],
        nextPageOffset: result.next_page_offset ?? null,
      };
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  /**
   * Auto-paginating scroll. Yields each point one at a time, fetches the
   * next page transparently, stops when nextPageOffset is null.
   *
   * Why this exists: `scroll()` is single-shot. Without this, callers reach
   * for `scroll({ limit: very_large })` which (a) blows past the server-side
   * 1000-point cap, (b) creates a 10MB+ response that hits the
   * RESPONSE_TOO_LARGE 413 from the backend, and (c) loads everything into
   * memory at once. The iterator gives them a paging helper that's correct
   * by default.
   *
   * `limit` and `offset` are not exposed — they're owned by the iterator.
   * Callers control page size via `batchSize`. An unknown option throws a
   * TypeError, as on every other method here.
   *
   * @param collectionName - Collection to iterate.
   * @param options - Iteration options. `batchSize` defaults to 256
   *   (server cap 1000). Pass `scrollFilter`, `withPayload`, `withVectors`
   *   as for `scroll()`.
   * @returns AsyncGenerator yielding each point in order.
   *
   * @example
   * ```typescript
   * for await (const point of client.scrollIter('my-col', { batchSize: 128 })) {
   *   console.log(point.id);
   * }
   * ```
   */
  scrollIter(
    collectionName: string,
    options: ScrollIterOptions = {}
  ): AsyncGenerator<ScrollPoint, void, undefined> {
    // Checked HERE, at the call, not inside the generator: a generator's body
    // does not run until the first next(), so a guard in it would let
    // `const it = client.scrollIter(c, { limit: 100 })` succeed. Python binds
    // a generator's keyword arguments at the call, too.
    // `{ batchSize: 256, limit: 100 }` would otherwise page at 256 with
    // `limit` dropped.
    assertAllowedOptionKeys(
      options,
      SCROLL_ITER_OPTION_KEYS,
      'scrollIter',
      'Pass batchSize to control page size; limit and offset are owned by the iterator.'
    );
    return this.scrollIterPages(collectionName, options);
  }

  private async *scrollIterPages(
    collectionName: string,
    options: ScrollIterOptions
  ): AsyncGenerator<ScrollPoint, void, undefined> {
    const {
      batchSize = 256,
      scrollFilter,
      withPayload = true,
      withVectors = false,
    } = options;
    if (!(batchSize >= 1 && batchSize <= 1000)) {
      throw new RangeError(
        `batchSize must be 1-1000 (server cap), got ${batchSize}`
      );
    }

    let cursor: string | number | undefined = undefined;
    while (true) {
      const page = await this.scroll(collectionName, {
        limit: batchSize,
        offset: cursor,
        scrollFilter,
        withPayload,
        withVectors,
      });
      for (const point of page.points) {
        yield point;
      }
      if (page.nextPageOffset == null) return;
      cursor = page.nextPageOffset;
    }
  }

  /**
   * Count points in a collection
   *
   * @param collectionName - Name of the collection
   * @param options - Count options
   * @returns Promise that resolves to point count
   */
  async count(
    collectionName: string,
    options: CountOptions = {}
  ): Promise<number> {
    assertAllowedOptionKeys(options, COUNT_OPTION_KEYS, 'count');
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    try {
      const response = await this.send('count', () =>
        this.httpClient.post<{
          result: { count: number };
        }>(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/points/count')
          ),
          {
            filter: serializeFilter(options.countFilter, 'count'),
            exact: options.exact ?? false,
          }
        )
      );

      return response.data.result.count;
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw this.handleError(error);
    }
  }

  // Analytics Methods

  /**
   * Get account usage statistics
   *
   * The only analytics endpoint this SDK exposes. It is implemented here
   * rather than behind an AnalyticsClient sub-client because it is the only
   * one left: `GET /api/v1/analytics/usage` reports measured values (the
   * backend reads Postgres for it), while every other analytics method was
   * deleted for reporting synthesised or unreachable data.
   *
   * The response body is returned untouched, so `UsageStats` carries the
   * endpoint's own snake_case field names — see the type's own note.
   *
   * @returns Promise that resolves to usage stats
   *
   * @example
   * ```typescript
   * const usage = await client.getUsageStats();
   * if (
   *   usage.storage_limit_bytes !== null &&
   *   usage.usage_percentage > 80
   * ) {
   *   console.warn('Approaching storage limit');
   * }
   * ```
   */
  async getUsageStats(): Promise<UsageStats> {
    try {
      const response = await this.send('getUsageStats', () =>
        this.httpClient.get<UsageStats>(this.apiUrl('/analytics/usage'))
      );

      return response.data;
    } catch (error: unknown) {
      throw this.handleError(error);
    }
  }

  // Utility Methods

  /**
   * Test the connection to Aetherfy Vectors
   *
   * @returns Promise that resolves to true if connection is successful
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.getCollections();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up resources (if needed)
   *
   * @returns Promise that resolves when cleanup is complete
   */
  async dispose(): Promise<void> {
    // Cleanup resources if needed in the future
  }

  /**
   * Clear schema cache for a collection or all collections
   *
   * @param collectionName - Name of collection to clear, or undefined to clear all
   */
  clearSchemaCache(collectionName?: string): void {
    if (collectionName) {
      // The caches are keyed by the workspace-scoped name.
      const scopedName = this.scopeCollection(collectionName);
      this.schemaCache.delete(scopedName);
      this.payloadSchemaCache.delete(scopedName);
    } else {
      this.schemaCache.clear();
      this.payloadSchemaCache.clear();
    }
  }

  // Private helper methods

  /**
   * Self-healing: drop both caches for a collection iff the error is HTTP 404.
   *
   * A 404 on a collection-scoped op means the collection is gone upstream
   * (cross-client delete or never existed). Without eviction, the local
   * caches keep lying — collectionExists() returns true forever, and
   * every subsequent op re-pays the 404. Calling this in catch blocks
   * before rethrowing is enough: the next call goes back to the network
   * and gets the truth.
   *
   * Don't call this on schema-read 404s — there, 404 also covers the
   * legitimate "no payload schema set" state on an existing collection.
   */
  private evictCachesIfNotFound(scopedName: string, error: unknown): void {
    // Only when the COLLECTION is gone: an unknown workspace says nothing
    // about it.
    if (this.errorCodeOf(error) === 'COLLECTION_NOT_FOUND') {
      this.schemaCache.delete(scopedName);
      this.payloadSchemaCache.delete(scopedName);
    }
  }

  /**
   * Pull error.code out of an HttpClient-thrown error.
   *
   * The backend uses two response shapes:
   *   - nested:  { error: { code, message } }
   *   - flat:    { error_code, message }
   * HttpClient stashes the parsed body on error.responseData. Both
   * shapes are checked here so SDK code can read the code without
   * caring which one the backend produced for a given path.
   *
   * Used to disambiguate schema-read 404s where the same status
   * covers two cases (collection gone vs. no schema set).
   */
  private errorCodeOf(error: unknown): string | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const data = (error as { responseData?: Record<string, unknown> })
      .responseData;
    if (!data || typeof data !== 'object') return undefined;
    const nested = (data.error as { code?: string } | undefined)?.code;
    if (nested) return nested;
    const flat = data.error_code as string | undefined;
    return flat;
  }

  private getCachedSchema(
    collectionName: string
  ): { size: number; distance: string; etag?: string } | undefined {
    return this.schemaCache.get(collectionName);
  }

  private async fetchAndCacheSchema(
    collectionName: string
  ): Promise<{ size: number; distance: string; etag: string }> {
    // Caller passes the BARE collection name. The wire URL comes from
    // buildCollectionPath; the local schemaCache key is the workspace-scoped
    // name (scopeCollection), so same-name collections in different
    // workspaces never share an entry.
    const scopedName = this.scopeCollection(collectionName);
    const response = await this.send('getSchema', () =>
      this.httpClient.get<{
        result: {
          config: {
            params: {
              vectors: {
                size: number;
                distance: string;
              };
            };
          };
        };
        schema_version: string;
      }>(this.apiUrl(this.buildCollectionPath(collectionName)))
    );

    const result = response.data.result;
    const schemaVersion = response.data.schema_version;
    const vectorConfig = result?.config?.params?.vectors;

    if (!vectorConfig || !vectorConfig.size) {
      throw new ValidationError(
        'Invalid collection schema received from server'
      );
    }

    const schema = {
      size: vectorConfig.size,
      distance: vectorConfig.distance,
      etag: schemaVersion,
    };

    this.schemaCache.set(scopedName, schema);
    return schema;
  }

  private validateCollectionName(name: string): void {
    if (!name || typeof name !== 'string') {
      throw new ValidationError('Collection name must be a non-empty string');
    }

    if (name.length < 1 || name.length > 255) {
      throw new ValidationError(
        'Collection name must be between 1 and 255 characters'
      );
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ValidationError(
        'Collection name can only contain letters, numbers, underscores, and hyphens'
      );
    }
  }

  private validateVector(vector: number[]): void {
    if (!Array.isArray(vector)) {
      throw new ValidationError('Vector must be an array of numbers');
    }

    if (vector.length === 0) {
      throw new ValidationError('Vector cannot be empty');
    }

    if (!vector.every(val => typeof val === 'number' && !isNaN(val))) {
      throw new ValidationError('Vector must contain only valid numbers');
    }
  }

  private validateBatchSize(points: unknown[]): void {
    if (!Array.isArray(points)) {
      throw new ValidationError('Points must be an array');
    }

    if (points.length === 0) {
      throw new ValidationError('Points array cannot be empty');
    }

    // No client-side count cap. The backend (streamingPointsParser
    // DEFAULT_MAX_POINTS, proxy validator) is the authority — duplicating
    // the cap here just creates two-place truth that drifts. Matches the
    // Python SDK's posture (aetherfy_vectors/client.py#upsert).
  }

  private normalizeVectorConfig(
    config: VectorConfig | VectorConfigInput
  ): VectorConfig {
    if (!config || typeof config !== 'object') {
      throw new ValidationError('Vector configuration must be an object');
    }

    const { size, distance } = config;

    if (!size || typeof size !== 'number' || size <= 0) {
      throw new ValidationError('Vector size must be a positive number');
    }

    if (!distance) {
      throw new ValidationError('Distance metric must be specified');
    }

    // If already a DistanceMetric enum, return as-is
    if (Object.values(DistanceMetric).includes(distance as DistanceMetric)) {
      return { size, distance: distance as DistanceMetric };
    }

    // If it's a string, normalize it
    if (typeof distance === 'string') {
      const distanceMap: Record<string, DistanceMetric> = {
        cosine: DistanceMetric.COSINE,
        euclidean: DistanceMetric.EUCLIDEAN,
        euclid: DistanceMetric.EUCLIDEAN,
        dot: DistanceMetric.DOT,
        manhattan: DistanceMetric.MANHATTAN,
      };

      const normalizedDistance = distanceMap[distance.toLowerCase()];
      if (normalizedDistance) {
        return { size, distance: normalizedDistance };
      }

      throw new ValidationError(
        `Invalid distance metric: ${distance}. Must be one of: ${Object.values(
          DistanceMetric
        ).join(', ')}`
      );
    }

    throw new ValidationError(
      'Distance metric must be a DistanceMetric enum or valid string'
    );
  }

  private formatPointsForUpsert(
    points: (Point | Record<string, unknown>)[]
  ): Point[] {
    return points.map(point => {
      if (
        !point ||
        typeof point !== 'object' ||
        !('id' in point) ||
        point.id === null ||
        point.id === undefined
      ) {
        throw new ValidationError('Each point must have an id');
      }

      validatePointId(point.id as string | number);
      this.validateVector(point.vector as number[]);

      return {
        id: point.id as string | number,
        vector: point.vector as number[],
        payload: (point.payload as Record<string, unknown>) || {},
      };
    });
  }

  private handleError(error: unknown): AetherfyVectorsError {
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      'responseData' in error
    ) {
      const httpError = error as {
        status: number;
        responseData: Record<string, unknown>;
        statusText: string;
        requestId?: string;
      };
      return createErrorFromResponse(
        httpError.responseData,
        httpError.status,
        httpError.statusText,
        httpError.requestId
      );
    }

    // Check if it's a network error (timeout, connection errors, etc.)
    if (error instanceof Error) {
      const message = error.message;
      if (message.includes('Network error')) {
        return new NetworkError(message);
      }
    }

    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    return new AetherfyVectorsError(message);
  }

  /**
   * Send one request under the retry rule (retry-policy.ts): a refusal
   * before anything ran is retried for any operation, an ambiguous failure
   * only for an operation whose repeat gives the same result, a 4xx never.
   * The raw HttpClient error reaches the caller (the 412 path reads its
   * `status`). With a `deadline` (on `this.now()`), no retry starts once it
   * has passed, as the Python SDK's call deadline.
   */
  private async send<T>(
    operation: Operation,
    request: () => Promise<T>,
    deadline?: number
  ): Promise<T> {
    return retryWithBackoff(request, {
      retryClass: OPERATIONS[operation],
      maxRetries: 3,
      baseDelay: AetherfyVectorsClient.retryBaseDelayMs,
      deadline,
      now: () => this.now(),
    });
  }

  // ==================== Schema Management Methods ====================

  /**
   * Get schema for a collection
   *
   * @param collectionName - Name of the collection
   * @returns Schema definition if exists, null otherwise
   *
   * @example
   * ```typescript
   * const schema = await client.getSchema('products');
   * if (schema) {
   *   console.log('Schema fields:', schema.fields);
   * }
   * ```
   */
  async getSchema(collectionName: string): Promise<Schema | null> {
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    try {
      const response = await this.send('getSchema', () =>
        this.httpClient.get(
          this.apiUrl(this.buildCollectionPath(collectionName, '/schema'))
        )
      );

      const data = response.data as {
        schema: Schema;
        enforcement_mode: EnforcementMode;
        etag: string;
        description?: string | null;
      };

      // Attach description to the schema object
      const schema: Schema = {
        ...data.schema,
        description: data.description ?? null,
      };

      // Cache it
      this.payloadSchemaCache.set(scopedName, {
        schema,
        enforcementMode: data.enforcement_mode,
        etag: data.etag,
        description: data.description ?? null,
      });

      return schema;
    } catch (error: unknown) {
      // Two 404s mean "no schema", told apart by error.code:
      //   COLLECTION_NOT_FOUND → the collection is gone: evict caches
      //   SCHEMA_NOT_DEFINED → the collection has no schema (legit)
      // Any other 404 (an unknown workspace) is thrown.
      const code = this.errorCodeOf(error);
      if (code === 'COLLECTION_NOT_FOUND') {
        this.schemaCache.delete(scopedName);
        this.payloadSchemaCache.delete(scopedName);
        return null;
      }
      if (code === 'SCHEMA_NOT_DEFINED') {
        return null;
      }
      throw this.handleError(error);
    }
  }

  /**
   * Set or update schema for a collection
   *
   * @param collectionName - Name of the collection
   * @param schema - Schema definition
   * @param enforcementMode - Enforcement mode: 'off', 'warn', or 'strict'
   * @returns ETag of the new schema
   *
   * @example
   * ```typescript
   * const etag = await client.setSchema('products', {
   *   fields: {
   *     price: { type: 'integer', required: true },
   *     name: { type: 'string', required: true }
   *   }
   * }, 'strict');
   * ```
   */
  async setSchema(
    collectionName: string,
    schema: Schema,
    enforcementMode: EnforcementMode = 'off',
    description?: string | null
  ): Promise<string> {
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    const body: Record<string, unknown> = {
      schema,
      enforcement_mode: enforcementMode,
    };
    if (description !== undefined) {
      body.description = description;
    }

    let response;
    try {
      response = await this.send('setSchema', () =>
        this.httpClient.put(
          this.apiUrl(this.buildCollectionPath(collectionName, '/schema')),
          body
        )
      );
    } catch (error: unknown) {
      // A schema PUT on a non-existent collection 404s
      // unambiguously (the schema endpoint requires the collection),
      // so a 404 here means the collection is gone — self-heal.
      this.evictCachesIfNotFound(scopedName, error);
      throw error;
    }

    const data = response.data as { etag: string };

    // Update cache
    this.payloadSchemaCache.set(scopedName, {
      schema,
      enforcementMode,
      etag: data.etag,
      description: description ?? null,
    });

    return data.etag;
  }

  /**
   * Delete schema from a collection
   *
   * @param collectionName - Name of the collection
   * @returns Promise that resolves to true if deletion was successful
   * @throws {SchemaNotFoundError} If no schema is defined for the collection
   *
   * @example
   * ```typescript
   * await client.deleteSchema('products');
   * ```
   */
  async deleteSchema(collectionName: string): Promise<boolean> {
    this.validateCollectionName(collectionName);

    const scopedName = this.scopeCollection(collectionName);

    try {
      await this.send('deleteSchema', () =>
        this.httpClient.delete(
          this.apiUrl(this.buildCollectionPath(collectionName, '/schema'))
        )
      );
    } catch (error: unknown) {
      // Disambiguate via the backend's error.code:
      //   COLLECTION_NOT_FOUND → collection is gone, evict caches.
      //   SCHEMA_NOT_DEFINED → collection exists, no schema set.
      // Both surface as SchemaNotFoundError to the caller — the
      // difference is whether we self-heal the local caches. Any other
      // 404 (an unknown workspace) is thrown as it is.
      const code = this.errorCodeOf(error);
      if (code === 'COLLECTION_NOT_FOUND') {
        this.schemaCache.delete(scopedName);
        this.payloadSchemaCache.delete(scopedName);
        throw new SchemaNotFoundError(collectionName);
      }
      if (code === 'SCHEMA_NOT_DEFINED') {
        throw new SchemaNotFoundError(collectionName);
      }
      throw this.handleError(error);
    }

    // Clear cache
    this.payloadSchemaCache.delete(scopedName);

    return true;
  }

  /**
   * Analyze collection data to understand payload structure
   *
   * @param collectionName - Name of the collection
   * @param sampleSize - Number of points to sample (default: 1000)
   * @returns Analysis result with field statistics and suggested schema
   *
   * @example
   * ```typescript
   * const analysis = await client.analyzeSchema('products', 1000);
   * console.log('Suggested schema:', analysis.suggestedSchema);
   * console.log('Field analysis:', analysis.fields);
   * ```
   */
  async analyzeSchema(
    collectionName: string,
    sampleSize: number = 1000
  ): Promise<AnalysisResult> {
    this.validateCollectionName(collectionName);

    if (sampleSize < 100 || sampleSize > 10000) {
      throw new ValidationError('sampleSize must be between 100 and 10000');
    }

    const scopedName = this.scopeCollection(collectionName);

    let response;
    try {
      response = await this.send('analyzeSchema', () =>
        this.httpClient.post(
          this.apiUrl(
            this.buildCollectionPath(collectionName, '/schema/analyze')
          ),
          { sample_size: sampleSize }
        )
      );
    } catch (error: unknown) {
      this.evictCachesIfNotFound(scopedName, error);
      throw error;
    }

    const data = response.data as {
      collection: string;
      sample_size: number;
      total_points: number;
      fields: Record<string, FieldAnalysis>;
      suggested_schema: Schema;
      processing_time_ms: number;
    };

    return {
      collection: collectionName, // Return user-facing name, not scoped
      sampleSize: data.sample_size,
      totalPoints: data.total_points,
      fields: data.fields,
      suggestedSchema: data.suggested_schema,
      processingTimeMs: data.processing_time_ms,
    };
  }

  /**
   * Force refresh of cached schema for a collection
   *
   * @param collectionName - Name of the collection
   *
   * @example
   * ```typescript
   * await client.refreshSchema('products');
   * ```
   */
  async refreshSchema(collectionName: string): Promise<void> {
    const scopedName = this.scopeCollection(collectionName);
    this.payloadSchemaCache.delete(scopedName);
    await this.getSchema(collectionName); // getSchema will handle scoping internally
  }

  /**
   * Get cached schema data or fetch if not present
   *
   * @private
   * @param collectionName - Name of the collection
   * @returns Schema data or null
   */
  private async getCachedPayloadSchema(
    scopedCollectionName: string
  ): Promise<SchemaData | null> {
    // Check cache first (cache uses scoped names)
    if (this.payloadSchemaCache.has(scopedCollectionName)) {
      const cached = this.payloadSchemaCache.get(scopedCollectionName);
      return cached !== undefined ? cached : null;
    }

    // Try to fetch from server
    // Note: We need to call getSchema with unscoped name since getSchema will scope it
    const unscopedName = this.unscopeCollection(scopedCollectionName);
    try {
      const schema = await this.getSchema(unscopedName);
      if (schema === null) {
        this.payloadSchemaCache.set(scopedCollectionName, null);
        return null;
      }
      // getSchema already cached the SchemaData, so retrieve it from cache
      const cached = this.payloadSchemaCache.get(scopedCollectionName);
      return cached !== undefined ? cached : null;
    } catch {
      // On error, cache null to avoid retrying
      this.payloadSchemaCache.set(scopedCollectionName, null);
      return null;
    }
  }

  /**
   * Destroy the HTTP client and close all connections
   * Call this when you're done with the client to prevent hanging processes
   *
   * @example
   * ```typescript
   * const client = new AetherfyVectorsClient({ apiKey: 'afy_xxx' });
   * // ... use client ...
   * client.destroy(); // Clean up when done
   * ```
   */
  destroy(): void {
    this.httpClient.destroy();
  }
}

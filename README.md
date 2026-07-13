# Aetherfy Vectors JavaScript SDK

[![npm version](https://img.shields.io/npm/v/aetherfy-vectors.svg)](https://www.npmjs.com/package/aetherfy-vectors)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)

Global vector database with automatic replication and sub-50ms latency worldwide.

## 🌟 Features

- **🌍 Global Performance** - Automatic replication across 12+ global regions
- **⚡ Intelligent Caching** - 94%+ cache hit rate with sub-50ms response times
- **🛡️ Zero DevOps** - Fully managed infrastructure, no setup required
- **📊 Built-in Analytics** - Real-time performance metrics and insights
- **🔧 Auto-Failover** - Seamless failover and disaster recovery
- **🔒 Enterprise Security** - End-to-end encryption and compliance ready
- **🚀 Developer Friendly** - TypeScript-first with comprehensive documentation

## 🚀 Installation

Requires Node.js **>= 20**. Ships CommonJS, ESM, and UMD browser builds with first-class TypeScript types.

```bash
npm install aetherfy-vectors
# or
yarn add aetherfy-vectors
# or
pnpm add aetherfy-vectors
```

## 📖 Quick Start

```typescript
import { AetherfyVectorsClient, DistanceMetric } from 'aetherfy-vectors';

// Initialize client
const client = new AetherfyVectorsClient({
  apiKey: 'afy_live_your_api_key_here' // or use environment variable
});

// Create a collection
await client.createCollection('products', {
  size: 384,              // Vector dimensions
  distance: DistanceMetric.COSINE
});

// Add vectors — point ids are unsigned integers (≤ 2^53 − 1) or UUID strings
const points = [
  {
    id: 1,
    vector: [0.1, 0.2, ...], // 384-dimensional vector
    payload: {
      name: 'Wireless Headphones',
      category: 'electronics',
      price: 299.99
    }
  }
];
await client.upsert('products', points);

// Search for similar items
const results = await client.search('products', queryVector, {
  limit: 10,
  withPayload: true,
  scoreThreshold: 0.7
});

console.log('Similar products:', results);
```

## 🔑 Authentication

The SDK supports multiple ways to provide your API key:

### 1. Constructor Parameter (Recommended)

```typescript
const client = new AetherfyVectorsClient({
  apiKey: 'afy_live_your_api_key_here',
});
```

### 2. Environment Variables (Node.js only)

```bash
# Option 1
export AETHERFY_API_KEY=afy_live_your_api_key_here

# Option 2
export AETHERFY_VECTORS_API_KEY=afy_live_your_api_key_here
```

```typescript
// No API key needed in constructor
const client = new AetherfyVectorsClient();
```

### 3. Custom Endpoint

```typescript
const client = new AetherfyVectorsClient({
  apiKey: 'your_api_key',
  endpoint: 'https://custom.vectors.endpoint.com',
  timeout: 45000, // Custom timeout in milliseconds
});
```

### 4. Local development across regions

`apiRegion` pins which **regional API endpoint** the client connects to —
a transport/routing override, NOT where collections live (for collection
placement see `createCollection(..., regions)`). Production agents have
`AETHERFY_VECTORS_URL` injected by the control-plane — that's the URL they
reach the regional backend through, and it takes precedence over
`apiRegion`. For local development (no env var injected), you can pin a
client to a specific API region — but `apiRegion` requires the async
factory rather than `new`, because the SDK has to call
`GET /api/v1/regions` to resolve the per-region URL:

```typescript
const client = await AetherfyVectorsClient.create({
  apiKey: 'afy_test_...',
  apiRegion: 'eu-central-1', // 'us-east-1' | 'eu-central-1' | 'ap-southeast-1'
});
```

`create()` mirrors Python's `AetherfyVectorsClient(api_key=..., region='eu-central-1')`
contract: when the call resolves, the client is fully ready — endpoint,
analytics, and `.apiRegion` are all final. Discovery errors surface at the
`create()` call site instead of being deferred to your first method call.

If you call `new AetherfyVectorsClient({apiRegion: 'eu-central-1'})` without an
override (`endpoint=` or `AETHERFY_VECTORS_URL`), the constructor
throws telling you to use `create()` — async discovery isn't safe
inside a sync constructor and silent deferral is a footgun.

If both `AETHERFY_VECTORS_URL` and `apiRegion` are set, the env var wins
and a warning is logged — production-agent protection rule.

## 🔁 Iterating Large Collections

For bulk reads, use `scrollIter()` rather than `scroll({ limit: … })`.
The async iterator pages transparently and stays within the server's
per-request caps (1000 points/call, 10 MB/response):

```typescript
import type { ScrollIterOptions, ScrollPoint } from 'aetherfy-vectors';

for await (const point of client.scrollIter('my_collection', {
  batchSize: 256,
})) {
  process(point);
}

// With a filter and selective payload/vector return
const opts: ScrollIterOptions = {
  batchSize: 512,
  scrollFilter: { must: [{ key: 'status', match: { value: 'active' } }] },
  withPayload: true,
  withVectors: false,
};
for await (const point of client.scrollIter('my_collection', opts)) {
  process(point);
}
```

`batchSize` is the page size for one HTTP round trip (max 1000
server-side). The iterator handles cursor management, page exhaustion,
and pagination errors — no offset bookkeeping in user code.

> **TypeScript callers** get compile-time errors on unknown options
> keys (e.g. passing `limit` instead of `batchSize`). Untyped JS callers
> hit a runtime kwarg-allowlist guard that throws with a guidance
> message — passing `{ batchSize: 256, limit: 100 }` would otherwise
> silently page at 256 with `limit` dropped.

## ✏️ Editing Payload on Existing Points

Three operations on the payload of points that already exist — no need
to re-upsert vectors:

```typescript
// MERGE: add or update keys, leave others alone
await client.setPayload(
  'my_collection',
  { reviewed: true, reviewer: 'alice' },
  [pointId]
);

// OVERWRITE: replace the entire payload object
await client.overwritePayload('my_collection', { category: 'X' }, [pointId]);

// DELETE: remove specific keys, leave others alone
await client.deletePayload(
  'my_collection',
  ['draft_field', 'stale_score'],
  [pointId]
);
```

Each call accepts up to **512 points** in one round trip; for larger
mutations, batch on the caller side. Semantics map exactly to qdrant's
`set_payload` / `overwrite_payload` / `delete_payload`.

## 🧠 Memory SDK — Iter, Bulk-load, setMetadata

The Memory layer (`MemoryClient`) layers `Namespace` and `Thread`
abstractions on top of `AetherfyVectorsClient`. Three additions worth
knowing once you go past `add()` / `search()`:

### Iterating a namespace or a thread

```typescript
import { MemoryClient } from 'aetherfy-vectors';
import type { NamespaceIterOptions } from 'aetherfy-vectors';

const memory = new MemoryClient({ apiKey: 'afy_live_…', workspace: 'my-bot' });
const ns = await memory.namespace('customer-42');

for await (const point of ns.iter({ batchSize: 256 })) {
  process(point);
}

// Threads have iterHistory() — yields messages in ts order across the
// whole conversation. Distinct from history({ limit: N }), which caps
// at 5000 in memory for the most-recent slice.
const thread = await memory.thread('conv-99');
for await (const msg of thread.iterHistory({ order: 'asc' })) {
  console.log(msg.role, msg.content);
}
```

Use `history({ limit: N })` for "show me the last N messages" (bounded,
fast). Use `iterHistory()` for "walk every message in this thread"
(paged, memory-bounded by the iterator).

### Bulk-loading memories

`addMany()` and `appendMany()` batch into a single `client.upsert` so
N items become 1 round trip. IDs are returned in input order; missing
IDs are auto-generated as canonical UUIDs (the same format `iter()` and
`retrieve()` yield back, so equality comparisons just work).

```typescript
const items = [
  { text: 'first', vector: embed('first'), metadata: { src: 'a' } },
  { text: 'second', vector: embed('second'), metadata: { src: 'b' } },
];
const ids = await ns.addMany(items); // single round trip; preserves input order

// Threads use appendMany — role/content/ts payloads, ts auto-set per
// message when omitted (each message gets its own ts, not one shared).
const msgs = [
  { role: 'user', content: 'hi', vector: embed('hi') },
  { role: 'assistant', content: 'hello', vector: embed('hello') },
];
const msgIds = await thread.appendMany(msgs);
```

`Thread.addMany()` is overridden to throw with guidance toward
`appendMany()` — `addMany` would write `text`/`metadata` payloads into
a `role`/`content`/`ts` schema, which is almost always a mistake. Reach
for `appendMany()` on threads.

### setMetadata — atomic replace, explicit-compose merge

`setMetadata()` replaces the entire metadata sub-key.
`setMetadata({ tag: 'x' })` nukes every other key. Use `mergeMetadata`
if you want additive updates that preserve existing keys. Reserved
fields (`text` for Namespace; `role`/`content`/`ts` for Thread) are
untouched either way.

```typescript
await ns.setMetadata(pointId, { reviewed: true, score: 0.92 });
```

To merge into existing metadata via the explicit-compose pattern (race
visible at the call site, no atomicity guarantee):

```typescript
const [point] = await ns.retrieve([pointId]);
const current = (point?.payload?.metadata ?? {}) as Record<string, unknown>;
await ns.setMetadata(pointId, { ...current, reviewed: true });
```

If two callers run this concurrently, one update wins and the other
sees its read be stale — by design, you see that race in your own code
rather than have the SDK hide it.

### mergeMetadata — atomic per-point partial merge

`mergeMetadata({ tag: 'x' })` adds/updates the listed keys and leaves
every other key untouched. Concurrent patches to different keys all
land atomically; concurrent writes to the same key resolve via
last-writer-wins per the storage operation order. Throws
`PointNotFoundError` if the point doesn't exist. Reserved keys (`text`
on Namespace; `role`, `content`, `ts` on Thread) cannot appear in the
partial — throws a local `TypeError` before the request is sent.

```typescript
await ns.mergeMetadata(pointId, { reviewed: true });
await ns.mergeMetadata(pointId, { score: 0.92 });
// final metadata: original keys + reviewed + score
```

### deleteMetadataKeys — atomic key removal

`deleteMetadataKeys(pointId, ['tag', 'score'])` removes the listed keys
from metadata; keys not in the list are left untouched. Throws
`PointNotFoundError` if the point doesn't exist. Reserved keys cannot
appear in the keys list (same set as `mergeMetadata`).

```typescript
await ns.deleteMetadataKeys(pointId, ['draft', 'staleScore']);
```

## 📐 Limits

Two axes constrain a single call: per-request size (PRS) and requests
per minute (RPM). Both axes return a 4xx with a structured `error.code`
when they fire — no surprise 5xx, no silent truncation.

| Class  | Endpoint                         | Cap                                   |
| ------ | -------------------------------- | ------------------------------------- |
| READS  | `scroll` · `search` · `retrieve` | ≤ 1000 points/call · ≤ 10 MB/response |
| WRITES | `upsert`                         | ≤ 10 K vectors/call · streaming       |
|        | payload edits · batch delete     | ≤ 512 points/call                     |

> **Upserts stream** — there is no body-size cap on the public upsert
> URL. The 10 K vectors/call is a defensive request-level ceiling, not
> a body limit; one call can upload millions of bytes via byte-target
> chunking on the receiving end. For bulk reads, use `scrollIter()` —
> it pages transparently and stays within both quotas.

`requests_per_minute` is a sliding-window minutely cap derived from
your subscription tier. When it fires, the SDK throws
`RateLimitExceededError` with a structured `retryAfter` (seconds);
PRS violations throw `ValidationError` (400) or surface as 413
`RESPONSE_TOO_LARGE` for oversized response bodies.

## 🤝 Multi-Agent Workspaces

Workspaces let multiple agents share vector collections without name collisions. All collections created through a workspace-scoped client are automatically namespaced — agents in the same workspace see each other's collections; agents in different workspaces are fully isolated.

### Creating a workspace-scoped client

```typescript
const client = new AetherfyVectorsClient({
  apiKey: 'afy_live_your_api_key_here',
  workspace: 'invoice-pipeline', // All operations are scoped to this workspace
});
```

### How scoping works

Collection names are automatically prefixed — you always use the short name:

```typescript
// Create a collection (stored as "invoice-pipeline/documents" internally)
await client.createCollection('documents', {
  size: 768,
  distance: DistanceMetric.COSINE,
});

// Search — no need to know the full scoped name
const results = await client.search('documents', queryVector, { limit: 10 });

// List — only returns collections in your workspace
const collections = await client.getCollections();
// → [{ name: 'documents', ... }]  (short names, not scoped names)
```

### Multi-agent example

```typescript
// Agent A: extractor
const extractor = new AetherfyVectorsClient({
  apiKey: process.env.AETHERFY_API_KEY,
  workspace: 'invoice-pipeline',
});
await extractor.createCollection('raw-invoices', {
  size: 768,
  distance: DistanceMetric.COSINE,
});
await extractor.upsert('raw-invoices', extractedPoints);

// Agent B: classifier — same workspace, sees Agent A's collection
const classifier = new AetherfyVectorsClient({
  apiKey: process.env.AETHERFY_API_KEY,
  workspace: 'invoice-pipeline',
});
const results = await classifier.search('raw-invoices', queryVector, {
  limit: 20,
});
```

### Workspace without scoping (backward-compatible)

```typescript
// No workspace — collections are stored as-is, not scoped
const client = new AetherfyVectorsClient({ apiKey: 'afy_live_your_key' });
await client.createCollection('my-global-collection', {
  size: 768,
  distance: DistanceMetric.COSINE,
});
```

> **Tip:** Workspaces are created explicitly in the Aetherfy control plane before use (`afy workspaces create invoice-pipeline`). Agents deployed to a workspace automatically receive their workspace name via the `AETHERFY_WORKSPACE` environment variable. Pass `workspace: 'auto'` to opt into auto-detection.

## 🧩 Payload Schemas

Collections can carry an optional payload schema that the SDK validates against **before** upsert — catching malformed payloads client-side without a round trip. Schemas are cached and automatically revalidated when they change server-side (via ETag).

```typescript
import { Schema, EnforcementMode } from 'aetherfy-vectors';

const schema: Schema = {
  fields: {
    title: { type: 'string', required: true },
    price: { type: 'float', required: true },
    tags: { type: 'array', required: false, elementType: 'string' },
    inStock: { type: 'boolean', required: false },
  },
  description: 'Product catalog payloads',
};

// enforcement: 'off' (no validation), 'warn' (log warnings), 'strict' (throw on violation)
const etag = await client.setSchema('products', schema, 'strict');

const current = await client.getSchema('products'); // null if no schema is defined
await client.deleteSchema('products');
```

### Infer a schema from existing data

```typescript
const analysis = await client.analyzeSchema('products', 1000); // sampleSize: 100–10000
await client.setSchema('products', analysis.suggestedSchema, 'warn');
```

Schema violations throw `SchemaValidationError` with a detailed per-field errors array. If the server reports a stale schema (`412 Precondition Failed`), the SDK auto-refreshes the cache and retries. Use `refreshSchema(name)` or `clearSchemaCache(name?)` for manual control.

## 🔧 Core Operations

### Collection Management

```typescript
// Create collection with vector configuration.
// Returns the created Collection (not a boolean). `.regions` reflects the
// resolved placement: the full scope when `regions` is omitted, or the
// explicit subset you passed.
const collection = await client.createCollection('my-collection', {
  size: 768,
  distance: DistanceMetric.EUCLIDEAN,
});
console.log(collection.name, collection.regions);

// Pin a collection to a subset of your scope (placement, NOT the
// connection apiRegion). An empty array is rejected by the server.
await client.createCollection(
  'eu-only',
  { size: 768, distance: DistanceMetric.COSINE },
  'EU-resident collection',
  ['eu-central-1']
);

// List all collections
const collections = await client.getCollections();

// Check if collection exists
const exists = await client.collectionExists('my-collection');

// Get collection info
const info = await client.getCollection('my-collection');

// Delete collection
await client.deleteCollection('my-collection');
```

### Vector Operations

```typescript
// Insert or update vectors. A point id is an unsigned integer (≤ 2^53 − 1)
// or a UUID string — anything else is rejected client-side with the same
// error the server would return (400 INVALID_POINT_ID).
await client.upsert('collection-name', [
  {
    id: '550e8400-e29b-41d4-a716-446655440001',
    vector: [0.1, 0.2, 0.3, ...],
    payload: { category: 'A', metadata: {...} }
  },
  {
    id: '550e8400-e29b-41d4-a716-446655440002',
    vector: [0.4, 0.5, 0.6, ...],
    payload: { category: 'B', metadata: {...} }
  }
]);

// Retrieve vectors by ID
const vectors = await client.retrieve(
  'collection-name',
  [
    '550e8400-e29b-41d4-a716-446655440001',
    '550e8400-e29b-41d4-a716-446655440002',
  ],
  {
    withPayload: true,
    withVectors: false
  }
);

// Delete vectors
await client.delete('collection-name', [
  '550e8400-e29b-41d4-a716-446655440001',
  '550e8400-e29b-41d4-a716-446655440002',
]);

// Delete by filter
await client.delete('collection-name', {
  must: [{ key: 'category', match: { value: 'A' } }]
});

// Count vectors
const count = await client.count('collection-name');
const filteredCount = await client.count('collection-name', {
  countFilter: { must: [{ key: 'category', match: { value: 'A' } }] }
});
```

### Search Operations

```typescript
// Basic similarity search
const results = await client.search('collection-name', queryVector, {
  limit: 10,
  withPayload: true,
  withVectors: false,
});

// Advanced search with filtering
const filteredResults = await client.search('collection-name', queryVector, {
  limit: 20,
  offset: 10,
  scoreThreshold: 0.8,
  withPayload: true,
  queryFilter: {
    must: [
      { key: 'category', match: { value: 'electronics' } },
      { key: 'price', range: { gte: 100, lte: 500 } },
    ],
  },
});
```

## 📊 Analytics & Monitoring

```typescript
// Get performance analytics
const analytics = await client.getPerformanceAnalytics('24h');
console.log(`Cache hit rate: ${analytics.cacheHitRate}%`);
console.log(`Average latency: ${analytics.avgLatencyMs}ms`);
console.log(`Active regions: ${analytics.activeRegions.join(', ')}`);

// Get collection-specific analytics
const collectionStats = await client.getCollectionAnalytics('products', '7d');
console.log(`Search requests: ${collectionStats.searchRequests}`);
console.log(`Average search latency: ${collectionStats.avgSearchLatencyMs}ms`);

// Monitor usage and limits
const usage = await client.getUsageStats();
console.log(`Collections: ${usage.currentCollections}/${usage.maxCollections}`);
console.log(`Points: ${usage.currentPoints}/${usage.maxPoints}`);
console.log(`Plan: ${usage.planName}`);

// Usage warning example
if (usage.currentPoints > usage.maxPoints * 0.8) {
  console.warn('⚠️ Approaching point limit');
}
```

## 🌐 Browser Usage

The SDK works in browsers with important security considerations:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>Vector Search Demo</title>
  </head>
  <body>
    <script type="module">
      import { AetherfyVectorsClient } from 'https://unpkg.com/aetherfy-vectors@1.0.0/dist/browser.js';

      // ⚠️ Only use test keys in browser - never production keys!
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_demo_key_only', // Test key only!
      });

      // The SDK will show security warnings in browser console

      async function searchProducts(query) {
        try {
          const results = await client.search('products', query, {
            limit: 5,
            withPayload: true,
          });
          displayResults(results);
        } catch (error) {
          handleError(error);
        }
      }
    </script>
  </body>
</html>
```

### 🔒 Browser Security Guidelines

- **Never expose production API keys** in browser code
- **Use test keys only** for demos and development
- **Configure CORS** on your server for browser requests
- **Use backend proxy** for production applications
- **Consider serverless functions** for secure API access

## 🔧 Advanced Usage

### Error Handling

```typescript
import {
  AetherfyVectorsClient,
  AetherfyVectorsError, // base class — catch this for a generic fallback
  AuthenticationError,
  RateLimitExceededError,
  ValidationError,
  CollectionNotFoundError,
  PointNotFoundError,
  ServiceUnavailableError,
  RequestTimeoutError,
  NetworkError,
  ConflictError,
  CollectionInUseError,
  QuotaExceededError,
  SchemaNotFoundError,
  SchemaValidationError,
  isAetherfyVectorsError,
  isRetryableError,
} from 'aetherfy-vectors';

try {
  await client.search('collection', vector);
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Invalid API key');
  } else if (error instanceof RateLimitExceededError) {
    console.error(`Rate limited. Retry after: ${error.retryAfter}s`);
  } else if (error instanceof ValidationError) {
    console.error('Invalid request:', error.message);
  } else if (error instanceof CollectionNotFoundError) {
    console.error(`Collection ${error.collectionName} not found`);
  } else if (error instanceof SchemaValidationError) {
    console.error('Schema violations:', error.details);
  } else if (error instanceof QuotaExceededError) {
    console.error(
      `Quota '${error.quotaType}' exceeded: ${error.current}/${error.limit}`
    );
  } else if (isAetherfyVectorsError(error) && isRetryableError(error)) {
    // Retry with backoff…
  }
}
```

### Batch Operations

```typescript
// Process large datasets in batches
import { batchArray } from 'aetherfy-vectors';

const largeDataset = [...]; // Your large array of points
const batches = batchArray(largeDataset, 100); // Process 100 at a time

for (const batch of batches) {
  await client.upsert('collection', batch);
  console.log(`Processed batch of ${batch.length} points`);
}
```

### Retry Logic

```typescript
import { retryWithBackoff } from 'aetherfy-vectors';

const results = await retryWithBackoff(
  () => client.search('collection', vector),
  {
    maxRetries: 3,
    baseDelay: 1000,
    backoffFactor: 2,
    retryCondition: error => error.name === 'ServiceUnavailableError',
  }
);
```

### Environment Detection

```typescript
import { isBrowser, isNode } from 'aetherfy-vectors';

if (isBrowser()) {
  console.log('Running in browser - use test keys only');
} else if (isNode()) {
  console.log('Running in Node.js - can use environment variables');
}
```

### Resource Cleanup

Long-lived processes (e.g. CLIs, tests) should close the underlying HTTP pool so Node can exit cleanly:

```typescript
client.destroy();
```

## 📚 API Reference

### AetherfyVectorsClient

| Method                                                   | Description                                                                        | Returns                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------- |
| `createCollection(name, config, description?, regions?)` | Create a new collection (returns the created Collection, incl. resolved `regions`) | `Promise<Collection>`            |
| `deleteCollection(name)`                                 | Delete a collection                                                                | `Promise<boolean>`               |
| `getCollections()`                                       | List all collections                                                               | `Promise<Collection[]>`          |
| `collectionExists(name)`                                 | Check if collection exists                                                         | `Promise<boolean>`               |
| `getCollection(name)`                                    | Get collection info                                                                | `Promise<Collection>`            |
| `upsert(collection, points)`                             | Insert/update vectors                                                              | `Promise<boolean>`               |
| `delete(collection, selector)`                           | Delete vectors                                                                     | `Promise<boolean>`               |
| `retrieve(collection, ids, options)`                     | Get vectors by ID                                                                  | `Promise<Record<string, any>[]>` |
| `search(collection, vector, options)`                    | Similarity search                                                                  | `Promise<SearchResult[]>`        |
| `count(collection, options)`                             | Count vectors                                                                      | `Promise<number>`                |
| `getSchema(collection)`                                  | Get payload schema                                                                 | `Promise<Schema \| null>`        |
| `setSchema(collection, schema, mode?, desc?)`            | Define/update schema                                                               | `Promise<string>` (ETag)         |
| `deleteSchema(collection)`                               | Remove schema                                                                      | `Promise<boolean>`               |
| `analyzeSchema(collection, sampleSize?)`                 | Infer schema from data                                                             | `Promise<AnalysisResult>`        |
| `refreshSchema(collection)`                              | Force schema cache refresh                                                         | `Promise<void>`                  |
| `clearSchemaCache(collection?)`                          | Clear schema cache                                                                 | `void`                           |
| `getPerformanceAnalytics(timeRange, region)`             | Performance metrics                                                                | `Promise<PerformanceAnalytics>`  |
| `getCollectionAnalytics(collection, timeRange)`          | Collection metrics                                                                 | `Promise<CollectionAnalytics>`   |
| `getUsageStats()`                                        | Account usage                                                                      | `Promise<UsageStats>`            |
| `testConnection()`                                       | Test API connection                                                                | `Promise<boolean>`               |
| `destroy()`                                              | Close HTTP connections                                                             | `void`                           |

### Distance Metrics

```typescript
import { DistanceMetric } from 'aetherfy-vectors';

DistanceMetric.COSINE; // Cosine similarity (recommended for most use cases)
DistanceMetric.EUCLIDEAN; // Euclidean distance
DistanceMetric.DOT; // Dot product
DistanceMetric.MANHATTAN; // Manhattan distance
```

### Types

```typescript
interface VectorConfig {
  size: number; // Vector dimensions
  distance: DistanceMetric;
}

interface Point {
  id: string | number; // Unsigned integer (≤ 2^53 − 1) or UUID string
  vector: number[]; // Vector data
  payload?: Record<string, any>; // Optional metadata
}

interface SearchOptions {
  limit?: number; // Max results (default: 10)
  offset?: number; // Skip results (default: 0)
  withPayload?: boolean; // Include metadata (default: true)
  withVectors?: boolean; // Include vectors (default: false)
  scoreThreshold?: number; // Min similarity score
  queryFilter?: Filter; // Filter conditions
}

interface SearchResult {
  id: string | number; // Unsigned integer (≤ 2^53 − 1) or UUID string
  score: number; // Similarity score
  payload?: Record<string, any>; // Metadata (if requested)
  vector?: number[]; // Vector (if requested)
}
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run tests with coverage
npm run test:coverage

# Run browser compatibility tests
npm run test:browser

# Run specific test file
npm test -- --testNamePattern="client"

# Watch mode during development
npm run test:watch
```

## 🏗️ Building

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Build and watch for changes
npm run build:watch

# Type checking
npm run type-check

# Linting
npm run lint

# Format code
npm run format
```

## 📊 Performance

### Benchmarks

- **Latency**: Sub-50ms average globally
- **Throughput**: 100,000+ queries per second
- **Cache Hit Rate**: 94%+ typical
- **Availability**: 99.9% SLA
- **Regions**: 12+ global locations

### Best Practices

1. **Use appropriate batch sizes** (100-1000 points per upsert)
2. **Enable caching** for repeated queries
3. **Use filters** to reduce search space
4. **Monitor usage** to stay within limits
5. **Choose optimal distance metric** for your use case

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/aetherfy/aetherfy-vectors-js.git
cd aetherfy-vectors-js

# Install dependencies
npm install

# Run development build
npm run dev

# Run tests
npm test
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: [https://docs.aetherfy.com](https://docs.aetherfy.com)
- **API Reference**: [https://docs.aetherfy.com/api](https://docs.aetherfy.com/api)
- **GitHub Issues**: [Report bugs and request features](https://github.com/aetherfy/aetherfy-vectors-js/issues)
- **Community**: [Join our Discord](https://discord.gg/aetherfy)
- **Email**: [developers@aetherfy.com](mailto:developers@aetherfy.com)

## 🔗 Related Projects

- **Python SDK**: [aetherfy-vectors-python](https://github.com/aetherfy/aetherfy-vectors-python)

---

Made with ❤️ by the [Aetherfy](https://aetherfy.com) team

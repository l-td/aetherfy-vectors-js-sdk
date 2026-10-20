# Aetherfy Vectors JavaScript SDK

[![npm version](https://img.shields.io/npm/v/aetherfy-vectors.svg)](https://www.npmjs.com/package/aetherfy-vectors)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)

**Memory for AI agents** — conversations, knowledge bases, scrape logs, trading
histories. Named scopes you create and search, replicated across regions, with
no infrastructure to run.

## 🌟 Features

- **🧠 Memory Primitives** - `Namespace` for any named scope, `Thread` for conversations — not a raw collection API
- **🌍 Global Performance** - Automatic replication across all three regions: `us-east-1`, `eu-central-1`, `ap-southeast-1`
- **⚡ Intelligent Caching** - High cache hit rate, with responses served from cache where possible
- **🛡️ Zero DevOps** - Fully managed infrastructure, no setup required
- **🤝 Workspaces** - every collection lives in one; inside a deployed agent the agent's own is used
- **📊 Built-in Analytics** - Real-time performance metrics and insights
- **🔧 Auto-Failover** - Seamless failover and disaster recovery
- **🔒 Enterprise Security** - End-to-end encryption and compliance ready
- **🚀 Developer Friendly** - TypeScript-first with comprehensive documentation
- **🪜 Escape Hatch** - `AetherfyVectorsClient` underneath for raw collections and points

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

Every memory lives in a scope you create by name. Two kinds: a **namespace** for
anything with a name, a **thread** for a conversation. Bring your own embedding
vectors — Aetherfy stores and searches them, it does not generate them.

```typescript
import { MemoryClient } from 'aetherfy-vectors';

const memory = new MemoryClient(); // inside an Aetherfy agent: its key and its workspace

// --- A namespace: any named scope ---------------------------------------
await memory.createNamespace('customer-42');
const customer = await memory.namespace('customer-42');

await customer.add({
  text: 'Lives in NYC, prefers email',
  vector: await embed('Lives in NYC, prefers email'),
});
const hits = await customer.search(
  await embed('where is this customer based?'),
  { limit: 5 }
);

// --- A thread: a conversation -------------------------------------------
await memory.createThread('conv-99');
const thread = await memory.thread('conv-99');

await thread.add({ role: 'user', content: 'hi', vector: await embed('hi') });
await thread.add({
  role: 'assistant',
  content: 'hello',
  vector: await embed('hello'),
});
const recent = await thread.history({ limit: 20 }); // in message order

// Clearing a scope is atomic. After it, the scope no longer exists.
await thread.clear();
```

Scopes must be created before you write to them, so a typo throws instead of
silently creating a second store.

A **namespace** is one collection, and takes its own `vectorSize` (default 384;
pass 1536 for OpenAI small, 3072 for large, 1024 for Cohere v3).

**Threads do not work that way.** Every thread in a workspace lives in one
shared collection with the thread id as a payload key, so a conversation costs
no collection slot and a plan's collection limit does not cap how many
conversations you can have. One collection means one dimension for all of them,
so `createThread` takes no options: they come from the client.

That collection is `__threads__`, one in each workspace (collection names are
unique per workspace). It is managed by the SDK, and Aetherfy refuses to move
or rename it: it holds the conversations of every agent in its workspace, so
moving it would hand them to another workspace's agents. An agent that moves
to another workspace leaves its conversation history behind in the old one.

```typescript
const memory = new MemoryClient({ threadVectorSize: 1536 }); // OpenAI small
```

Deployed on Aetherfy, `new MemoryClient()` takes no arguments at all: the control
plane injects `AETHERFY_API_KEY` and `AETHERFY_WORKSPACE_ID` (the agent's
workspace) at deploy time. Anywhere else, name a workspace:
`new MemoryClient({ workspace: 'default' })`.

Full memory API — iteration, bulk loading, metadata — under
[Memory SDK](#-memory-sdk--iter-bulk-load-setmetadata) below.

## 🧱 The Low-Level Client

`AetherfyVectorsClient` is the layer `MemoryClient` is built on, exported and
supported. Use it when you want raw collections and points rather than named
scopes, or an operation the memory layer doesn't expose.

The snippets below build on each other; each assumes the imports and client
from the previous ones.

```typescript
import { AetherfyVectorsClient, DistanceMetric } from 'aetherfy-vectors';

// Initialize client
const client = new AetherfyVectorsClient({
  apiKey: 'afy_live_your_api_key_here', // or use environment variable
  workspace: 'default', // every collection lives in a workspace; every account starts with "default"
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
  workspace: 'default',
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
const client = new AetherfyVectorsClient({ workspace: 'default' });
```

### 3. Custom Endpoint

```typescript
const client = new AetherfyVectorsClient({
  apiKey: 'your_api_key',
  workspace: 'default',
  endpoint: 'https://custom.vectors.endpoint.com',
  timeout: 45000, // Custom timeout in milliseconds
});
```

### 4. Local development across regions

`apiRegion` pins which **regional API endpoint** the client connects to —
a transport/routing override, NOT where collections live (for collection
placement see `createCollection(name, config, { regions })`). Production agents have
`AETHERFY_VECTORS_URL` injected by the control-plane — that's the URL they
reach the regional backend through, and it takes precedence over
`apiRegion`. For local development (no env var injected), you can pin a
client to a specific API region — but `apiRegion` requires the async
factory rather than `new`, because the SDK has to call
`GET /api/v1/regions` to resolve the per-region URL:

```typescript
const client = await AetherfyVectorsClient.create({
  apiKey: 'afy_test_...',
  workspace: 'default',
  apiRegion: 'eu-central-1', // 'us-east-1' | 'eu-central-1' | 'ap-southeast-1'
});
```

`create()` mirrors Python's `AetherfyVectorsClient(api_key=..., api_region='eu-central-1')`
contract: when the call resolves, the client is fully ready — endpoint,
analytics, and `.apiRegion` are all final. Discovery errors surface at the
`create()` call site instead of being deferred to your first method call.

If you call `new AetherfyVectorsClient({apiRegion: 'eu-central-1'})` without an
override (`endpoint=` or `AETHERFY_VECTORS_URL`), the constructor
throws telling you to use `create()` — async discovery isn't safe
inside a sync constructor and silent deferral is a footgun.

If both `AETHERFY_VECTORS_URL` and `apiRegion` are set, the env var wins
and a warning is logged — production-agent protection rule.

### Unknown options throw

Every options object the SDK takes — the client constructor and `create()`,
`createCollection`, `updateCollection`, `search`, `retrieve`, `scroll`, `scrollIter`, `count`, `setPayload`, the
`MemoryClient` constructor, the `Namespace` / `Thread` methods,
`retryWithBackoff`, `HttpClient` and `fanOut` — accepts exactly the keys its TypeScript type declares. Any
other key throws a `TypeError` naming the key, the method and the accepted
keys, even in plain JavaScript and even when its value is `undefined`:

```typescript
new AetherfyVectorsClient({ apiKey: 'afy_test_...', region: 'eu-central-1' });
// TypeError: AetherfyVectorsClient constructor: unknown option(s): region.
//   Accepted: apiKey, endpoint, timeout, enableConnectionPooling, workspace, apiRegion.
```

The API endpoint option is `apiRegion`. The Python SDK raises `TypeError`
for an unknown argument the same way. `new MemoryClient({ client })` uses that
client as-is, so passing a connection key beside it (`apiKey`, `endpoint`, …)
throws too, naming the key.

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

> **An unknown option throws.** Passing `limit` instead of `batchSize`
> throws a `TypeError` at the `scrollIter(...)` call, naming the key and
> listing the accepted ones — `{ batchSize: 256, limit: 100 }` would
> otherwise page at 256 with `limit` dropped. See
> [Unknown options throw](#unknown-options-throw).

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

Threads have no `addMany()` — a `Thread` is not a `Namespace` subclass
(they share a scope base but declare their own write API), so there is
no `addMany` to call. `addMany` writes `text`/`metadata` payloads,
which don't fit a thread's `role`/`content`/`ts` schema. Use
`appendMany()` on threads.

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

Every collection lives in exactly one workspace, and every account starts with
one named `default`. A workspace decides where a collection is reachable from:
agents in the same workspace see each other's collections, and an agent reaches
another workspace only if the account owner granted it access.

Collection names are unique **per workspace**: `invoices` in `customer-a` and
`invoices` in `customer-b` are two collections.

### Choosing the workspace

```typescript
const client = new AetherfyVectorsClient({
  apiKey: 'afy_live_your_api_key_here',
  workspace: 'invoice-pipeline', // All operations are scoped to this workspace
});
```

`workspace` defaults to `'auto'`: inside an agent deployed on Aetherfy, the
agent's own workspace, by id, from `AETHERFY_WORKSPACE_ID` (the control plane
injects it on every agent). A workspace rename never breaks an agent, because
it is addressed by id.

```typescript
// Inside a deployed agent: its own workspace, nothing to configure.
const client = new AetherfyVectorsClient();
```

There is no "no workspace". `workspace: null`, `''`, and `'auto'` outside an
agent (where `AETHERFY_WORKSPACE_ID` is not set, including every browser) throw
at construction, saying to pass a workspace name or run inside an agent.
`client.workspace` is the name (undefined when built from the id) and
`client.workspaceId` the id (undefined when given a name).

`'auto'` is only the agent's home workspace. Code that works across several
workspaces (one per customer, say) passes each workspace's name explicitly,
one client per workspace.

### How scoping works

You always use the collection's own name; the client sends it on the
workspace's routes:

```typescript
// Create a collection in the client's workspace
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

### Workspace errors

```typescript
import { WorkspaceNotFoundError } from 'aetherfy-vectors';

try {
  await client.getCollections();
} catch (error) {
  if (error instanceof WorkspaceNotFoundError) {
    // No such workspace in this account. A typo is never read as "empty".
    console.log(`Unknown workspace: ${error.workspace ?? error.workspaceId}`);
  }
}
```

`collectionExists()` is false only when the workspace exists and the
collection is not in it; an unknown workspace throws.

### When a request is retried

One rule, the same in the Python and JS SDKs (`src/retry-policy.ts`). Up to 3
retries, waiting about 1 s, 2 s, then 4 s (each jittered to 50-100%), within
a call's timeout.

| Failure | Retried for |
|---|---|
| Refused before anything ran: 503 `WORKSPACE_LOOKUP_UNAVAILABLE`, `COLLECTION_LOOKUP_UNAVAILABLE`, `PLACEMENT_UNAVAILABLE`; a connection never made (DNS, refused, connect timeout); 429 with a Retry-After | every operation |
| Ambiguous, the request may have run: a read timeout, a reset after sending, any other 5xx | only operations whose repeat gives the same result (below) |
| Any other 4xx | never |

| Operations | Class |
|---|---|
| `getCollections`, `getCollection`, `collectionExists`, `getSchema`, `analyzeSchema`, `search`, `retrieve`, `scroll`, `count`, `getUsageStats` | reads: repeatable |
| `upsert`, `setPayload`, `overwritePayload`, `deletePayload`, `createFieldIndex`, `setSchema` | writes keyed by id: repeatable |
| `updateCollection` | repeatable: a repeat after a hidden success asks for the mode the collection now has, which does nothing |
| `createCollection`, `deleteCollection`, `delete` (points), `deleteSchema`, `deleteFieldIndex` | once: a repeat after a hidden success reports a false error, so an ambiguous failure is raised after one attempt |

`setSchema` is repeatable because it is sent without `If-Match`: a repeat writes
the same schema again. A conditional write would get a false 412 on a repeat
after a hidden success, so it would be classed once.

A connection "never made" is known from the SDK's own HTTP agents, which watch
whether each socket ever connected (Node and Bun both give them). Where no
such information exists (a custom agent, an adapter or runtime that gives no
socket) a transport failure counts as "may have been sent": only repeatable
operations are retried.

When the retries run out, the last error is raised (`ServiceUnavailableError`, `RequestTimeoutError` or `NetworkError`).

The client already retries under this rule. To retry more around your own
operation, say whether repeating it gives the same result: `REPEATABLE` (a
read, a write keyed by id) or `ONCE` (a create, a delete). The same failures
are retried as above; a 4xx never is.

```typescript
import { retryWithBackoff, REPEATABLE } from 'aetherfy-vectors';

const results = await retryWithBackoff(
  () => client.search('collection', vector),
  {
    retryClass: REPEATABLE,
    maxRetries: 3,
    baseDelay: 1000,
  }
);
```

Renaming a collection, and moving one to another workspace, are done from the
dashboard or the CLI (`afy collections update`), not from the SDK. Code still
using the old name gets `CollectionNotFoundError`.

> **Tip:** Create workspaces in the dashboard or with the CLI
> (`afy workspaces create invoice-pipeline`). Agents deployed to a workspace
> receive its id as `AETHERFY_WORKSPACE_ID`.

## 🤖 Running as an Agent

Code deployed to Aetherfy as an agent gets a set of helpers from the same
package, on the `aetherfy-vectors/agent` subpath. Nothing to add to your
`package.json`: the standard runtime image preinstalls `aetherfy-vectors`, and
a version you pin yourself wins over it. A custom container installs it like
any other package.

Each of these is a thin wrapper over a platform contract the docs already
publish; the helper exists so the contract stops being copied into every task.

```typescript
import { payload, machine, fanOut, spawn } from 'aetherfy-vectors/agent';

// This run's input. A scheduled fire sends none, so {} is the normal case.
const data = await payload();

// The machine this run is on: numbers, not the strings the env carries.
const shape = machine();

// An in-machine pool. Results come back in INPUT order and no failure is
// swallowed: the lowest-indexed rejection is re-thrown once every worker has
// settled. Width defaults to vcpus x 8, which suits I/O-bound work.
const answers = await fanOut(summarise, (data.items as string[]) ?? []);

// Narrower, when each item is heavy.
const digests = await fanOut(hashOne, files, { width: shape.vcpus });

// Run a different task agent, on its own machine, with its own lifecycle.
const run = await spawn('nightly-rollup', { date: '2026-09-07' });
console.log(run.spawn_id, run.region, run.status);
```

`fanOut` prints one line to the run's logs before it starts, so how wide a run
went is visible after the fact:

```text
aetherfy: fanning out 32 wide on 4 vCPU / 8192 MB (120 tasks)
```

`fanOut` is promise concurrency, which is all I/O-bound work needs — model
calls and HTTP requests fan out on the event loop and never touch a thread.
CPU-bound work belongs in `worker_threads`, sized from `shape.vcpus`.

Spawning has three outcomes worth telling apart. The payload cap and the
concurrent-run cap get their own types; everything else carries the platform's
stable error code, which is the thing to branch on:

```typescript
import {
  spawn,
  PayloadTooLarge,
  SpawnError,
  TooManyRunsInFlight,
} from 'aetherfy-vectors/agent';

try {
  await spawn('nightly-rollup', { date: '2026-09-07' });
} catch (error) {
  if (error instanceof PayloadTooLarge) {
    // The payload is for parameters and references, not data. Write the data
    // to a collection and pass its id.
    console.error(error.payloadBytes, 'exceeds', error.maxBytes);
  } else if (error instanceof TooManyRunsInFlight) {
    // The one refusal here worth retrying: runs are finishing all the time.
    // The cap is the ACCOUNT's and is set by your plan; `limit` names which
    // plan limit was hit, and `maxInFlightRuns` is null on an uncapped plan.
    console.error(
      'waiting on',
      error.inFlightCount,
      'of',
      error.maxInFlightRuns
    );
  } else if (error instanceof SpawnError) {
    console.error(error.code);
  } else {
    throw error;
  }
}
```

### Returning a result, and reading one back

Output on Aetherfy mirrors input. A task writes its answer with `writeResult`;
whoever started the run reads it back off the run itself, so a parent hears from
a child in another region with no side channel between them.

```typescript
import { writeResult } from 'aetherfy-vectors/agent';

// In the child task. The mirror of payload(): a file on the machine, nothing
// over the network. Returning nothing is the normal case, so most tasks never
// call this at all.
await writeResult({ rows: 128, date: '2026-09-08' });
```

```typescript
import { spawn, wait, result } from 'aetherfy-vectors/agent';

// In the parent. wait() holds one request open instead of polling; a run that
// has not finished in time comes back exactly as it stands, which is not an
// error — read `state` and call again.
const run = await spawn('nightly-rollup', { date: '2026-09-08' });
const finished = await wait(run.spawn_id, 45);

if (finished.state === 'completed') {
  console.log(finished.result);
}

// result() is the same read without the waiting.
const now = await result(run.spawn_id);
console.log(now.state, now.has_result, now.result_error);
```

The result shares the payload's inline cap — one number bounding both
directions — and it is for answers and references, not data. Anything larger
belongs in a collection, with its id in the result:

```typescript
import { writeResult, ResultTooLarge } from 'aetherfy-vectors/agent';

try {
  await writeResult(everything);
} catch (error) {
  if (error instanceof ResultTooLarge) {
    console.error(error.resultBytes, 'exceeds', error.maxBytes);
    await writeResult({
      collection: 'nightly-rollup',
      rows: everything.length,
    });
  } else {
    throw error;
  }
}
```

Reading a run has the same shape as spawning it: the two refusals worth telling
apart get their own types, and everything else carries the platform's stable
error code.

```typescript
import {
  result,
  RunAccessDenied,
  RunNotFound,
  RunReadError,
} from 'aetherfy-vectors/agent';

try {
  await result(runId);
} catch (error) {
  if (error instanceof RunNotFound) {
    console.error('no run has that id');
  } else if (error instanceof RunAccessDenied) {
    console.error('that run belongs to another account');
  } else if (error instanceof RunReadError) {
    console.error(error.code);
  } else {
    throw error;
  }
}
```

With the agent's own `AETHERFY_API_KEY`, a read the control plane does not
allow that key ([which ones it allows](https://docs.aetherfy.com/platform/api-keys#agent-scoped-keys-issued-by-aetherfy))
is refused with `RunReadError` and `code` `AUTH_AGENT_KEY_OUT_OF_SCOPE`.

Full contract, including the environment variables behind every call:
[docs.aetherfy.com/agents/task-contract](https://docs.aetherfy.com/agents/task-contract).

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

## 🎚️ Performance modes

A collection's **performance mode** is a preset for how its vectors are stored
and searched. You pick one of four names; the service applies the settings.

| Mode                  | What it does                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `exact` (the default) | Full-precision vectors in memory, and search reads them. The layout every collection had before modes existed.                             |
| `balanced`            | Searches a compact 8-bit copy of each vector and keeps the originals on disk to rescore the best candidates. Far less memory than `exact`. |
| `fast`                | The same compact copy, with the originals kept in memory too. Uses **more** memory than `exact`, not less.                                 |
| `compact`             | A 2-bit copy with the originals on disk: the smallest footprint and the lossiest mode. Needs vectors of at least 512 dimensions.           |

```typescript
import { PerformanceMode } from 'aetherfy-vectors';

const collection = await client.createCollection(
  'docs',
  { size: 1536, distance: DistanceMetric.COSINE },
  { performanceMode: PerformanceMode.BALANCED } // or the string 'balanced'
);
console.log(collection.performanceMode); // PerformanceMode.BALANCED

// Change it later. The collection stays usable while its storage is rewritten
// in the background (its status reads 'yellow' until that finishes).
await client.updateCollection('docs', { performanceMode: 'fast' });
```

- Quantized modes lose some recall. Searching with oversampling and rescoring
  recovers most of it:
  `client.search('docs', query, { limit: 10, searchParams: { quantization: { rescore: true, oversampling: 2.0 } } })`.
  `compact` loses the most, and how much depends on the embedding model: test
  it on your own data before you rely on it.
- A collection can change mode once every 15 minutes. A change inside that
  window throws `ConflictError` with `code` `PERFORMANCE_MODE_CHANGE_TOO_SOON`;
  the seconds left are `error.details.retry_after_seconds`. It is not retried
  for you, because waiting inside the call cannot help. Asking for the mode a
  collection already has does nothing and does not start the wait.
- `compact` on a collection of fewer than 512 dimensions throws
  `ValidationError` with `code` `PERFORMANCE_MODE_UNSUITABLE`.
- Re-creating a collection that exists never changes its mode, and the returned
  `Collection` shows the mode it has, not the one you asked for.
- `updateCollection(name, { description })` changes the description too;
  `description: null` clears it. Pass at least one of the two.
- `getCollection` and `getCollections` return `performanceMode` (camelCase);
  the wire's `performance_mode` is not kept on the object.
- Every mode is available on every plan. Storage is metered the same way in
  every mode.

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
  { description: 'EU-resident collection', regions: ['eu-central-1'] }
);

// Choose how the vectors are stored and searched (see Performance modes),
// and change it later. Returns true once the change is applied.
await client.createCollection(
  'docs',
  { size: 1536, distance: DistanceMetric.COSINE },
  { performanceMode: PerformanceMode.BALANCED }
);
await client.updateCollection('docs', { performanceMode: 'fast' });

// List all collections
const collections = await client.getCollections();

// Check if collection exists
const exists = await client.collectionExists('my-collection');

// Payload indexes. A filter on an UNINDEXED key is scanned, not looked up —
// index any key you filter on for every read (a tenant id, a status, a
// timestamp you range over). fieldSchema: 'keyword' | 'integer' | 'float' |
// 'bool' | 'geo' | 'datetime' | 'uuid' | 'text', or a parameterised object.
// Resolves once the index is built, so a filter or an orderBy scroll on the
// key can follow straight away. A large collection can take longer than the
// server's 25 s wait; the call then waits on, up to { timeout } (ms, default
// 600000). Past it, RequestTimeoutError: the build carries on, and calling
// again waits.
await client.createFieldIndex('my-collection', 'tenantId', 'keyword');
await client.createFieldIndex('my-collection', 'ts', 'integer', {
  timeout: 120000,
});
// true when the collection exists, even if the field was never indexed;
// false only when the collection does not exist.
await client.deleteFieldIndex('my-collection', 'tenantId');

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

// Advanced search with filtering. Three clauses, and only three:
// must, mustNot, should.
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
    mustNot: [{ key: 'status', match: { value: 'discontinued' } }],
  },
});

// Trade latency for recall: a larger hnsw_ef makes the graph walk visit more
// candidates. Omit searchParams to keep the tuned server default (hnsw_ef=100).
const preciseResults = await client.search('collection-name', queryVector, {
  searchParams: { hnsw_ef: 256 },
});
```

`searchParams` is passed through untranslated as the request body's `params` —
the API and Qdrant own the schema, so the SDK validates nothing and needs no
release to track new params. Note that the server cache key is derived from the
request body, so the same query at a different `hnsw_ef` is a separate cache
entry (never a wrong hit).

### Filter clauses

This SDK speaks camelCase: the clause is `mustNot`, and the SDK translates it
to the engine's `must_not` on the wire. A clause name outside
`must` / `mustNot` / `should` throws before the request is sent — including
`must_not`, which is the Python SDK's spelling and is rejected with a message
naming the camelCase form. Nothing unknown is forwarded, and nothing is
dropped: an unrecognized clause used to vanish silently, turning a narrowing
filter into a match-everything query. The rule holds everywhere a filter is
accepted — `search`, `scroll`, `scrollIter`, `count`, `delete`.

```typescript
import type { Filter } from 'aetherfy-vectors';

const filter: Filter = {
  must: [{ key: 'category', match: { value: 'electronics' } }],
  mustNot: [{ key: 'status', match: { value: 'discontinued' } }],
};

const inStock = await client.count('collection-name', { countFilter: filter });
await client.delete('collection-name', filter);
```

## 📊 Usage & Limits

Aetherfy does not report latency or cache-hit telemetry through this SDK. Time
your own calls — that figure includes your network path to us, and it is the
only latency your users actually experience.

```typescript
// Monitor usage and limits
const usage = await client.getUsageStats();

usage.storage_bytes_used; // number      — bytes stored across every collection
usage.storage_limit_bytes; // number|null — null on an unlimited tier
usage.collections_count; // number       — active collections
usage.collections_limit; // number|null  — null on an unlimited tier
usage.tier; // string                    — the plan's tier name
usage.active_regions; // string[]        — union of your collections' regions
usage.usage_percentage; // number        — storage %, 0 when there is no limit

console.log(
  `Collections: ${usage.collections_count}/${usage.collections_limit}`
);
console.log(`Storage: ${usage.storage_bytes_used} bytes`);
console.log(`Tier: ${usage.tier}`);

// Usage warning example
if (usage.storage_limit_bytes !== null && usage.usage_percentage > 80) {
  console.warn('⚠️ Approaching storage limit');
}
```

These are the endpoint's own field names, in its own snake_case, returned
untouched — the SDK's camelCase vocabulary is for the options you send, not for
the bodies you get back.

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
        workspace: 'default', // a browser has no agent workspace: name one
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
  NotFoundError, // parent of every not-found error
  CollectionNotFoundError,
  PointNotFoundError,
  WorkspaceNotFoundError,
  ServiceUnavailableError,
  RequestTimeoutError,
  NetworkError,
  ConflictError,
  CollectionInUseError,
  QuotaExceededError,
  SchemaNotFoundError,
  SchemaValidationError,
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
    // `errors` is one entry per rejected point: { index, id, errors: [{ field, code, message }] }
    console.error('Schema violations:', error.errors);
  } else if (error instanceof QuotaExceededError) {
    console.error(
      `Quota '${error.quotaType}' exceeded: ${error.current}/${error.limit}`
    );
  } else if (error instanceof ServiceUnavailableError) {
    // Already retried under the rule ("When a request is retried"). Calling
    // again is safe only for a repeatable operation: an ambiguous failure of
    // a delete or a create may have succeeded.
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

| Method                                                   | Description                                                                        | Returns                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| `createCollection(name, config, options?)`               | Create a new collection; `options`: `description`, `regions`, `performanceMode`    | `Promise<Collection>`     |
| `updateCollection(name, options)`                        | Change `description` or `performanceMode`                                          | `Promise<boolean>`        |
| `deleteCollection(name)`                                 | Delete a collection                                                                | `Promise<boolean>`        |
| `getCollections()`                                       | List all collections                                                               | `Promise<Collection[]>`   |
| `collectionExists(name)`                                 | Check if collection exists                                                         | `Promise<boolean>`        |
| `getCollection(name)`                                    | Get collection info                                                                | `Promise<Collection>`     |
| `createFieldIndex(collection, field, schema?, options?)` | Create a payload index on one field (default `'keyword'`); resolves once built     | `Promise<boolean>`        |
| `deleteFieldIndex(collection, field)`                    | Drop a payload index; false only when the collection does not exist                | `Promise<boolean>`        |
| `upsert(collection, points)`                             | Insert/update vectors                                                              | `Promise<boolean>`        |
| `delete(collection, selector)`                           | Delete vectors                                                                     | `Promise<boolean>`        |
| `retrieve(collection, ids, options)`                     | Get vectors by ID                                                                  | `Promise<Point[]>`        |
| `search(collection, vector, options)`                    | Similarity search                                                                  | `Promise<SearchResult[]>` |
| `count(collection, options)`                             | Count vectors                                                                      | `Promise<number>`         |
| `getSchema(collection)`                                  | Get payload schema                                                                 | `Promise<Schema \| null>` |
| `setSchema(collection, schema, mode?, desc?)`            | Define/update schema                                                               | `Promise<string>` (ETag)  |
| `deleteSchema(collection)`                               | Remove schema                                                                      | `Promise<boolean>`        |
| `analyzeSchema(collection, sampleSize?)`                 | Infer schema from data                                                             | `Promise<AnalysisResult>` |
| `refreshSchema(collection)`                              | Force schema cache refresh                                                         | `Promise<void>`           |
| `clearSchemaCache(collection?)`                          | Clear schema cache                                                                 | `void`                    |
| `getUsageStats()`                                        | Account usage                                                                      | `Promise<UsageStats>`     |
| `testConnection()`                                       | Test API connection                                                                | `Promise<boolean>`        |
| `destroy()`                                              | Close HTTP connections                                                             | `void`                    |

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
  searchParams?: Record<string, unknown>; // Engine params, sent verbatim as `params`
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

### Characteristics

- **Latency**: served from the region nearest the caller
- **Caching**: built in, on by default
- **Failover**: automatic between regions
- **Regions**: `us-east-1`, `eu-central-1`, `ap-southeast-1`

### Best Practices

1. **Use appropriate batch sizes** (100-1000 points per upsert)
2. **Enable caching** for repeated queries
3. **Use filters** to reduce search space
4. **Monitor usage** to stay within limits
5. **Choose optimal distance metric** for your use case

## 🤝 Contributing

We welcome contributions! Open an issue or a pull request on
[GitHub](https://github.com/l-td/aetherfy-vectors-js-sdk).

### Development Setup

```bash
# Clone the repository
git clone https://github.com/l-td/aetherfy-vectors-js-sdk.git
cd aetherfy-vectors-js-sdk

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

- **Documentation**: [https://docs.aetherfy.com/vectors](https://docs.aetherfy.com/vectors)
- **API Reference**: [https://docs.aetherfy.com/vectors/api](https://docs.aetherfy.com/vectors/api)
- **SDK Reference**: [https://docs.aetherfy.com/vectors/sdk](https://docs.aetherfy.com/vectors/sdk)
- **GitHub Issues**: [Report bugs and request features](https://github.com/l-td/aetherfy-vectors-js-sdk/issues)
- **Email**: [developers@aetherfy.com](mailto:developers@aetherfy.com)

## 🔗 Related Projects

- **Python SDK**: [aetherfy-vectors (Python)](https://github.com/l-td/aetherfy-vectors-python-sdk)

---

Made with ❤️ by the [Aetherfy](https://aetherfy.com) team

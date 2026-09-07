# Changelog

## [Unreleased]

## [1.1.0] - 2026-09-07

### Added

- **`aetherfy-vectors/agent` — the four things code running on an Aetherfy
  agent does.** A new subpath export on this same package, beside the root
  entry:

  - `payload()` reads this run's input. The file named by
    `AETHERFY_SPAWN_PAYLOAD_PATH` first, then the documented HTTP fallback
    when the machine could not write it; `{}` for a run given no input, which
    is the normal case for a scheduled fire.
  - `machine()` returns the run's `MachineShape` — `vcpus`, `memory_mb`,
    `region` — as numbers rather than the strings the environment carries.
  - `fanOut(fn, items, { width })` runs an in-machine pool and resolves with
    results in INPUT order, re-throwing the lowest-indexed rejection rather
    than swallowing it. Width is promise concurrency and defaults to
    `vcpus * 8` for the I/O-bound work most tasks do; CPU-bound work belongs
    in `worker_threads`, sized from `machine().vcpus`. It prints one line to
    stdout before running, so a run's width is visible in its logs afterwards.
  - `spawn(child, payload?)` runs a different task agent.
    `413 RUN_PAYLOAD_TOO_LARGE` becomes `PayloadTooLarge` (carrying
    `payloadBytes` / `maxBytes`) and
    `429 AGENT_SPAWN_CONCURRENCY_LIMIT_EXCEEDED` becomes
    `TooManyRunsInFlight`, the one refusal worth retrying. THE STATUS AND
    THE CODE TOGETHER select the type: a 413 or 429 carrying any other
    code, or none, becomes a plain `SpawnError` reporting the code and
    message that actually arrived, rather than wearing a code the platform
    never sent. Every other status becomes `SpawnError` with the
    platform's stable `code` too.
    `TooManyRunsInFlight` carries `inFlightCount`, `limit` (which plan limit
    was hit, `"max_in_flight_runs"` today) and `maxInFlightRuns` (its value,
    `null` on a plan that declares no cap). The cap is the ACCOUNT's, set by
    the plan — not a per-agent spawn ceiling. All three are `null` rather
    than `undefined` when absent, so they read the same as the Python
    helper's `None`.

  Each of these was already a documented platform contract that every task
  hand-rolled; none of them is a new protocol. The module adds NO dependency:
  its transport is the runtime's own `fetch` and `node:fs/promises`. Both
  requests set an explicit `User-Agent`, because the default is blocked at the
  edge and produces a 403 that reads exactly like an auth failure.

  `MachineShape` and `Spawn` are snake_case, matching the Python helper and
  this SDK's rule that inbound shapes keep their wire spelling — the camelCase
  vocabulary is outbound only.

  There is deliberately no `result()` and no `wait()`: a run reports its
  outcome through its exit code, and the platform's result path does not exist
  yet.

  The standard runtime image preinstalls this package, so a plain agent gets
  the helper with nothing in its `package.json`, and a version the customer
  pins wins over it.

### Changed

- **Both ESM bundles are now `.mjs`.** The root entry moves from
  `dist/index.esm.js` to `dist/index.mjs`, and the new `./agent` entry
  resolves to `dist/agent.esm.mjs` (import), `dist/agent.cjs.js` (require)
  and `dist/agent/index.d.ts` (types). This package has no
  `"type": "module"`, so Node has to reparse a `.js` ESM file and prints a
  `MODULE_TYPELESS_PACKAGE_JSON` warning. Measured on node 22.20.0 with the
  same bytes in two places: the warning prints from a repo checkout and is
  suppressed under `node_modules`, so a normal `npm install` never showed
  it — the reparse, which Node calls out as a performance overhead, happens
  either way. The gain is the correct extension, one less reparse per
  import, and a clean console for anyone consuming the package outside
  `node_modules` (a linked workspace, a vendored copy, a bundler's dev
  server). The `main`, `module`, `browser` and `types` fields and the export
  conditions are otherwise unchanged, and nothing resolves these paths by
  hand: the exports map is the only way in.
- **There is now ONE version literal**, `SDK_VERSION` in `src/version.ts`.
  `VERSION` re-exports it, the HTTP client's `User-Agent` interpolates it,
  and the agent helper's User-Agent reads it. There were three literals, and
  the client's had already drifted — it announced `Aetherfy-Vectors-JS/1.0.0`
  from a 1.1.0 package, which is only ever discovered by someone trying to
  reproduce a bug report from a User-Agent naming the wrong release. A unit
  test pins the constant against `package.json`, pins all three consumers
  against the constant, and fails if a second literal of the version
  reappears anywhere under `src/`.

### Fixed

- **`Collection.pointsCount` is now `Collection.points_count`.** It was
  `undefined` on every call: `getCollection()` returns `response.data.result`
  verbatim, there is no inbound transform in this SDK, and the wire field is
  `points_count`. The same defect `UsageStats` carried, one interface over —
  and it was provable the whole time, because the e2e suite reads the
  snake_case name *through this method* and passes against live infrastructure.
  `name`, `description`, `status` and `regions` were correct only because the
  two vocabularies spell them identically; that is coincidence, not a
  transform, and the type now says so. Pinned by a new live e2e shape guard.

- `UsageStats` now describes the response `GET /api/v1/analytics/usage`
  actually serves: `storage_bytes_used`, `storage_limit_bytes` (`null` on an
  unlimited tier), `collections_count`, `collections_limit` (also `null` on an
  unlimited tier — one sentinel for both),
  `tier`, `active_regions` and `usage_percentage`. The nine camelCase fields it
  declared before (`currentCollections`, `maxCollections`, `currentPoints`,
  `maxPoints`, `requestsThisMonth`, `maxRequestsPerMonth`, `storageUsedMb`,
  `maxStorageMb`, `planName`) have never appeared in any response body:
  `getUsageStats()` returns `response.data` untouched, so every one of them was
  `undefined` at runtime while TypeScript said otherwise. The type is
  snake_case on purpose — this SDK's camelCase vocabulary is outbound only,
  and the body is returned verbatim. A live e2e call now pins the shape
  (aetherfy-e2e-tests `tests/sdk/js_usage_stats.test.js`).

## [1.0.0] - 2026-08-17

First public release on npm. Everything below ships in it: the `1.0.0`
section previously in this file described the same version before it was
ever published, so the work that accumulated under `[Unreleased]` is folded
in here rather than carried to a `1.0.1` that never existed.

### Added

- `searchParams` on `client.search()` and `Namespace`/`Thread.search()` —
  engine params sent verbatim as the body's `params`, e.g.
  `{ searchParams: { hnsw_ef: 256 } }` to trade latency for recall. Omitting
  it leaves the default body unchanged. Works against every deployed backend:
  the API has always forwarded the search body verbatim, so there is no
  version gate.
- Collection management (create, delete, list, check existence), point
  operations (upsert, delete, retrieve, search), advanced search with
  filters/scoring/pagination, and analytics.
- Full API parity with the Python SDK, including a matching error hierarchy.
- TypeScript type definitions, plus CJS, ESM and UMD (browser) builds.
- Retry logic with automatic backoff.

### Changed

- `client.search()` and `Namespace`/`Thread.search()` now run the
  `assertAllowedOptionKeys` guard, so unknown options throw instead of being
  silently dropped. TypeScript did not cover this — excess-property checking
  fires only on fresh object literals.
- `validatePointId` now enforces the server's point-id rule client-side:
  an id must be an unsigned integer ≤ 2^53 − 1 (`Number.MAX_SAFE_INTEGER`)
  or a UUID string in any of the four Qdrant-accepted forms (canonical,
  simple 32-hex, braced, `urn:uuid:`). Invalid ids throw `ValidationError`
  with the same wording as the server's 400 `INVALID_POINT_ID` response.
  This does not change which ids work — ids the validator now rejects were
  already rejected by the server; the error just surfaces before the
  request is sent.
- Point-id validation now also runs on `upsert`, `delete` (id-list form),
  and `retrieve`, matching the Python SDK's coverage (previously only the
  payload-mutation methods validated ids client-side).
- Filter clauses now serialize in a fixed order (`must`, `must_not`,
  `should`) regardless of the order the caller wrote them. Server cache keys
  are derived from the request body bytes, so two callers expressing the
  same filter differently now share one cache entry.
- An unrecognized filter clause throws instead of being forwarded. A filter
  is no longer passed to the engine unexamined, so `{ mustnot: [...] }` — or
  the Python SDK's `must_not` spelling — fails at the call site with a
  message naming the correct key.

### Fixed

- **`mustNot` filters were silently ignored.** The filter object was
  forwarded to the engine verbatim, with no key translation. `must` and
  `should` survived only because they are spelled identically in the SDK's
  camelCase vocabulary and the engine's snake_case one; `mustNot` is not,
  and the engine has no such key. The clause was dropped with no error and
  no warning, so a search returned exactly the points the caller meant to
  exclude. `mustNot` now reaches the wire as `must_not` from `search`,
  `scroll`, `count` and `delete`-by-filter alike, and the uncast
  `{ mustNot: [...] }` literal typechecks — the `as unknown as Filter` cast
  the docs used to prescribe is no longer needed.
- **ESM consumers crashed on client construction.** `HttpClient` built its
  connection-pool agents with a bare `require('http')`, which survives into
  the ES-module bundle unchanged — and `require` is not defined in ESM
  scope. `import { AetherfyVectorsClient } from 'aetherfy-vectors'` followed
  by `new AetherfyVectorsClient({ apiKey })` threw
  `ReferenceError: require is not defined`. The builtins are now imported
  statically. The whole test suite missed it because every test constructs
  with `enableConnectionPooling: false`, skipping the branch, and loads the
  CJS bundle, where `require` exists.
- `formatPointsForUpsert` (exported util) no longer rejects the valid
  point id `0` as "missing".
- Memory SDK: `Namespace.add`/`addMany` and `Thread.add`/`appendMany` no
  longer `String()`-coerce an explicit `id`. An integer id (a valid
  unsigned-integer point id) now reaches the wire as a number instead of
  being turned into a numeric string like `"42"` — which the point-id
  validator rejects. A non-int/non-UUID explicit id is passed through and
  correctly rejected by the upsert validator. Return types widen from
  `string`/`string[]` to `string | number` / `Array<string | number>`.

### Packaging

- Added the missing `LICENSE` file. `package.json` declared `"license":
  "MIT"` and listed `LICENSE` in `files`, but no such file existed, so the
  tarball would have shipped without one.
- Corrected `repository.url` and `bugs.url`, which pointed at a
  `github.com/aetherfy/aetherfy-vectors-js` repository that does not exist.
  `homepage` now points at the documentation site.

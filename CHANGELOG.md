# Changelog

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

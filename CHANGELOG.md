# Changelog

## [Unreleased]

### Changed

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

### Fixed

- `formatPointsForUpsert` (exported util) no longer rejects the valid
  point id `0` as "missing".
- Memory SDK: `Namespace.add`/`addMany` and `Thread.add`/`appendMany` no
  longer `String()`-coerce an explicit `id`. An integer id (a valid
  unsigned-integer point id) now reaches the wire as a number instead of
  being turned into a numeric string like `"42"` — which the point-id
  validator rejects. A non-int/non-UUID explicit id is passed through and
  correctly rejected by the upsert validator. Return types widen from
  `string`/`string[]` to `string | number` / `Array<string | number>`.

## [1.0.0] - 2024-01-XX

### Added

- Initial release of Aetherfy Vectors JavaScript SDK
- Full API compatibility with Python SDK
- TypeScript support with complete type definitions
- Browser and Node.js compatibility
- Comprehensive error handling with hierarchy matching Python SDK
- Analytics and monitoring features
- Retry logic with automatic backoff for robust operations
- Extensive test coverage with unit, integration, and browser tests
- Collection management (create, delete, list, check existence)
- Point operations (upsert, delete, retrieve, search)
- Advanced search with filters, scoring, and pagination
- Real-time analytics and performance monitoring
- Global vector database with sub-50ms latency worldwide
- Automatic replication and intelligent caching

### Features

- **Collections**: Create and manage vector collections with configurable distance metrics
- **Points**: Insert, update, delete, and retrieve vector points with metadata
- **Search**: Similarity search with advanced filtering and scoring options
- **Analytics**: Performance monitoring and usage statistics
- **Error Handling**: Comprehensive error types matching Python SDK
- **TypeScript**: Full type safety and IntelliSense support
- **Cross-Platform**: Works in both Node.js and browser environments

### Technical Details

- Built with TypeScript for type safety
- Rollup-based build system with multiple output formats
- Jest test suite with comprehensive coverage
- ESLint and Prettier for code quality
- Comprehensive JSDoc documentation
- Cross-fetch for universal HTTP client support

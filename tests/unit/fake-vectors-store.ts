/**
 * An in-memory stand-in for AetherfyVectorsClient that really applies filters.
 *
 * Why this exists: threads are now rows in one shared collection, separated
 * from each other by a payload filter and nothing else. A jest mock can prove
 * which filter the memory layer SENT, but not that the filter actually
 * isolates one thread from the next — and "clear() must not destroy a sibling
 * thread" is a claim about the second thing. This double stores points and
 * evaluates must / mustNot / should the way the engine does, so a test can
 * assert on surviving DATA rather than on recorded calls.
 *
 * Deliberately STRICTER than nothing and LOOSER than Qdrant: it supports
 * exactly the condition shapes the documented Aetherfy filter vocabulary has
 * (match and range, under the three clause arrays). An unknown condition shape
 * throws here rather than silently matching everything — the fail-open
 * behaviour of the real proxy is the hazard being defended against, so a
 * stand-in that reproduced it would hide the defect instead of catching it.
 *
 * Note the clause spelling: this double speaks the JS SDK's OUTBOUND
 * vocabulary (`mustNot`), because the memory layer hands filters to the client
 * in that form and `serializeFilter` is what turns it into the wire's
 * `must_not` one layer further down.
 */

import {
  AetherfyVectorsError,
  ConflictError,
  ValidationError,
} from '../../src/exceptions';
import {
  PerformanceMode,
  PerformanceModeInput,
} from '../../src/performance-modes';
import {
  Collection,
  CreateCollectionOptions,
  DistanceMetric,
  Filter,
  Point,
  ScrollPoint,
  SearchResult,
  VectorConfig,
  UpdateCollectionOptions,
  VectorConfigInput,
} from '../../src/models';

// vectordb's PERFORMANCE_MODE_COOLDOWN_SECONDS and COMPACT_MIN_DIMENSIONS
// (backend/utils/performanceModes.js). Copied, not imported: the server is
// another repo, and tests/unit/performance-mode.test.ts pins the behaviour.
const COOLDOWN_SECONDS = 900;
const COMPACT_MIN_DIMENSIONS = 512;

/** The filter conditions this double supports (a Qdrant subset). */
interface Cond {
  has_id?: Array<string | number>;
  key?: string;
  match?: { value: unknown };
  range?: { gt?: number; gte?: number; lt?: number; lte?: number };
}

interface Stored {
  id: string | number;
  vector: number[];
  payload: Record<string, unknown>;
}

function lookup(payload: Record<string, unknown>, key: string): unknown {
  let cur: unknown = payload;
  for (const part of key.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function matchCondition(
  payload: Record<string, unknown>,
  cond: Cond,
  pointId?: string | number
): boolean {
  if (cond.has_id !== undefined) {
    // A first-class Qdrant condition (HasIdCondition in the pinned 1.15.0
    // schema), so the double supports it rather than treating it as an
    // unknown shape.
    return pointId !== undefined && cond.has_id.includes(pointId);
  }
  if (cond.key === undefined) {
    throw new Error(`unsupported filter condition: ${JSON.stringify(cond)}`);
  }
  const value = lookup(payload, cond.key);
  if (cond.match !== undefined) return value === cond.match.value;
  if (cond.range !== undefined) {
    if (typeof value !== 'number') return false;
    const r = cond.range;
    if (r.gt !== undefined && !(value > r.gt)) return false;
    if (r.gte !== undefined && !(value >= r.gte)) return false;
    if (r.lt !== undefined && !(value < r.lt)) return false;
    if (r.lte !== undefined && !(value <= r.lte)) return false;
    return true;
  }
  throw new Error(`unsupported filter condition: ${JSON.stringify(cond)}`);
}

/**
 * Evaluate a filter the way Aetherfy documents it: the three clause arrays
 * compose as a conjunction — everything in `must` holds AND at least one
 * `should` holds AND nothing in `mustNot` holds.
 *
 * `failOpenOnMustNot` reproduces the ONE failure mode the docs promise: the
 * proxy forwards a filter verbatim and never validates it, so a mistyped
 * clause "is passed along and quietly does nothing — a successful response
 * with unfiltered results rather than a 400". Set it to exercise the
 * client-side guards that exist precisely because the filter can fail open.
 */
export function matches(
  payload: Record<string, unknown>,
  filter?: Filter,
  failOpenOnMustNot = false,
  pointId?: string | number
): boolean {
  if (!filter) return true;
  const f = filter as unknown as Record<string, Cond[]>;
  const unknown = Object.keys(f).filter(
    k => k !== 'must' && k !== 'mustNot' && k !== 'should'
  );
  if (unknown.length > 0) {
    throw new Error(`unknown filter clause(s): ${unknown.sort().join(', ')}`);
  }
  if (!(f.must ?? []).every(c => matchCondition(payload, c, pointId))) {
    return false;
  }
  if (
    !failOpenOnMustNot &&
    (f.mustNot ?? []).some(c => matchCondition(payload, c, pointId))
  ) {
    return false;
  }
  const should = f.should ?? [];
  if (
    should.length > 0 &&
    !should.some(c => matchCondition(payload, c, pointId))
  ) {
    return false;
  }
  return true;
}

export class FakeVectorsClient {
  readonly workspace: string | undefined;
  /** `null`: outside any workspace (an absent argument is "my-bot"). */
  constructor(workspace: string | null = 'my-bot') {
    this.workspace = workspace ?? undefined;
  }
  readonly collections = new Map<
    string,
    {
      config: VectorConfig;
      points: Map<string | number, Stored>;
      mode: PerformanceMode;
      modeChangedAt: number | null;
    }
  >();
  /** A test advances this to cross the performance-mode cooldown. */
  now = 0;
  readonly indexes: Array<[string, string, unknown]> = [];
  /**
   * Flip to make every read behave as if the mustNot clause had been
   * mistyped: the documented fail-open. See `matches`.
   */
  failOpenOnMustNot = false;

  // -- collections --------------------------------------------------------

  async createCollection(
    name: string,
    vectors: VectorConfigInput,
    options: CreateCollectionOptions = {}
  ): Promise<Collection> {
    if (this.collections.has(name)) throw new Error(`${name} already exists`);
    const config: VectorConfig = {
      size: vectors.size,
      distance: (vectors.distance ?? DistanceMetric.COSINE) as DistanceMetric,
    };
    const mode =
      this.validMode(options.performanceMode) ?? PerformanceMode.EXACT;
    this.checkSuitable(mode, config.size);
    this.collections.set(name, {
      config,
      points: new Map(),
      mode,
      modeChangedAt: null,
    });
    return { name, config, performanceMode: mode } as Collection;
  }

  // vectordb's answers, in the order it gives them: an unknown mode is a 400
  // before anything is read, compact below the floor a 422.
  private validMode(
    value: PerformanceModeInput | undefined
  ): PerformanceMode | undefined {
    if (value === undefined) return undefined;
    if (!(Object.values(PerformanceMode) as string[]).includes(value)) {
      throw new ValidationError(
        'performance_mode must be one of: exact, balanced, fast, compact',
        'performance_mode'
      );
    }
    return value as PerformanceMode;
  }

  private checkSuitable(mode: PerformanceMode, size: number): void {
    if (mode === PerformanceMode.COMPACT && size < COMPACT_MIN_DIMENSIONS) {
      const error = new ValidationError(
        `performance_mode 'compact' needs vectors of at least ${COMPACT_MIN_DIMENSIONS} dimensions; this collection's are ${size}.`,
        'performance_mode'
      );
      error.code = 'PERFORMANCE_MODE_UNSUITABLE';
      throw error;
    }
  }

  async updateCollection(
    name: string,
    options: UpdateCollectionOptions = {}
  ): Promise<boolean> {
    const col = this.collection(name);
    const mode = this.validMode(options.performanceMode);
    if (mode === undefined) return true;
    this.checkSuitable(mode, col.config.size);
    if (mode === col.mode) return true; // a no-op: no cooldown consumed
    if (
      col.modeChangedAt !== null &&
      this.now - col.modeChangedAt < COOLDOWN_SECONDS
    ) {
      const error: AetherfyVectorsError = new ConflictError(
        'The performance mode was changed less than 15 minutes ago.',
        409,
        {
          retry_after_seconds:
            COOLDOWN_SECONDS - (this.now - col.modeChangedAt),
          cooldown_seconds: COOLDOWN_SECONDS,
        }
      );
      error.code = 'PERFORMANCE_MODE_CHANGE_TOO_SOON';
      throw error;
    }
    col.mode = mode;
    col.modeChangedAt = this.now;
    return true;
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(name);
  }

  async getCollection(name: string): Promise<Collection> {
    const col = this.collection(name);
    return {
      name,
      config: col.config,
      points_count: col.points.size,
      status: 'green',
      performanceMode: col.mode,
    } as Collection;
  }

  async getCollections(): Promise<Collection[]> {
    return Promise.all(
      [...this.collections.keys()].map(n => this.getCollection(n))
    );
  }

  async deleteCollection(name: string): Promise<boolean> {
    return this.collections.delete(name);
  }

  async createFieldIndex(
    name: string,
    fieldName: string,
    fieldSchema: unknown = 'keyword'
  ): Promise<boolean> {
    this.indexes.push([name, fieldName, fieldSchema]);
    return true;
  }

  async deleteFieldIndex(name: string, fieldName: string): Promise<boolean> {
    const i = this.indexes.findIndex(x => x[0] === name && x[1] === fieldName);
    if (i >= 0) this.indexes.splice(i, 1);
    return true;
  }

  // -- points -------------------------------------------------------------

  /** The collection, or the error a real server would give for a missing one. */
  private collection(name: string) {
    const col = this.collections.get(name);
    if (!col) throw new Error(`Collection '${name}' not found`);
    return col;
  }

  private points(name: string): Map<string | number, Stored> {
    return this.collection(name).points;
  }

  async upsert(
    name: string,
    points: Array<{
      id: string | number;
      vector?: number[];
      payload?: Record<string, unknown>;
    }>
  ): Promise<boolean> {
    const size = this.collection(name).config.size;
    for (const p of points) {
      if ((p.vector ?? []).length !== size) {
        throw new Error(
          `vector of ${(p.vector ?? []).length} dims into a ${size}-dim collection`
        );
      }
      this.points(name).set(p.id, {
        id: p.id,
        vector: [...(p.vector ?? [])],
        payload: { ...(p.payload ?? {}) },
      });
    }
    return true;
  }

  async delete(
    name: string,
    selector: Array<string | number> | Filter
  ): Promise<boolean> {
    const store = this.points(name);
    if (Array.isArray(selector)) {
      for (const id of selector) store.delete(id);
      return true;
    }
    for (const [id, p] of [...store.entries()]) {
      if (matches(p.payload, selector, false, id)) store.delete(id);
    }
    return true;
  }

  private project(
    p: Stored,
    withPayload: boolean,
    withVectors: boolean
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { id: p.id };
    if (withPayload) out.payload = { ...p.payload };
    if (withVectors) out.vector = [...p.vector];
    return out;
  }

  private selected(name: string, filter?: Filter): Stored[] {
    return [...this.points(name).values()].filter(p =>
      matches(p.payload, filter, this.failOpenOnMustNot, p.id)
    );
  }

  async scroll(
    name: string,
    options: {
      limit?: number;
      offset?: number;
      scrollFilter?: Filter;
      withPayload?: boolean;
      withVectors?: boolean;
    } = {}
  ): Promise<{ points: ScrollPoint[]; nextPageOffset: number | null }> {
    const limit = options.limit ?? 10;
    const start = options.offset ?? 0;
    const sel = this.selected(name, options.scrollFilter);
    const page = sel.slice(start, start + limit);
    return {
      points: page.map(
        p =>
          this.project(
            p,
            options.withPayload ?? true,
            options.withVectors ?? false
          ) as unknown as ScrollPoint
      ),
      nextPageOffset: start + limit < sel.length ? start + limit : null,
    };
  }

  async *scrollIter(
    name: string,
    options: {
      batchSize?: number;
      scrollFilter?: Filter;
      withPayload?: boolean;
      withVectors?: boolean;
    } = {}
  ): AsyncGenerator<ScrollPoint, void, undefined> {
    for (const p of this.selected(name, options.scrollFilter)) {
      yield this.project(
        p,
        options.withPayload ?? true,
        options.withVectors ?? false
      ) as unknown as ScrollPoint;
    }
  }

  async count(
    name: string,
    options: { countFilter?: Filter; exact?: boolean } = {}
  ): Promise<number> {
    return this.selected(name, options.countFilter).length;
  }

  async retrieve(
    name: string,
    ids: Array<string | number>,
    options: { withPayload?: boolean; withVectors?: boolean } = {}
  ): Promise<Point[]> {
    const store = this.points(name);
    return ids.flatMap(i => {
      const stored = store.get(i);
      return stored
        ? [
            this.project(
              stored,
              options.withPayload ?? true,
              options.withVectors ?? false
            ) as unknown as Point,
          ]
        : [];
    });
  }

  async search(
    name: string,
    vector: number[],
    options: {
      limit?: number;
      offset?: number;
      queryFilter?: Filter;
      withPayload?: boolean;
      withVectors?: boolean;
    } = {}
  ): Promise<SearchResult[]> {
    const dot = (p: Stored) =>
      p.vector.reduce((acc, v, i) => acc + v * (vector[i] ?? 0), 0);
    const sel = this.selected(name, options.queryFilter).sort(
      (a, b) => dot(b) - dot(a)
    );
    const start = options.offset ?? 0;
    return sel.slice(start, start + (options.limit ?? 10)).map(
      p =>
        ({
          ...this.project(
            p,
            options.withPayload ?? true,
            options.withVectors ?? false
          ),
          score: dot(p),
        }) as unknown as SearchResult
    );
  }

  // -- misc ---------------------------------------------------------------

  clearSchemaCache(): void {
    /* no cache here */
  }

  async dispose(): Promise<void> {
    /* nothing to release */
  }
}

export function unitVector(size: number, axis = 0): number[] {
  const v = new Array<number>(size).fill(0);
  v[axis] = 1;
  return v;
}

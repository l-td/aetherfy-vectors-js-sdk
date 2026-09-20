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
  Collection,
  DistanceMetric,
  Filter,
  Point,
  ScrollPoint,
  SearchResult,
  VectorConfig,
  VectorConfigInput,
} from '../../src/models';

type Cond = Record<string, any>;

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

function matchCondition(payload: Record<string, unknown>, cond: Cond): boolean {
  if (!('key' in cond)) {
    throw new Error(`unsupported filter condition: ${JSON.stringify(cond)}`);
  }
  const value = lookup(payload, cond.key as string);
  if ('match' in cond) return value === cond.match.value;
  if ('range' in cond) {
    if (typeof value !== 'number') return false;
    const r = cond.range;
    if ('gt' in r && !(value > r.gt)) return false;
    if ('gte' in r && !(value >= r.gte)) return false;
    if ('lt' in r && !(value < r.lt)) return false;
    if ('lte' in r && !(value <= r.lte)) return false;
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
  failOpenOnMustNot = false
): boolean {
  if (!filter) return true;
  const f = filter as unknown as Record<string, Cond[]>;
  const unknown = Object.keys(f).filter(
    k => k !== 'must' && k !== 'mustNot' && k !== 'should'
  );
  if (unknown.length > 0) {
    throw new Error(`unknown filter clause(s): ${unknown.sort().join(', ')}`);
  }
  if (!(f.must ?? []).every(c => matchCondition(payload, c))) return false;
  if (
    !failOpenOnMustNot &&
    (f.mustNot ?? []).some(c => matchCondition(payload, c))
  ) {
    return false;
  }
  const should = f.should ?? [];
  if (should.length > 0 && !should.some(c => matchCondition(payload, c))) {
    return false;
  }
  return true;
}

export class FakeVectorsClient {
  readonly workspace: string | undefined = 'my-bot';
  readonly collections = new Map<
    string,
    { config: VectorConfig; points: Map<string | number, Stored> }
  >();
  readonly indexes: Array<[string, string, unknown]> = [];
  /**
   * Flip to make every read behave as if the mustNot clause had been
   * mistyped: the documented fail-open. See `matches`.
   */
  failOpenOnMustNot = false;

  // -- collections --------------------------------------------------------

  async createCollection(
    name: string,
    vectors: VectorConfigInput
  ): Promise<Collection> {
    if (this.collections.has(name)) throw new Error(`${name} already exists`);
    const config: VectorConfig = {
      size: vectors.size,
      distance: (vectors.distance ?? DistanceMetric.COSINE) as DistanceMetric,
    };
    this.collections.set(name, { config, points: new Map() });
    return { name, config } as Collection;
  }

  async collectionExists(name: string): Promise<boolean> {
    return this.collections.has(name);
  }

  async getCollection(name: string): Promise<Collection> {
    const col = this.collections.get(name)!;
    return {
      name,
      config: col.config,
      points_count: col.points.size,
      status: 'green',
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

  private points(name: string): Map<string | number, Stored> {
    return this.collections.get(name)!.points;
  }

  async upsert(
    name: string,
    points: Array<{
      id: string | number;
      vector?: number[];
      payload?: Record<string, unknown>;
    }>
  ): Promise<boolean> {
    const size = this.collections.get(name)!.config.size;
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
      if (matches(p.payload, selector)) store.delete(id);
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
      matches(p.payload, filter, this.failOpenOnMustNot)
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
    return ids
      .filter(i => store.has(i))
      .map(
        i =>
          this.project(
            store.get(i)!,
            options.withPayload ?? true,
            options.withVectors ?? false
          ) as unknown as Point
      );
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

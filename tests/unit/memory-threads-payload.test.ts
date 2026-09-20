/**
 * Threads are payload rows in one collection, not a collection each.
 *
 * These tests run the memory layer against `fake-vectors-store`, a double that
 * actually stores points and actually evaluates filters. That matters here:
 * every claim in this file — a thread is isolated from its siblings, an empty
 * thread exists, a caller's filter cannot widen the scope, `clear()` does not
 * take the neighbours with it — is a claim about what the FILTER does, and a
 * recorded-call assertion would only prove which filter was sent.
 *
 * The headline case is "more threads than the plan allows collections": the
 * defect this model change exists to remove.
 *
 * Parity file with the Python SDK's tests/test_memory_threads_payload.py.
 */

import { AetherfyVectorsClient } from '../../src/client';
import { PointNotFoundError } from '../../src/exceptions';
import {
  DEFAULT_VECTOR_SIZE,
  MemoryClient,
  Thread,
  THREAD_ID_KEY,
  THREAD_MARKER_KEY,
  THREADS_COLLECTION,
  ThreadAlreadyExistsError,
  ThreadNotFoundError,
  ThreadVectorSizeMismatchError,
} from '../../src/memory';
import { DistanceMetric } from '../../src/models';
import { FakeVectorsClient, unitVector } from './fake-vectors-store';

const DIM = 4;

function build(): { store: FakeVectorsClient; memory: MemoryClient } {
  const store = new FakeVectorsClient();
  const memory = new MemoryClient({
    client: store as unknown as AetherfyVectorsClient,
    threadVectorSize: DIM,
  });
  return { store, memory };
}

const v = (axis = 0) => unitVector(DIM, axis);

async function msgs(thread: Thread, n: number, prefix = 'm') {
  const ids: Array<string | number> = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      await thread.add({
        role: 'user',
        content: `${prefix}${i}`,
        vector: v(),
        ts: i,
      })
    );
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The defect this change removes
// ---------------------------------------------------------------------------

describe('the cross-repo pin', () => {
  it('the threads collection name is the pinned literal', () => {
    // The e2e suite hard-codes "__threads__" on purpose: a cross-repo
    // literal should be a literal there, so a rename is caught rather than
    // followed. This is the other half of that pin. Without it a rename goes
    // green here and reds in a repo that cannot explain why — so the gate
    // lives where the rename would happen.
    expect(THREADS_COLLECTION).toBe('__threads__');
    expect(THREAD_ID_KEY).toBe('thread_id');
    expect(THREAD_MARKER_KEY).toBe('thread_marker');
  });
});

describe('threads do not consume collections', () => {
  it('supports more threads than the plan allows collections', async () => {
    // A Free plan allows three collections. It must not cap conversations.
    // Under the old model every thread was its own collection, so the fourth
    // createThread on a Free account returned COLLECTION_LIMIT_EXCEEDED (and
    // fired the "you hit your plan limit" email). Ten threads here, and the
    // collection count does not move.
    const { store, memory } = build();
    for (let i = 0; i < 10; i++) await memory.createThread(`conv-${i}`);

    const cols = await store.getCollections();
    expect(cols.map(c => c.name)).toEqual([THREADS_COLLECTION]);
    expect((await memory.listThreads()).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `conv-${i}`).sort()
    );
    await expect(memory.listNamespaces()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// An empty thread exists
// ---------------------------------------------------------------------------

describe('an empty thread', () => {
  it('exists, lists, and holds no messages', async () => {
    const { memory } = build();
    await memory.createThread('empty');
    await expect(memory.threadExists('empty')).resolves.toBe(true);
    await expect(memory.listThreads()).resolves.toEqual(['empty']);
    const t = await memory.thread('empty');
    await expect(t.count()).resolves.toBe(0);
    await expect(t.history()).resolves.toEqual([]);
  });

  it('still refuses a second create', async () => {
    const { memory } = build();
    await memory.createThread('empty');
    await expect(memory.createThread('empty')).rejects.toThrow(
      ThreadAlreadyExistsError
    );
  });

  it('a thread that was never created does not exist', async () => {
    const { memory } = build();
    await expect(memory.threadExists('never')).resolves.toBe(false);
    await expect(memory.thread('never')).rejects.toThrow(ThreadNotFoundError);
    await expect(memory.deleteThread('never')).resolves.toBe(false);
  });

  it('a second marker does not list the thread twice', async () => {
    // Creating a thread is a check-then-write, so it can lose a race: two
    // callers that both pass the exists-check before either marker lands both
    // write one. Every other read tolerates that — threadExists counts, count
    // and history exclude markers, deleteThread removes every row with the id
    // — but listThreads reads the id off each marker, so without
    // de-duplication it reported the thread twice. Replays the losing
    // caller's write directly, since the race itself is not reproducible
    // in-process.
    const { store, memory } = build();
    await memory.createThread('a');
    await store.upsert(THREADS_COLLECTION, [
      {
        id: '00000000-0000-4000-8000-0000000000ff',
        vector: v(),
        payload: { [THREAD_ID_KEY]: 'a', [THREAD_MARKER_KEY]: true },
      },
    ]);

    await expect(memory.listThreads()).resolves.toEqual(['a']);
    // ...and nothing else was disturbed.
    await expect(memory.threadExists('a')).resolves.toBe(true);
    await expect((await memory.thread('a')).count()).resolves.toBe(0);
    await expect(memory.deleteThread('a')).resolves.toBe(true);
    await expect(memory.listThreads()).resolves.toEqual([]);
  });

  it('listThreads keeps first-seen order', async () => {
    const { memory } = build();
    for (const name of ['zeta', 'alpha', 'mid']) {
      await memory.createThread(name);
    }
    await expect(memory.listThreads()).resolves.toEqual([
      'zeta',
      'alpha',
      'mid',
    ]);
  });

  it('the marker carries a unit vector, not a zero vector', async () => {
    const { store, memory } = build();
    await memory.createThread('conv-1');
    const [marker] = [
      ...store.collections.get(THREADS_COLLECTION)!.points.values(),
    ];
    expect(marker!.payload[THREAD_MARKER_KEY]).toBe(true);
    expect(marker!.vector.reduce((a, b) => a + b * b, 0)).toBeCloseTo(1);
  });
});

// ---------------------------------------------------------------------------
// Isolation between threads
// ---------------------------------------------------------------------------

describe('isolation between threads', () => {
  async function twoThreads() {
    const { store, memory } = build();
    const a = await memory.createThread('a');
    const b = await memory.createThread('b');
    return { store, memory, a, b };
  }

  it('history returns only this thread messages', async () => {
    const { a, b } = await twoThreads();
    await msgs(a, 3, 'a');
    await msgs(b, 2, 'b');
    expect((await a.history()).map(m => m.content)).toEqual(['a0', 'a1', 'a2']);
    expect((await b.history()).map(m => m.content)).toEqual(['b0', 'b1']);
  });

  it('iterHistory returns only this thread messages', async () => {
    const { a, b } = await twoThreads();
    await msgs(a, 3, 'a');
    await msgs(b, 2, 'b');
    const out: string[] = [];
    for await (const m of a.iterHistory()) out.push(m.content);
    expect(out).toEqual(['a0', 'a1', 'a2']);
  });

  it('search returns only this thread messages', async () => {
    const { a, b } = await twoThreads();
    await msgs(a, 2, 'a');
    await msgs(b, 2, 'b');
    const hits = await a.search(v(), { limit: 50 });
    expect(new Set(hits.map(h => h.payload?.content))).toEqual(
      new Set(['a0', 'a1'])
    );
  });

  it('count and iter return only this thread messages', async () => {
    const { a, b } = await twoThreads();
    await msgs(a, 3, 'a');
    await msgs(b, 7, 'b');
    await expect(a.count()).resolves.toBe(3);
    await expect(b.count()).resolves.toBe(7);
    const seen: unknown[] = [];
    for await (const p of a.iter()) seen.push(p.payload?.content);
    expect(new Set(seen)).toEqual(new Set(['a0', 'a1', 'a2']));
  });

  it('retrieve will not reach into a sibling thread', async () => {
    const { a, b } = await twoThreads();
    const [aId] = await msgs(a, 1, 'a');
    const [bId] = await msgs(b, 1, 'b');
    expect((await a.retrieve([aId!])).map(p => p.id)).toEqual([aId]);
    await expect(a.retrieve([bId!])).resolves.toEqual([]);
  });

  it('retrieve without payload still scopes and still omits the payload', async () => {
    const { a, b } = await twoThreads();
    const [aId] = await msgs(a, 1, 'a');
    const [bId] = await msgs(b, 1, 'b');
    const got = await a.retrieve([aId!, bId!], { withPayload: false });
    expect(got.map(p => p.id)).toEqual([aId]);
    expect(got[0]).not.toHaveProperty('payload');
  });

  it('delete by id will not reach into a sibling thread', async () => {
    const { a, b } = await twoThreads();
    const [bId] = await msgs(b, 1, 'b');
    await a.delete([bId!]);
    await expect(b.count()).resolves.toBe(1);
  });

  it('delete by id scopes server-side in one request', async () => {
    // The thread clause travels WITH the ids, so the engine enforces the
    // boundary. A client-side check first would be a second round trip and
    // a rule the next caller could step around.
    const { store, memory } = build();
    const a = await memory.createThread('a');
    const [keep, drop] = await msgs(a, 2, 'a');

    const sent: unknown[] = [];
    const realDelete = store.delete.bind(store);
    store.delete = async (name, sel) => {
      sent.push(sel);
      return realDelete(name, sel);
    };
    await a.delete([drop!]);

    expect(sent).toHaveLength(1);
    const selector = sent[0] as { must: unknown[]; mustNot: unknown[] };
    expect(selector.must[0]).toEqual({
      key: THREAD_ID_KEY,
      match: { value: 'a' },
    });
    expect(selector.must[1]).toEqual({ has_id: [drop] });
    const left: unknown[] = [];
    for await (const p of a.iter()) left.push(p.id);
    expect(left).toEqual([keep]);
  });

  it('delete with an empty id list sends no request', async () => {
    // A behaviour change, pinned because it is one. It used to send a
    // delete carrying an empty points list. It now returns true without a
    // request, and for a Thread that is a SAFETY property rather than a
    // saved round trip: an id list becomes a `has_id` clause, and a request
    // carrying an empty `has_id` is one engine-side semantic away from
    // matching the whole thread.
    const { store, memory } = build();
    const a = await memory.createThread('a');
    await msgs(a, 3, 'a');

    const sent: unknown[] = [];
    const realDelete = store.delete.bind(store);
    store.delete = async (name, sel) => {
      sent.push(sel);
      return realDelete(name, sel);
    };

    await expect(a.delete([])).resolves.toBe(true);
    expect(sent).toEqual([]);
    await expect(a.count()).resolves.toBe(3);
  });

  it('namespace delete with an empty id list sends no request', async () => {
    const { store, memory } = build();
    const ns = await memory.createNamespace('kb', { vectorSize: DIM });
    await ns.add({ text: 'x', vector: v() });

    const sent: unknown[] = [];
    const realDelete = store.delete.bind(store);
    store.delete = async (name, sel) => {
      sent.push(sel);
      return realDelete(name, sel);
    };

    await expect(ns.delete([])).resolves.toBe(true);
    expect(sent).toEqual([]);
    await expect(ns.count()).resolves.toBe(1);
  });

  it('metadata writes still throw rather than silently no-op', async () => {
    // Why the metadata writers keep their read. The payload endpoints
    // accept a filter, so these could scope themselves the way delete()
    // does. They do not, because a filter that matches nothing is a
    // SUCCESS, and these are documented to throw PointNotFoundError when
    // the point is not there. Scoping them by filter would turn a write to
    // a missing id into a silent no-op reported as success. delete() has no
    // such contract to lose.
    const { memory } = build();
    const a = await memory.createThread('a');
    await expect(
      a.mergeMetadata('00000000-0000-4000-8000-0000000000aa', { x: 1 })
    ).rejects.toThrow(PointNotFoundError);
  });

  it('metadata writes will not reach into a sibling thread', async () => {
    const { a, b } = await twoThreads();
    const [bId] = await msgs(b, 1, 'b');
    await expect(a.setMetadata(bId!, { x: 1 })).rejects.toThrow(
      PointNotFoundError
    );
    await expect(a.mergeMetadata(bId!, { x: 1 })).rejects.toThrow(
      PointNotFoundError
    );
    await expect(a.deleteMetadataKeys(bId!, ['x'])).rejects.toThrow(
      PointNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// Markers never read as messages
// ---------------------------------------------------------------------------

describe('markers never read as messages', () => {
  /**
   * Make every read behave as if the marker exclusion had been mistyped.
   *
   * The docs are explicit that a filter is forwarded verbatim and a key the
   * engine does not recognise "is passed along and quietly does nothing", so
   * the server-side exclusion is not a guarantee. Stamping a `ts` on the
   * marker removes the one incidental reason it would be dropped, leaving
   * only the client-side guard under test.
   */
  function failOpenWithAStampedMarker(store: FakeVectorsClient) {
    store.failOpenOnMustNot = true;
    for (const p of store.collections
      .get(THREADS_COLLECTION)!
      .points.values()) {
      if (p.payload[THREAD_MARKER_KEY]) p.payload.ts = 99;
    }
  }

  it('the marker never surfaces in history', async () => {
    const { store, memory } = build();
    const a = await memory.createThread('a');
    await msgs(a, 2, 'a');
    expect((await a.history()).map(m => m.content)).toEqual(['a0', 'a1']);
    failOpenWithAStampedMarker(store);
    expect((await a.history()).map(m => m.content)).toEqual(['a0', 'a1']);
  });

  it('the marker never surfaces in iterHistory', async () => {
    const { store, memory } = build();
    const a = await memory.createThread('a');
    await msgs(a, 2, 'a');
    const read = async () => {
      const out: string[] = [];
      for await (const m of a.iterHistory()) out.push(m.content);
      return out;
    };
    expect(await read()).toEqual(['a0', 'a1']);
    failOpenWithAStampedMarker(store);
    expect(await read()).toEqual(['a0', 'a1']);
  });

  it('the marker never surfaces in search', async () => {
    const { memory } = build();
    const a = await memory.createThread('a');
    await msgs(a, 1, 'a');
    const hits = await a.search(v(), { limit: 50 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.payload?.content).toBe('a0');
  });

  it('the marker is not counted and not iterated', async () => {
    const { memory } = build();
    const a = await memory.createThread('a');
    await msgs(a, 3, 'a');
    await expect(a.count()).resolves.toBe(3);
    const seen: unknown[] = [];
    for await (const p of a.iter()) seen.push(p.id);
    expect(seen).toHaveLength(3);
  });

  it('a filtered delete leaves the thread in existence', async () => {
    const { memory } = build();
    const a = await memory.createThread('a');
    await msgs(a, 2, 'a');
    await a.delete({ must: [{ key: 'role', match: { value: 'user' } }] });
    await expect(a.count()).resolves.toBe(0);
    // The marker survived a message delete, so the thread still exists.
    await expect(memory.threadExists('a')).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A caller filter is COMBINED with the thread clause, never substituted
// ---------------------------------------------------------------------------

describe('a caller filter cannot widen the scope', () => {
  async function twoThreads() {
    const { store, memory } = build();
    const a = await memory.createThread('a');
    const b = await memory.createThread('b');
    await msgs(a, 1, 'a');
    await msgs(b, 1, 'b');
    return { store, memory, a, b };
  }

  it('a must clause naming another thread matches nothing here', async () => {
    const { a, b } = await twoThreads();
    // A filter that, on its own, would match every point of thread b.
    const widen = { must: [{ key: THREAD_ID_KEY, match: { value: 'b' } }] };

    await expect(a.search(v(), { limit: 50, filter: widen })).resolves.toEqual(
      []
    );
    await expect(a.count({ filter: widen })).resolves.toBe(0);
    const iterated: unknown[] = [];
    for await (const p of a.iter({ filter: widen })) iterated.push(p.id);
    expect(iterated).toEqual([]);

    await a.delete(widen);
    await expect(b.count()).resolves.toBe(1);
  });

  it('a should clause cannot widen the scope', async () => {
    const { a } = await twoThreads();
    const widen = { should: [{ key: THREAD_ID_KEY, match: { value: 'b' } }] };
    await expect(a.count({ filter: widen })).resolves.toBe(0);
  });

  it('a caller filter still narrows', async () => {
    const { memory } = build();
    const a = await memory.createThread('a');
    await a.add({ role: 'user', content: 'keep', vector: v(), ts: 1 });
    await a.add({ role: 'assistant', content: 'drop', vector: v(), ts: 2 });
    const narrowed = await a.search(v(), {
      limit: 50,
      filter: { must: [{ key: 'role', match: { value: 'user' } }] },
    });
    expect(narrowed.map(h => h.payload?.content)).toEqual(['keep']);
  });

  it('a caller clause typo still fails loudly', async () => {
    const { a } = await twoThreads();
    await expect(
      a.count({
        filter: {
          must_not: [{ key: 'role', match: { value: 'user' } }],
        } as never,
      })
    ).rejects.toThrow('must_not');
  });
});

// ---------------------------------------------------------------------------
// clear() and deleteThread()
// ---------------------------------------------------------------------------

describe('clear and deleteThread', () => {
  it('clear leaves a sibling thread points intact', async () => {
    const { memory } = build();
    const a = await memory.createThread('a');
    const b = await memory.createThread('b');
    await msgs(a, 3, 'a');
    await msgs(b, 4, 'b');

    await a.clear();

    // The sibling is untouched — messages AND its existence.
    await expect(b.count()).resolves.toBe(4);
    expect((await b.history()).map(m => m.content)).toEqual([
      'b0',
      'b1',
      'b2',
      'b3',
    ]);
    await expect(memory.threadExists('b')).resolves.toBe(true);
    // ...and the cleared thread is gone, the way clear() has always meant.
    await expect(memory.threadExists('a')).resolves.toBe(false);
  });

  it('clear does not drop the shared collection', async () => {
    const { store, memory } = build();
    const a = await memory.createThread('a');
    await memory.createThread('b');
    await a.clear();
    expect(store.collections.has(THREADS_COLLECTION)).toBe(true);
  });

  it('deleteThread leaves a sibling thread points intact', async () => {
    const { memory } = build();
    const a = await memory.createThread('a');
    const b = await memory.createThread('b');
    await msgs(a, 3, 'a');
    await msgs(b, 4, 'b');

    await expect(memory.deleteThread('a')).resolves.toBe(true);
    await expect(memory.threadExists('a')).resolves.toBe(false);
    await expect(b.count()).resolves.toBe(4);
    await expect(memory.listThreads()).resolves.toEqual(['b']);
  });

  it('a cleared thread can be created again', async () => {
    const { memory } = build();
    const a = await memory.createThread('a');
    await msgs(a, 2, 'a');
    await a.clear();
    const again = await memory.createThread('a');
    await expect(again.count()).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getThread / namespaces / schema surface
// ---------------------------------------------------------------------------

describe('getThread, namespaces and the schema surface', () => {
  it('getThread counts this thread, not the collection', async () => {
    const { memory } = build();
    const a = await memory.createThread('a');
    const b = await memory.createThread('b');
    await msgs(a, 3, 'a');
    await msgs(b, 9, 'b');

    const info = await memory.getThread('a');
    expect(info.name).toBe('a');
    expect(info.points_count).toBe(3);
    expect(info.config.size).toBe(DIM);
  });

  it('namespaces are unaffected and still one collection each', async () => {
    const { store, memory } = build();
    await memory.createNamespace('kb', { vectorSize: DIM });
    await memory.createThread('a');
    await expect(memory.listNamespaces()).resolves.toEqual(['kb']);
    expect([...store.collections.keys()].sort()).toEqual(
      [THREADS_COLLECTION, 'kb'].sort()
    );
  });

  it('namespace clear still drops its own collection', async () => {
    const { store, memory } = build();
    const ns = await memory.createNamespace('kb', { vectorSize: DIM });
    await ns.clear();
    expect(store.collections.has('kb')).toBe(false);
  });

  it('a thread has no collection-level schema surface', async () => {
    // A schema belongs to a collection, and a Thread no longer has one to
    // itself: setSchema on one thread would have imposed a schema on every
    // other thread in the workspace. Removed rather than left lying.
    const { memory } = build();
    const a = await memory.createThread('a');
    for (const gone of [
      'getSchema',
      'setSchema',
      'deleteSchema',
      'analyzeSchema',
      'refreshSchema',
      'clearSchemaCache',
    ]) {
      expect((a as unknown as Record<string, unknown>)[gone]).toBeUndefined();
    }
  });

  it('a namespace keeps the schema surface', async () => {
    const { memory } = build();
    const ns = await memory.createNamespace('kb', { vectorSize: DIM });
    for (const kept of [
      'getSchema',
      'setSchema',
      'deleteSchema',
      'analyzeSchema',
      'refreshSchema',
      'clearSchemaCache',
    ]) {
      expect(typeof (ns as unknown as Record<string, unknown>)[kept]).toBe(
        'function'
      );
    }
  });

  it('the threads collection indexes both filtered keys', async () => {
    const { store, memory } = build();
    await memory.createThread('a');
    expect(store.indexes).toEqual([
      [THREADS_COLLECTION, THREAD_ID_KEY, 'keyword'],
      [THREADS_COLLECTION, THREAD_MARKER_KEY, 'bool'],
    ]);
  });

  it('an unreadable dimension is not treated as a mismatch', async () => {
    // 0/undefined means UNKNOWN, not "a zero-dimension collection": it is
    // what a response carrying no vectors config leaves behind. Comparing it
    // would report a mismatch that is really "we could not read it". The skip
    // is explicit in the code for exactly this reason; this pins that it
    // stays a skip and not a silently-passing check.
    const { store, memory } = build();
    await memory.createThread('first');

    store.getCollection = async (name: string) =>
      ({ name, config: { size: 0, distance: DistanceMetric.COSINE } }) as never;
    // No ThreadVectorSizeMismatchError: there is nothing to compare against.
    await memory.createThread('second');
    expect((await memory.listThreads()).sort()).toEqual(['first', 'second']);
  });

  it('a readable mismatch still throws', async () => {
    const { store, memory } = build();
    await memory.createThread('first');
    store.getCollection = async (name: string) =>
      ({
        name,
        config: { size: 1536, distance: DistanceMetric.COSINE },
      }) as never;
    await expect(memory.createThread('second')).rejects.toThrow(
      ThreadVectorSizeMismatchError
    );
  });

  it('the client default dimension is still 384', async () => {
    const store = new FakeVectorsClient();
    const m = new MemoryClient({
      client: store as unknown as AetherfyVectorsClient,
    });
    await m.createThread('a');
    expect(store.collections.get(THREADS_COLLECTION)!.config.size).toBe(
      DEFAULT_VECTOR_SIZE
    );
  });
});

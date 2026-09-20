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
} from '../../src/memory';
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

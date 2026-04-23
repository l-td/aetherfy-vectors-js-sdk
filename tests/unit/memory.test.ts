/**
 * Unit tests for the Aetherfy Memory SDK (MemoryClient, Namespace, Thread).
 *
 * MemoryClient delegates every operation to an underlying
 * AetherfyVectorsClient, so these tests build a jest mock of that client
 * and verify MemoryClient produces the right calls and enforces its own
 * contracts:
 *
 * - Namespace/thread lifecycle (create, list, exists, get, delete)
 * - Required-scope rule (no root-level add/search)
 * - Required-create rule (add/search before create → error)
 * - Thread-prefix isolation via the name regex
 * - Collection naming convention (__thread__<id> for threads)
 * - Forward-compat error when vector is omitted
 * - Operations parity (search/retrieve/delete/count/schema/analytics)
 * - Thread.history() ordering
 */

import {
  MemoryClient,
  Namespace,
  Thread,
  DEFAULT_VECTOR_SIZE,
  EmbeddingNotSupportedError,
  InvalidNameError,
  NamespaceAlreadyExistsError,
  NamespaceNotFoundError,
  ThreadAlreadyExistsError,
  ThreadNotFoundError,
} from '../../src/memory';
import { AetherfyVectorsClient } from '../../src/client';
import { Collection, DistanceMetric, VectorConfig } from '../../src/models';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeCollection(
  name: string,
  extra: Partial<Collection> = {}
): Collection {
  const config: VectorConfig = {
    size: DEFAULT_VECTOR_SIZE,
    distance: DistanceMetric.COSINE,
  };
  return { name, config, ...extra } as Collection;
}

type MockedClient = jest.Mocked<AetherfyVectorsClient>;

function buildMockClient(): MockedClient {
  const mock = {
    workspace: 'my-bot',
    createCollection: jest.fn().mockResolvedValue(fakeCollection('x')),
    deleteCollection: jest.fn().mockResolvedValue(true),
    getCollections: jest.fn().mockResolvedValue([]),
    collectionExists: jest.fn().mockResolvedValue(false),
    getCollection: jest.fn(),
    upsert: jest.fn().mockResolvedValue(true),
    delete: jest.fn().mockResolvedValue(true),
    retrieve: jest.fn().mockResolvedValue([]),
    search: jest.fn().mockResolvedValue([]),
    scroll: jest.fn().mockResolvedValue({ points: [], nextPageOffset: null }),
    count: jest.fn().mockResolvedValue(0),
    getSchema: jest.fn().mockResolvedValue(null),
    setSchema: jest.fn().mockResolvedValue('etag-1'),
    deleteSchema: jest.fn().mockResolvedValue(true),
    analyzeSchema: jest.fn(),
    refreshSchema: jest.fn(),
    clearSchemaCache: jest.fn(),
    getPerformanceAnalytics: jest.fn(),
    getCollectionAnalytics: jest.fn(),
    getUsageStats: jest.fn(),
    dispose: jest.fn().mockResolvedValue(undefined),
  } as unknown as MockedClient;
  return mock;
}

function newMemory(mock: MockedClient): MemoryClient {
  return new MemoryClient({ client: mock });
}

// ---------------------------------------------------------------------------
// Construction / introspection
// ---------------------------------------------------------------------------

describe('MemoryClient construction', () => {
  it('surfaces workspace from the underlying client', () => {
    const mock = buildMockClient();
    const m = newMemory(mock);
    expect(m.workspace).toBe('my-bot');
  });

  it('exposes the underlying vectors client as an escape hatch', () => {
    const mock = buildMockClient();
    const m = newMemory(mock);
    expect(m.vectors).toBe(mock);
  });
});

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

describe('name validation', () => {
  const invalidNames = [
    '',
    '-leading-dash',
    '_leading-underscore',
    '.leading-dot',
    'has/slash',
    'has space',
    'has:colon',
    'has\\backslash',
  ];

  it.each(invalidNames)('rejects invalid namespace name: %s', async name => {
    const m = newMemory(buildMockClient());
    await expect(m.createNamespace(name)).rejects.toThrow(InvalidNameError);
  });

  const validNames = [
    'a',
    'customer-42',
    'customer_42',
    'customer.42',
    'CustomerNotes',
    '1facts',
    'scrape-log-v2',
  ];

  it.each(validNames)('accepts valid namespace name: %s', async name => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    const ns = await m.createNamespace(name);
    expect(ns.name).toBe(name);
    expect(mock.createCollection).toHaveBeenCalledTimes(1);
  });

  it('rejects thread prefix via the name regex (unreachable reserved path)', async () => {
    const m = newMemory(buildMockClient());
    await expect(m.createNamespace('__thread__foo')).rejects.toThrow(
      InvalidNameError
    );
    await expect(m.namespace('__thread__foo')).rejects.toThrow(
      InvalidNameError
    );
    await expect(m.deleteNamespace('__thread__foo')).rejects.toThrow(
      InvalidNameError
    );
  });

  it('rejects non-string names with InvalidNameError', async () => {
    const m = newMemory(buildMockClient());
    await expect(m.createNamespace(123 as unknown as string)).rejects.toThrow(
      InvalidNameError
    );
  });
});

// ---------------------------------------------------------------------------
// Namespace lifecycle
// ---------------------------------------------------------------------------

describe('Namespace lifecycle', () => {
  it('createNamespace uses default vector size and cosine', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);

    await m.createNamespace('customer-42');

    const call = mock.createCollection.mock.calls[0];
    expect(call[0]).toBe('customer-42');
    expect(call[1]).toEqual({
      size: DEFAULT_VECTOR_SIZE,
      distance: DistanceMetric.COSINE,
    });
  });

  it('createNamespace accepts custom dimension and distance', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);

    await m.createNamespace('customer-42', {
      vectorSize: 1536,
      distance: DistanceMetric.DOT,
    });

    const call = mock.createCollection.mock.calls[0];
    expect(call[1]).toEqual({ size: 1536, distance: DistanceMetric.DOT });
  });

  it('createNamespace throws when already exists', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const m = newMemory(mock);

    await expect(m.createNamespace('customer-42')).rejects.toThrow(
      NamespaceAlreadyExistsError
    );
    expect(mock.createCollection).not.toHaveBeenCalled();
  });

  it('namespace() requires prior create', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await expect(m.namespace('customer-42')).rejects.toThrow(
      NamespaceNotFoundError
    );
  });

  it('namespace() returns handle when exists', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const m = newMemory(mock);
    const ns = await m.namespace('customer-42');
    expect(ns).toBeInstanceOf(Namespace);
    expect(ns.name).toBe('customer-42');
  });

  it('listNamespaces excludes threads', async () => {
    const mock = buildMockClient();
    mock.getCollections.mockResolvedValue([
      fakeCollection('customer-42'),
      fakeCollection('scrape-log'),
      fakeCollection('__thread__conv-99'),
      fakeCollection('__thread__conv-100'),
    ]);
    const m = newMemory(mock);
    await expect(m.listNamespaces()).resolves.toEqual([
      'customer-42',
      'scrape-log',
    ]);
  });

  it('deleteNamespace is idempotent', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await expect(m.deleteNamespace('does-not-exist')).resolves.toBe(false);
    expect(mock.deleteCollection).not.toHaveBeenCalled();
  });

  it('deleteNamespace drops the collection', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    mock.deleteCollection.mockResolvedValue(true);
    const m = newMemory(mock);
    await expect(m.deleteNamespace('customer-42')).resolves.toBe(true);
    expect(mock.deleteCollection).toHaveBeenCalledWith('customer-42');
  });

  it('namespaceExists delegates to collectionExists', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const m = newMemory(mock);
    await expect(m.namespaceExists('customer-42')).resolves.toBe(true);
    expect(mock.collectionExists).toHaveBeenCalledWith('customer-42');
  });

  it('getNamespace returns metadata', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const info = fakeCollection('customer-42', { pointsCount: 123 });
    mock.getCollection.mockResolvedValue(info);
    const m = newMemory(mock);
    const returned = await m.getNamespace('customer-42');
    expect(returned.name).toBe('customer-42');
    expect(returned.pointsCount).toBe(123);
    expect(mock.getCollection).toHaveBeenCalledWith('customer-42');
  });

  it('getNamespace throws when missing', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await expect(m.getNamespace('missing')).rejects.toThrow(
      NamespaceNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// Thread lifecycle
// ---------------------------------------------------------------------------

describe('Thread lifecycle', () => {
  it('createThread uses the reserved collection prefix', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await m.createThread('conv-99');
    expect(mock.createCollection.mock.calls[0][0]).toBe('__thread__conv-99');
  });

  it('createThread throws when already exists', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const m = newMemory(mock);
    await expect(m.createThread('conv-99')).rejects.toThrow(
      ThreadAlreadyExistsError
    );
  });

  it('thread() requires prior create', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await expect(m.thread('conv-99')).rejects.toThrow(ThreadNotFoundError);
  });

  it('thread() returns handle when exists', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const m = newMemory(mock);
    const t = await m.thread('conv-99');
    expect(t).toBeInstanceOf(Thread);
    expect(t.id).toBe('conv-99');
  });

  it('getThread strips the internal prefix from the returned name', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    mock.getCollection.mockResolvedValue(
      fakeCollection('__thread__conv-99', { pointsCount: 42 })
    );
    const m = newMemory(mock);
    const returned = await m.getThread('conv-99');
    expect(returned.name).toBe('conv-99');
    expect(returned.pointsCount).toBe(42);
    expect(mock.getCollection).toHaveBeenCalledWith('__thread__conv-99');
  });

  it('getThread throws when missing', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await expect(m.getThread('nope')).rejects.toThrow(ThreadNotFoundError);
  });

  it('listThreads strips the prefix', async () => {
    const mock = buildMockClient();
    mock.getCollections.mockResolvedValue([
      fakeCollection('customer-42'),
      fakeCollection('__thread__conv-99'),
      fakeCollection('__thread__conv-100'),
    ]);
    const m = newMemory(mock);
    await expect(m.listThreads()).resolves.toEqual(['conv-99', 'conv-100']);
  });

  it('deleteThread drops the prefixed collection', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    mock.deleteCollection.mockResolvedValue(true);
    const m = newMemory(mock);
    await m.deleteThread('conv-99');
    expect(mock.deleteCollection).toHaveBeenCalledWith('__thread__conv-99');
  });

  it('deleteThread is idempotent when missing', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await expect(m.deleteThread('missing')).resolves.toBe(false);
    expect(mock.deleteCollection).not.toHaveBeenCalled();
  });

  it('threadExists checks the prefixed collection', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const m = newMemory(mock);
    await expect(m.threadExists('conv-99')).resolves.toBe(true);
    expect(mock.collectionExists).toHaveBeenCalledWith('__thread__conv-99');
  });
});

// ---------------------------------------------------------------------------
// Namespace operations
// ---------------------------------------------------------------------------

describe('Namespace operations', () => {
  async function openNs(mock: MockedClient): Promise<Namespace> {
    mock.collectionExists.mockResolvedValue(true);
    return newMemory(mock).namespace('customer-42');
  }

  it('add without vector raises EmbeddingNotSupportedError', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await expect(ns.add({ text: 'x' })).rejects.toThrow(
      EmbeddingNotSupportedError
    );
    expect(mock.upsert).not.toHaveBeenCalled();
  });

  it('add writes a point with vector and nested metadata', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    const pid = await ns.add({
      text: 'Lives in NYC',
      vector: [0.1, 0.2, 0.3],
      metadata: { kind: 'pref' },
    });

    expect(mock.upsert).toHaveBeenCalledTimes(1);
    const [coll, points] = mock.upsert.mock.calls[0];
    expect(coll).toBe('customer-42');
    expect(points).toHaveLength(1);
    expect(points[0].id).toBe(pid);
    expect(points[0].vector).toEqual([0.1, 0.2, 0.3]);
    expect(points[0].payload).toEqual({
      text: 'Lives in NYC',
      metadata: { kind: 'pref' },
    });
  });

  it('add respects a custom id', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.add({ id: 'fixed-id-1', text: 'x', vector: [0.1] });
    expect(mock.upsert.mock.calls[0][1][0].id).toBe('fixed-id-1');
  });

  it('search delegates with translated options', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.search([0.1, 0.2], { limit: 5, filter: { must: [] } });
    const call = mock.search.mock.calls[0];
    expect(call[0]).toBe('customer-42');
    expect(call[1]).toEqual([0.1, 0.2]);
    expect(call[2]).toMatchObject({ limit: 5, queryFilter: { must: [] } });
  });

  it('count delegates', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.count({ filter: { must: [] }, exact: true });
    expect(mock.count).toHaveBeenCalledWith('customer-42', {
      countFilter: { must: [] },
      exact: true,
    });
  });

  it('retrieve delegates', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.retrieve(['a', 'b'], { withVectors: true });
    expect(mock.retrieve).toHaveBeenCalledWith('customer-42', ['a', 'b'], {
      withPayload: undefined,
      withVectors: true,
    });
  });

  it('delete delegates', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.delete(['a', 'b']);
    expect(mock.delete).toHaveBeenCalledWith('customer-42', ['a', 'b']);
  });

  it('clear drops the collection', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.clear();
    expect(mock.deleteCollection).toHaveBeenCalledWith('customer-42');
  });

  it('getSchema delegates', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.getSchema();
    expect(mock.getSchema).toHaveBeenCalledWith('customer-42');
  });

  it('setSchema forwards schema, enforcement, description', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    const schema = { fields: {} } as unknown as Parameters<
      typeof ns.setSchema
    >[0];
    await ns.setSchema(schema, { enforcement: 'warn', description: 'note' });
    expect(mock.setSchema).toHaveBeenCalledWith(
      'customer-42',
      schema,
      'warn',
      'note'
    );
  });

  it('setSchema defaults enforcement to strict', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    const schema = { fields: {} } as unknown as Parameters<
      typeof ns.setSchema
    >[0];
    await ns.setSchema(schema);
    expect(mock.setSchema).toHaveBeenCalledWith(
      'customer-42',
      schema,
      'strict',
      undefined
    );
  });

  it('deleteSchema delegates', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.deleteSchema();
    expect(mock.deleteSchema).toHaveBeenCalledWith('customer-42');
  });

  it('analyzeSchema forwards sample size', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.analyzeSchema(250);
    expect(mock.analyzeSchema).toHaveBeenCalledWith('customer-42', 250);
  });

  it('refreshSchema delegates', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.refreshSchema();
    expect(mock.refreshSchema).toHaveBeenCalledWith('customer-42');
  });

  it('clearSchemaCache delegates per-namespace', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    ns.clearSchemaCache();
    expect(mock.clearSchemaCache).toHaveBeenCalledWith('customer-42');
  });

  it('getAnalytics forwards time range', async () => {
    const mock = buildMockClient();
    const ns = await openNs(mock);
    await ns.getAnalytics('7d');
    expect(mock.getCollectionAnalytics).toHaveBeenCalledWith(
      'customer-42',
      '7d'
    );
  });
});

// ---------------------------------------------------------------------------
// Thread operations
// ---------------------------------------------------------------------------

describe('Thread operations', () => {
  async function openThread(
    mock: MockedClient,
    id = 'conv-99'
  ): Promise<Thread> {
    mock.collectionExists.mockResolvedValue(true);
    return newMemory(mock).thread(id);
  }

  it('add without vector raises', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    await expect(t.add({ role: 'user', content: 'hi' })).rejects.toThrow(
      EmbeddingNotSupportedError
    );
  });

  it('add rejects empty role', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    await expect(
      t.add({ role: '', content: 'hi', vector: [0.1] })
    ).rejects.toThrow();
  });

  it('add rejects non-string content', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    await expect(
      t.add({
        role: 'user',
        content: 42 as unknown as string,
        vector: [0.1],
      })
    ).rejects.toThrow('content must be a string');
  });

  it('add writes message payload with role/content/ts', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    const pid = await t.add({
      role: 'user',
      content: 'hi',
      vector: [0.1, 0.2],
      ts: 1000,
    });

    const [coll, points] = mock.upsert.mock.calls[0];
    expect(coll).toBe('__thread__conv-99');
    expect(points[0].id).toBe(pid);
    expect(points[0].vector).toEqual([0.1, 0.2]);
    expect(points[0].payload).toEqual({
      role: 'user',
      content: 'hi',
      ts: 1000,
    });
  });

  it('add sets ts when omitted', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    await t.add({ role: 'user', content: 'hi', vector: [0.1] });
    const payload = mock.upsert.mock.calls[0][1][0].payload as Record<
      string,
      unknown
    >;
    expect(typeof payload.ts).toBe('number');
  });

  it('history returns messages ordered ascending by ts', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    mock.scroll.mockResolvedValue({
      nextPageOffset: null,
      points: [
        { id: 'p3', payload: { role: 'user', content: 'third', ts: 3.0 } },
        { id: 'p1', payload: { role: 'user', content: 'first', ts: 1.0 } },
        { id: 'p2', payload: { role: 'bot', content: 'second', ts: 2.0 } },
      ],
    });
    const hist = await t.history({ limit: 10 });
    expect(hist.map(m => m.content)).toEqual(['first', 'second', 'third']);
  });

  it('history descending order', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    mock.scroll.mockResolvedValue({
      nextPageOffset: null,
      points: [
        { id: 'p1', payload: { role: 'u', content: 'a', ts: 1.0 } },
        { id: 'p2', payload: { role: 'u', content: 'b', ts: 2.0 } },
      ],
    });
    const hist = await t.history({ limit: 10, order: 'desc' });
    expect(hist.map(m => m.content)).toEqual(['b', 'a']);
  });

  it('history respects limit', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    mock.scroll.mockResolvedValue({
      nextPageOffset: null,
      points: Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        payload: { role: 'u', content: String(i), ts: i },
      })),
    });
    const hist = await t.history({ limit: 3 });
    expect(hist).toHaveLength(3);
    expect(hist.map(m => m.content)).toEqual(['0', '1', '2']);
  });

  it('history rejects bad order', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    await expect(t.history({ order: 'sideways' as 'asc' })).rejects.toThrow();
  });

  it('history rejects non-positive limit', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    await expect(t.history({ limit: 0 })).rejects.toThrow();
  });

  it('clear drops the prefixed collection', async () => {
    const mock = buildMockClient();
    const t = await openThread(mock);
    await t.clear();
    expect(mock.deleteCollection).toHaveBeenCalledWith('__thread__conv-99');
  });
});

// ---------------------------------------------------------------------------
// Analytics parity
// ---------------------------------------------------------------------------

describe('Analytics parity', () => {
  it('getPerformanceAnalytics delegates', async () => {
    const mock = buildMockClient();
    const m = newMemory(mock);
    await m.getPerformanceAnalytics('7d', 'iad');
    expect(mock.getPerformanceAnalytics).toHaveBeenCalledWith('7d', 'iad');
  });

  it('getNamespaceAnalytics requires existence', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await expect(m.getNamespaceAnalytics('nope')).rejects.toThrow(
      NamespaceNotFoundError
    );
  });

  it('getNamespaceAnalytics delegates', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const m = newMemory(mock);
    await m.getNamespaceAnalytics('customer-42', '1h');
    expect(mock.getCollectionAnalytics).toHaveBeenCalledWith(
      'customer-42',
      '1h'
    );
  });

  it('getThreadAnalytics uses the prefixed collection', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(true);
    const m = newMemory(mock);
    await m.getThreadAnalytics('conv-99');
    expect(mock.getCollectionAnalytics).toHaveBeenCalledWith(
      '__thread__conv-99',
      '24h'
    );
  });

  it('getThreadAnalytics requires existence', async () => {
    const mock = buildMockClient();
    mock.collectionExists.mockResolvedValue(false);
    const m = newMemory(mock);
    await expect(m.getThreadAnalytics('nope')).rejects.toThrow(
      ThreadNotFoundError
    );
  });

  it('getUsageStats delegates', async () => {
    const mock = buildMockClient();
    const m = newMemory(mock);
    await m.getUsageStats();
    expect(mock.getUsageStats).toHaveBeenCalled();
  });

  it('client-level clearSchemaCache wipes all', async () => {
    const mock = buildMockClient();
    const m = newMemory(mock);
    m.clearSchemaCache();
    // No argument means "all"
    expect(mock.clearSchemaCache).toHaveBeenCalledWith();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('Client lifecycle', () => {
  it('dispose delegates', async () => {
    const mock = buildMockClient();
    const m = newMemory(mock);
    await m.dispose();
    expect(mock.dispose).toHaveBeenCalled();
  });
});

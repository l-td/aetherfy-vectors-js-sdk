/**
 * Every collection lives in a workspace: a name, or (workspace: 'auto', the
 * default) the agent's workspace id from AETHERFY_WORKSPACE_ID. There is no
 * "no workspace".
 */

import nock from 'nock';

/** The two internals these tests reach: the cache key and the cache. */
type CacheInternals = {
  scopeCollection(name: string): string;
  schemaCache: Map<string, { size: number; distance: string; etag?: string }>;
};
import { AetherfyVectorsClient } from '../../src/client';
import { DistanceMetric } from '../../src/models';
import { MemoryClient } from '../../src/memory';
import { createClient } from '../../src';

const KEY = 'afy_test_1234567890123456';
const WS_ID = '0f8e2b9a-7c41-4d2e-9b3a-5e6f7a8b9c0d';
const baseUrl = 'https://vectors.aetherfy.com';

function make(config: Record<string, unknown> = {}): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: KEY,
    enableConnectionPooling: false,
    ...config,
  });
}

describe('Workspace Support', () => {
  afterEach(() => {
    nock.cleanAll();
    delete process.env.AETHERFY_WORKSPACE;
  });

  describe('Constructor', () => {
    it('takes a workspace name', () => {
      const client = make({ workspace: 'my-workspace' });

      expect(client.workspace).toBe('my-workspace');
      expect(client.workspaceId).toBeUndefined();
    });

    it("'auto' reads the workspace id", () => {
      process.env.AETHERFY_WORKSPACE_ID = WS_ID;
      const client = make({ workspace: 'auto' });

      expect(client.workspace).toBeUndefined();
      expect(client.workspaceId).toBe(WS_ID);
    });

    it("defaults to 'auto' (also when workspace is undefined)", () => {
      process.env.AETHERFY_WORKSPACE_ID = WS_ID;

      expect(make().workspaceId).toBe(WS_ID);
      expect(make({ workspace: undefined }).workspaceId).toBe(WS_ID);
    });

    it('does not read the old AETHERFY_WORKSPACE (the name)', () => {
      delete process.env.AETHERFY_WORKSPACE_ID;
      process.env.AETHERFY_WORKSPACE = 'env-workspace';

      expect(() => make()).toThrow(/AETHERFY_WORKSPACE_ID/);
    });

    it.each([
      ['unset', undefined],
      ['empty', ''],
    ])("refuses 'auto' outside an agent (id %s)", (_label, id) => {
      if (id === undefined) delete process.env.AETHERFY_WORKSPACE_ID;
      else process.env.AETHERFY_WORKSPACE_ID = id;

      // Both fixes are named.
      expect(() => make({ workspace: 'auto' })).toThrow(/workspace name/);
      expect(() => make({ workspace: 'auto' })).toThrow(
        /inside an Aetherfy agent/
      );
    });

    it.each([
      ['null', null],
      ['empty', ''],
    ])('refuses a %s workspace even inside an agent', (_label, workspace) => {
      process.env.AETHERFY_WORKSPACE_ID = WS_ID;

      expect(() => make({ workspace })).toThrow(/workspace name/);
      expect(() => make({ workspace })).toThrow(/inside an Aetherfy agent/);
    });
  });

  describe('Cache keys', () => {
    it('the name and id forms never share a cache entry', () => {
      process.env.AETHERFY_WORKSPACE_ID = WS_ID;
      // A workspace NAMED like an id still gets a different key.
      const clients = [
        make(),
        make({ workspace: WS_ID }),
        make({ workspace: 'other' }),
      ].map(c => c as unknown as CacheInternals);

      const keys = new Set(clients.map(c => c.scopeCollection('documents')));
      expect(keys.size).toBe(3);
      expect(clients[0].scopeCollection('documents')).toBe(
        `id:${WS_ID}/documents`
      );
      expect(clients[2].scopeCollection('documents')).toBe('other/documents');
    });

    it('clearSchemaCache takes the bare name', () => {
      const real = make({ workspace: 'my-workspace' });
      const c = real as unknown as CacheInternals;
      const key = c.scopeCollection('documents');
      c.schemaCache.set(key, { size: 3, distance: 'Cosine' });

      real.clearSchemaCache('documents');

      expect(c.schemaCache.has(key)).toBe(false);
    });
  });

  describe('On the wire', () => {
    it('a name uses /workspaces/{name}/...', async () => {
      const client = make({ workspace: 'invoice-pipeline' });
      const scope = nock(baseUrl)
        .post(
          '/api/v1/workspaces/invoice-pipeline/collections',
          body => body.name === 'documents'
        )
        .reply(201, { success: true });

      await client.createCollection('documents', {
        size: 384,
        distance: DistanceMetric.COSINE,
      });

      expect(scope.isDone()).toBe(true);
    });

    it("'auto' uses /workspace-ids/{id}/...", async () => {
      process.env.AETHERFY_WORKSPACE_ID = WS_ID;
      const client = make();
      const scope = nock(baseUrl)
        .get(`/api/v1/workspace-ids/${WS_ID}/collections`)
        .reply(200, { collections: [] });

      await client.getCollections();

      expect(scope.isDone()).toBe(true);
    });

    it('the workspace is encoded', async () => {
      const client = make({ workspace: 'a b' });
      const scope = nock(baseUrl)
        .delete('/api/v1/workspaces/a%20b/collections/docs')
        .reply(200, { result: true });

      await client.deleteCollection('docs');

      expect(scope.isDone()).toBe(true);
    });
  });

  describe('Schema routes live under the collection', () => {
    const SCHEMA = '/api/v1/workspaces/test-workspace/collections/docs/schema';

    it('getSchema', async () => {
      const client = make({ workspace: 'test-workspace' });
      const scope = nock(baseUrl)
        .get(SCHEMA)
        .reply(200, {
          schema: { fields: {} },
          etag: 'v1',
          enforcement_mode: 'off',
        });

      await client.getSchema('docs');

      expect(scope.isDone()).toBe(true);
    });

    it('setSchema', async () => {
      const client = make({ workspace: 'test-workspace' });
      const scope = nock(baseUrl).put(SCHEMA).reply(200, { etag: 'v2' });

      await client.setSchema('docs', { fields: {} });

      expect(scope.isDone()).toBe(true);
    });

    it('deleteSchema', async () => {
      const client = make({ workspace: 'test-workspace' });
      const scope = nock(baseUrl).delete(SCHEMA).reply(200, {});

      await client.deleteSchema('docs');

      expect(scope.isDone()).toBe(true);
    });

    it('analyzeSchema, by workspace id', async () => {
      process.env.AETHERFY_WORKSPACE_ID = WS_ID;
      const client = make();
      const scope = nock(baseUrl)
        .post(`/api/v1/workspace-ids/${WS_ID}/collections/docs/schema/analyze`)
        .reply(200, {
          collection: 'docs',
          sample_size: 10,
          total_points: 10,
          fields: {},
          suggested_schema: { fields: {} },
          processing_time_ms: 1,
        });

      await client.analyzeSchema('docs');

      expect(scope.isDone()).toBe(true);
    });
  });
});

describe('the workspace is decided before any request', () => {
  afterEach(() => {
    nock.cleanAll();
    delete process.env.AETHERFY_VECTORS_URL;
  });

  it('create() without a workspace makes no discovery request', async () => {
    delete process.env.AETHERFY_WORKSPACE_ID;
    delete process.env.AETHERFY_VECTORS_URL;
    const discovery = nock(baseUrl)
      .get('/api/v1/regions')
      .reply(200, { 'eu-central-1': 'https://eu.example' });

    await expect(
      AetherfyVectorsClient.create({ apiKey: KEY, apiRegion: 'eu-central-1' })
    ).rejects.toThrow(/AETHERFY_WORKSPACE_ID/);
    expect(discovery.isDone()).toBe(false);
  });

  it('CONTROL: create() with a named workspace runs discovery', async () => {
    delete process.env.AETHERFY_WORKSPACE_ID;
    delete process.env.AETHERFY_VECTORS_URL;
    const discovery = nock(baseUrl)
      .get('/api/v1/regions')
      .reply(200, { 'eu-central-1': 'https://eu.example' });

    const client = await AetherfyVectorsClient.create({
      apiKey: KEY,
      workspace: 'w',
      apiRegion: 'eu-central-1',
    });
    expect(discovery.isDone()).toBe(true);
    expect(client.workspace).toBe('w');
  });

  it('MemoryClient forwards a named workspace, and is refused without one', () => {
    delete process.env.AETHERFY_WORKSPACE_ID;

    expect(new MemoryClient({ apiKey: KEY, workspace: 'w' }).workspace).toBe(
      'w'
    );
    expect(() => new MemoryClient({ apiKey: KEY })).toThrow(
      /AETHERFY_WORKSPACE_ID/
    );
  });

  it('createClient forwards a named workspace', () => {
    delete process.env.AETHERFY_WORKSPACE_ID;

    expect(createClient({ apiKey: KEY, workspace: 'w' }).workspace).toBe('w');
    expect(() => createClient({ apiKey: KEY })).toThrow(
      /AETHERFY_WORKSPACE_ID/
    );
  });
});

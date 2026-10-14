/**
 * The workspace-required error codes, mapped on `code`, never on the message.
 *
 * Bodies are the contract sheet's (vectordb envelope `{ error: {...} }`), sent
 * through the one status/code mapping every error goes through
 * (createErrorFromResponse) and, where a client method decides on a 404,
 * through that method: an unknown workspace must never read as "not there".
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import {
  AetherfyVectorsError,
  AuthenticationError,
  CollectionNotFoundError,
  ConflictError,
  createErrorFromResponse,
  isRetryableError,
  PointNotFoundError,
  SchemaNotFoundError,
  ServiceUnavailableError,
  ValidationError,
  WorkspaceNotFoundError,
} from '../../src/exceptions';
import { WorkspaceNotFoundError as Exported } from '../../src';
import { MemoryClient, NamespaceNotFoundError } from '../../src/memory';
import { Namespace } from '../../src/memory/namespace';
import { DistanceMetric } from '../../src/models';

const BASE = 'https://vectors.aetherfy.com';
const WS_PATH = '/api/v1/workspaces/typo';
const WS_ID = '0f8e2b9a-7c41-4d2e-9b3a-5e6f7a8b9c0d';

function body(code: string, fields: Record<string, unknown> = {}) {
  return { error: { code, message: `${code} (prose)`, ...fields } };
}

const WORKSPACE_NOT_FOUND_BY_NAME = body('WORKSPACE_NOT_FOUND', {
  workspace: 'typo',
});
const WORKSPACE_NOT_FOUND_BY_ID = body('WORKSPACE_NOT_FOUND', {
  workspace_id: WS_ID,
});
const COLLECTION_NOT_FOUND = body('COLLECTION_NOT_FOUND', {
  message: "Collection 'docs' not found",
  collection_name: 'docs',
});
const POINT_MISSING = { status: { error: 'No point with id 1 found' } };

function client(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    workspace: 'typo',
    enableConnectionPooling: false,
  });
}

afterEach(() => {
  nock.cleanAll();
});

// ===========================================================================
// The mapping table
// ===========================================================================

describe('each code maps to a typed error carrying it', () => {
  const cases: Array<[number, ReturnType<typeof body>, unknown]> = [
    [400, body('WORKSPACE_REQUIRED'), ValidationError],
    [404, WORKSPACE_NOT_FOUND_BY_NAME, WorkspaceNotFoundError],
    [404, WORKSPACE_NOT_FOUND_BY_ID, WorkspaceNotFoundError],
    [404, COLLECTION_NOT_FOUND, CollectionNotFoundError],
    [404, body('SCHEMA_NOT_DEFINED'), SchemaNotFoundError],
    [
      409,
      body('ADDRESSED_AN_ALIAS', { alias: 'live', workspace: 'w' }),
      ConflictError,
    ],
    [
      409,
      body('COLLECTION_NAME_TAKEN', {
        collection_name: 'docs',
        workspace: 'w',
        taken_by: 'alias',
      }),
      ConflictError,
    ],
    [
      409,
      body('COLLECTION_NAME_IS_AN_ALIAS', {
        collection_name: 'docs',
        workspace: 'w',
      }),
      ConflictError,
    ],
    [
      422,
      body('COLLECTION_SDK_MANAGED', { collection_name: '__threads__' }),
      ValidationError,
    ],
    [
      403,
      body('AUTH_AGENT_KEY_OUT_OF_SCOPE', {
        agent_id: 'a1',
        required_scope: null,
        documentation_url: 'https://docs.aetherfy.com/platform/api-keys',
      }),
      AuthenticationError,
    ],
    [503, body('WORKSPACE_LOOKUP_UNAVAILABLE'), ServiceUnavailableError],
    [
      503,
      body('COLLECTION_LOOKUP_UNAVAILABLE', { collection_name: 'docs' }),
      ServiceUnavailableError,
    ],
    [503, body('PLACEMENT_UNAVAILABLE'), ServiceUnavailableError],
  ];

  it.each(cases)('%i %j', (status, payload, cls) => {
    const err = createErrorFromResponse(payload, status, 'x');
    expect(err.constructor).toBe(cls);
    expect(err.code).toBe(payload.error.code);
  });
});

describe('retryability', () => {
  it.each([
    'WORKSPACE_LOOKUP_UNAVAILABLE',
    'COLLECTION_LOOKUP_UNAVAILABLE',
    'PLACEMENT_UNAVAILABLE',
  ])('%s is retryable', code => {
    expect(
      isRetryableError(createErrorFromResponse(body(code), 503, 'x'))
    ).toBe(true);
  });

  it.each([
    [404, 'WORKSPACE_NOT_FOUND'],
    [400, 'WORKSPACE_REQUIRED'],
    [409, 'ADDRESSED_AN_ALIAS'],
  ])('CONTROL: %i %s is not', (status, code) => {
    expect(
      isRetryableError(createErrorFromResponse(body(code), status, 'x'))
    ).toBe(false);
  });
});

describe('WorkspaceNotFoundError', () => {
  it('names what was sent', () => {
    const byName = createErrorFromResponse(
      WORKSPACE_NOT_FOUND_BY_NAME,
      404,
      'x'
    ) as WorkspaceNotFoundError;
    expect([byName.workspace, byName.workspaceId]).toEqual(['typo', null]);

    const byId = createErrorFromResponse(
      WORKSPACE_NOT_FOUND_BY_ID,
      404,
      'x'
    ) as WorkspaceNotFoundError;
    expect([byId.workspace, byId.workspaceId]).toEqual([null, WS_ID]);
  });

  it('is exported from the package', () => {
    expect(Exported).toBe(WorkspaceNotFoundError);
  });

  it('CONTROL: the code decides, not the message', () => {
    const lying = {
      error: { code: 'COLLECTION_NOT_FOUND', message: 'Workspace not found' },
    };
    expect(createErrorFromResponse(lying, 404, 'x').constructor).toBe(
      CollectionNotFoundError
    );
    const terse = { error: { code: 'WORKSPACE_NOT_FOUND', message: 'x' } };
    expect(createErrorFromResponse(terse, 404, 'x').constructor).toBe(
      WorkspaceNotFoundError
    );
  });
});

// ===========================================================================
// Through the client: the retry loop, and the methods that decide on a 404
// ===========================================================================

describe('the retry loop', () => {
  let timeout: jest.SpyInstance;
  beforeEach(() => {
    // The backoff sleeps through setTimeout (at most a few seconds here):
    // run those at once. A longer one is the request's own timeout (30 s or
    // more), which keeps its real timer.
    const real = global.setTimeout;
    timeout = jest.spyOn(global, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if ((ms ?? 0) < 10_000) {
        fn();
        return 0;
      }
      return real(fn, ms, ...rest);
    }) as unknown as typeof setTimeout);
  });
  afterEach(() => timeout.mockRestore());

  const create = (c: AetherfyVectorsClient) =>
    c.createCollection('docs', { size: 3, distance: DistanceMetric.COSINE });

  it.each([
    'WORKSPACE_LOOKUP_UNAVAILABLE',
    'COLLECTION_LOOKUP_UNAVAILABLE',
    'PLACEMENT_UNAVAILABLE',
  ])('%s is retried, then succeeds', async code => {
    const first = nock(BASE)
      .post(`${WS_PATH}/collections`)
      .reply(503, body(code));
    const second = nock(BASE)
      .post(`${WS_PATH}/collections`)
      .reply(200, { result: true });

    await create(client());

    expect(first.isDone()).toBe(true);
    expect(second.isDone()).toBe(true);
  });

  it('a lasting outage throws the typed error with its code', async () => {
    const scope = nock(BASE)
      .post(`${WS_PATH}/collections`)
      .times(4)
      .reply(503, body('WORKSPACE_LOOKUP_UNAVAILABLE'));

    const err = await create(client()).catch(e => e);

    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err.code).toBe('WORKSPACE_LOOKUP_UNAVAILABLE');
    expect(scope.isDone()).toBe(true); // all four attempts were made
  });

  it('CONTROL: an unknown workspace is tried once', async () => {
    const once = nock(BASE)
      .post(`${WS_PATH}/collections`)
      .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);
    const again = nock(BASE)
      .post(`${WS_PATH}/collections`)
      .reply(200, { result: true });

    await expect(create(client())).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
    expect(once.isDone()).toBe(true);
    expect(again.isDone()).toBe(false);
  });
});

describe('an unknown workspace never reads as "not there"', () => {
  it('collectionExists throws it', async () => {
    nock(BASE)
      .get(`${WS_PATH}/collections/docs`)
      .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);
    await expect(client().collectionExists('docs')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
  });

  it('CONTROL: collectionExists is false on COLLECTION_NOT_FOUND', async () => {
    nock(BASE)
      .get(`${WS_PATH}/collections/docs`)
      .reply(404, COLLECTION_NOT_FOUND);
    await expect(client().collectionExists('docs')).resolves.toBe(false);
  });

  it('deleteFieldIndex throws it', async () => {
    nock(BASE)
      .delete(`${WS_PATH}/collections/docs/index/tag`)
      .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);
    await expect(
      client().deleteFieldIndex('docs', 'tag')
    ).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });

  it('CONTROL: deleteFieldIndex is false on COLLECTION_NOT_FOUND', async () => {
    nock(BASE)
      .delete(`${WS_PATH}/collections/docs/index/tag`)
      .reply(404, COLLECTION_NOT_FOUND);
    await expect(client().deleteFieldIndex('docs', 'tag')).resolves.toBe(false);
  });

  it('getSchema throws it', async () => {
    nock(BASE)
      .get(`${WS_PATH}/collections/docs/schema`)
      .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);
    await expect(client().getSchema('docs')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
  });

  it.each([
    ['COLLECTION_NOT_FOUND', COLLECTION_NOT_FOUND],
    ['SCHEMA_NOT_DEFINED', body('SCHEMA_NOT_DEFINED')],
  ])('CONTROL: getSchema is null on %s', async (_label, payload) => {
    nock(BASE).get(`${WS_PATH}/collections/docs/schema`).reply(404, payload);
    await expect(client().getSchema('docs')).resolves.toBeNull();
  });

  it('deleteSchema throws it', async () => {
    nock(BASE)
      .delete(`${WS_PATH}/collections/docs/schema`)
      .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);
    await expect(client().deleteSchema('docs')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
  });

  it('CONTROL: deleteSchema is SchemaNotFoundError on SCHEMA_NOT_DEFINED', async () => {
    nock(BASE)
      .delete(`${WS_PATH}/collections/docs/schema`)
      .reply(404, body('SCHEMA_NOT_DEFINED'));
    await expect(client().deleteSchema('docs')).rejects.toBeInstanceOf(
      SchemaNotFoundError
    );
  });

  describe.each([
    ['mergeMetadata', 'payload', { a: 1 }],
    ['deleteMetadataKeys', 'payload/delete', ['a']],
  ])('%s', (op, route, arg) => {
    const call = (c: AetherfyVectorsClient) =>
      (
        c as unknown as Record<
          string,
          (n: string, id: number, a: unknown) => Promise<unknown>
        >
      )[op]('docs', 1, arg);

    it('does not call an unknown workspace a missing point', async () => {
      nock(BASE)
        .post(`${WS_PATH}/collections/docs/points/${route}`)
        .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);
      await expect(call(client())).rejects.toBeInstanceOf(
        WorkspaceNotFoundError
      );
    });

    it('CONTROL: still names a missing point', async () => {
      nock(BASE)
        .post(`${WS_PATH}/collections/docs/points/${route}`)
        .reply(404, POINT_MISSING);
      await expect(call(client())).rejects.toBeInstanceOf(PointNotFoundError);
    });
  });

  it('does not evict the schema cache', async () => {
    const c = client() as any;
    const key = c.scopeCollection('docs');
    c.schemaCache.set(key, { size: 3, distance: 'Cosine' });
    nock(BASE)
      .get(`${WS_PATH}/collections/docs`)
      .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);

    await expect(c.getCollection('docs')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
    expect(c.schemaCache.has(key)).toBe(true);
  });

  it('CONTROL: COLLECTION_NOT_FOUND evicts the schema cache', async () => {
    const c = client() as any;
    const key = c.scopeCollection('docs');
    c.schemaCache.set(key, { size: 3, distance: 'Cosine' });
    nock(BASE)
      .get(`${WS_PATH}/collections/docs`)
      .reply(404, COLLECTION_NOT_FOUND);

    await expect(c.getCollection('docs')).rejects.toBeInstanceOf(
      CollectionNotFoundError
    );
    expect(c.schemaCache.has(key)).toBe(false);
  });
});

it('getUsageStats with an agent key is the typed scope refusal', async () => {
  // GET /analytics/usage is account-only: an agent key gets 403
  // AUTH_AGENT_KEY_OUT_OF_SCOPE (vectordb utils/agentRoutePolicy.js).
  nock(BASE)
    .get('/api/v1/analytics/usage')
    .reply(
      403,
      body('AUTH_AGENT_KEY_OUT_OF_SCOPE', {
        agent_id: 'a1',
        required_scope: null,
      })
    );

  const err = await client()
    .getUsageStats()
    .catch(e => e);

  expect(err).toBeInstanceOf(AuthenticationError);
  expect((err as AetherfyVectorsError).code).toBe(
    'AUTH_AGENT_KEY_OUT_OF_SCOPE'
  );
});

// ===========================================================================
// The memory SDK: NamespaceNotFoundError only for a missing collection
// ===========================================================================

describe('memory', () => {
  const memory = () => new MemoryClient({ client: client() });

  it('namespace() throws the unknown workspace, not NamespaceNotFoundError', async () => {
    nock(BASE)
      .get(`${WS_PATH}/collections/kb`)
      .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);
    await expect(memory().namespace('kb')).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
  });

  it('CONTROL: namespace() is NamespaceNotFoundError on COLLECTION_NOT_FOUND', async () => {
    nock(BASE)
      .get(`${WS_PATH}/collections/kb`)
      .reply(404, COLLECTION_NOT_FOUND);
    await expect(memory().namespace('kb')).rejects.toBeInstanceOf(
      NamespaceNotFoundError
    );
  });

  describe.each([
    ['mergeMetadata', 'payload', { a: 1 }],
    ['deleteMetadataKeys', 'payload/delete', ['a']],
  ])('Namespace.%s', (op, route, arg) => {
    const call = () =>
      (
        new Namespace('kb', 'kb', client()) as unknown as Record<
          string,
          (id: number, a: unknown) => Promise<unknown>
        >
      )[op](1, arg);

    it('does not call an unknown workspace a missing point', async () => {
      nock(BASE)
        .post(`${WS_PATH}/collections/kb/points/${route}`)
        .reply(404, WORKSPACE_NOT_FOUND_BY_NAME);
      await expect(call()).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    });

    it('CONTROL: still names a missing point', async () => {
      nock(BASE)
        .post(`${WS_PATH}/collections/kb/points/${route}`)
        .reply(404, POINT_MISSING);
      await expect(call()).rejects.toBeInstanceOf(PointNotFoundError);
    });
  });
});

/**
 * The plan limit's answer (403 PLAN_LIMIT_EXCEEDED, the control plane's
 * shape) reaches the typed QuotaExceededError through the real client and the
 * real HTTP stack, including the memory SDK's createNamespace.
 *
 * The body is the one vectordb sends (routes/proxy.js, the collection limit):
 * `limit` names the axis, `current` is the count in use and the plan's number
 * sits under the axis' own name.
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { QuotaExceededError } from '../../src/exceptions';
import { MemoryClient } from '../../src/memory';
import { DistanceMetric } from '../../src/models';

const BASE = 'https://vectors.aetherfy.com';
const WS_PATH = '/api/v1/workspaces/home';

const PLAN_LIMIT = {
  error: {
    code: 'PLAN_LIMIT_EXCEEDED',
    message: 'Collection limit reached. Your free plan allows 3 collections.',
    limit: 'max_collections',
    current: 3,
    max_collections: 3,
    upgrade_url: '/billing/upgrade',
  },
};

function client(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    workspace: 'home',
    enableConnectionPooling: false,
  });
}

afterEach(() => {
  nock.cleanAll();
});

describe('the plan limit on a collection create', () => {
  it('createCollection throws QuotaExceededError with the axis, the count and the plan number', async () => {
    const scope = nock(BASE)
      .post(`${WS_PATH}/collections`)
      .reply(403, PLAN_LIMIT);
    const error = await client()
      .createCollection('docs', { size: 3, distance: DistanceMetric.COSINE })
      .catch(e => e);
    expect(scope.isDone()).toBe(true);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(error.quotaType).toBe('collections');
    expect(error.current).toBe(3);
    expect(error.limit).toBe(3);
    expect(error.message).toBe(PLAN_LIMIT.error.message);
  });

  it('MemoryClient.createNamespace surfaces the same typed error', async () => {
    nock(BASE)
      .get(`${WS_PATH}/collections/kb`)
      .reply(404, {
        error: { code: 'COLLECTION_NOT_FOUND', message: 'not found' },
      });
    nock(BASE).post(`${WS_PATH}/collections`).reply(403, PLAN_LIMIT);
    const error = await new MemoryClient({ client: client() })
      .createNamespace('kb')
      .catch(e => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.quotaType).toBe('collections');
    expect(error.current).toBe(3);
    expect(error.limit).toBe(3);
  });

  it('another plan axis maps the same way', async () => {
    nock(BASE)
      .post(`${WS_PATH}/collections`)
      .reply(403, {
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'limit',
          limit: 'max_workspaces',
          current: 1,
          max_workspaces: 1,
        },
      });
    const error = await client()
      .createCollection('docs', { size: 3, distance: DistanceMetric.COSINE })
      .catch(e => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.quotaType).toBe('workspaces');
    expect(error.limit).toBe(1);
  });

  it('a body without the numbers still maps, with them undefined', async () => {
    nock(BASE)
      .post(`${WS_PATH}/collections`)
      .reply(403, {
        error: { code: 'PLAN_LIMIT_EXCEEDED', message: 'limit' },
      });
    const error = await client()
      .createCollection('docs', { size: 3, distance: DistanceMetric.COSINE })
      .catch(e => e);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.current).toBeUndefined();
    expect(error.limit).toBeUndefined();
  });
});

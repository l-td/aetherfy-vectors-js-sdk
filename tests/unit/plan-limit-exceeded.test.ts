/**
 * A plan limit (403 PLAN_LIMIT_EXCEEDED) reaches the typed QuotaExceededError
 * through the real client and the real HTTP stack, including the memory SDK's
 * createNamespace.
 *
 * The body is `{ code, message, upgrade_url, limit, allowed, current }` inside
 * `error`: `limit` names the limit, `allowed` is the plan's number (or `false`
 * for a feature the plan lacks, or `null` for no cap) and `current` is the
 * usage now (absent for a yes/no feature).
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import {
  PermissionDeniedError,
  QuotaExceededError,
  createErrorFromResponse,
} from '../../src/exceptions';
import { MemoryClient } from '../../src/memory';
import { DistanceMetric } from '../../src/models';

const BASE = 'https://vectors.aetherfy.com';
const WS_PATH = '/api/v1/workspaces/home';
const UPGRADE_URL = 'https://app.aetherfy.com/dashboard/settings/billing';

function planLimit(
  fields: Record<string, unknown> = {},
  limit: string = 'max_collections'
) {
  return {
    error: {
      code: 'PLAN_LIMIT_EXCEEDED',
      message: 'Collection limit reached. Your free plan allows 3 collections.',
      upgrade_url: UPGRADE_URL,
      limit,
      ...fields,
    },
  };
}

const PLAN_LIMIT = planLimit({ allowed: 3, current: 3 });

function client(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    workspace: 'home',
    enableConnectionPooling: false,
  });
}

const create = (c: AetherfyVectorsClient) =>
  c.createCollection('docs', { size: 3, distance: DistanceMetric.COSINE });

afterEach(() => {
  nock.cleanAll();
});

describe('the plan limit on a collection create', () => {
  it('createCollection throws QuotaExceededError with the limit, the plan number and the count', async () => {
    const scope = nock(BASE)
      .post(`${WS_PATH}/collections`)
      .reply(403, PLAN_LIMIT);
    const error = await create(client()).catch(e => e);
    expect(scope.isDone()).toBe(true);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(error.statusCode).toBe(403);
    expect(error.limit).toBe('max_collections');
    expect(error.allowed).toBe(3);
    expect(error.current).toBe(3);
    expect(error.upgradeUrl).toBe(UPGRADE_URL);
    expect(error.details.limit).toBe('max_collections');
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
    expect(error.limit).toBe('max_collections');
    expect(error.allowed).toBe(3);
    expect(error.current).toBe(3);
  });
});

describe('every kind of allowed, and a missing current', () => {
  it.each([
    ['a number', 3, 3],
    ['zero', 0, 0],
    ['a feature the plan lacks', false, false],
    ['no cap', null, null],
  ])('allowed is %s', (_name, sent, expected) => {
    const error = createErrorFromResponse(
      planLimit({ allowed: sent, current: 2 }),
      403,
      'Forbidden'
    ) as QuotaExceededError;
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.allowed).toBe(expected);
  });

  it('a yes/no feature has no current', () => {
    const body = planLimit({ allowed: false }, 'webhooks');
    expect('current' in body.error).toBe(false);
    const error = createErrorFromResponse(
      body,
      403,
      'Forbidden'
    ) as QuotaExceededError;
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.limit).toBe('webhooks');
    expect(error.allowed).toBe(false);
    expect(error.current).toBeUndefined();
  });

  it('another limit maps the same way', () => {
    const error = createErrorFromResponse(
      planLimit({ allowed: 1, current: 1 }, 'max_workspaces'),
      403,
      'Forbidden'
    ) as QuotaExceededError;
    expect(error.limit).toBe('max_workspaces');
    expect(error.allowed).toBe(1);
  });

  it('a body without the fields still maps, with them undefined', () => {
    const error = createErrorFromResponse(
      { error: { code: 'PLAN_LIMIT_EXCEEDED', message: 'limit' } },
      403,
      'Forbidden'
    ) as QuotaExceededError;
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.limit).toBeUndefined();
    expect(error.allowed).toBeUndefined();
    expect(error.current).toBeUndefined();
    expect(error.upgradeUrl).toBeUndefined();
  });

  it.each(['3', true, [3], { n: 3 }])(
    'an allowed or current of another type (%p) is not carried',
    bad => {
      const error = createErrorFromResponse(
        planLimit({ allowed: bad, current: bad }),
        403,
        'Forbidden'
      ) as QuotaExceededError;
      expect(error).toBeInstanceOf(QuotaExceededError);
      expect(error.allowed).toBeUndefined();
      expect(error.current).toBeUndefined();
    }
  );
});

describe('the storage quota', () => {
  it('reads the numbers from error.details', () => {
    const error = createErrorFromResponse(
      {
        error: {
          code: 'STORAGE_LIMIT_EXCEEDED',
          message: 'Storage limit exceeded.',
          details: { current_bytes: 536870912, limit_bytes: 536870912 },
        },
      },
      429,
      'Too Many Requests'
    ) as QuotaExceededError;
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error.current).toBe(536870912);
    expect(error.allowed).toBe(536870912);
    expect(error.limit).toBeUndefined();
  });
});

describe('a plan limit is not a permission error', () => {
  it('the key may do this; the account is at its cap', () => {
    const error = createErrorFromResponse(PLAN_LIMIT, 403, 'Forbidden');
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).not.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('one name for the limit', () => {
  it('has no quotaType, and the storage quota has no limit', () => {
    const plan = createErrorFromResponse(PLAN_LIMIT, 403, 'Forbidden');
    expect((plan as QuotaExceededError).limit).toBe('max_collections');
    expect('quotaType' in plan).toBe(false);

    const storage = createErrorFromResponse(
      {
        error: {
          code: 'STORAGE_LIMIT_EXCEEDED',
          message: 'full',
          details: { current_bytes: 5, limit_bytes: 5 },
        },
      },
      429,
      'Too Many Requests'
    );
    expect(storage.code).toBe('STORAGE_LIMIT_EXCEEDED');
    expect((storage as QuotaExceededError).limit).toBeUndefined();
    expect('quotaType' in storage).toBe(false);
  });
});

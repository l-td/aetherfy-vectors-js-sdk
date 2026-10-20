/**
 * Collection storage modes: createCollection({ storageMode }),
 * updateCollection, Collection.storageMode, and the fake store the memory
 * layer's tests share.
 *
 * The wire contract is vectordb's (backend/docs/STORAGE_MODES.md): a mode
 * is sent only when the caller names one, so a caller who never does sends the
 * body this SDK always sent; the server answers 400 for an unknown mode, 422
 * STORAGE_MODE_UNSUITABLE for compact below 512 dimensions, 409
 * STORAGE_MODE_CHANGE_TOO_SOON inside the cooldown, with the extras under
 * the error object (the house style: `field` and `max` sit there too).
 */

import nock from 'nock';
import { TEST_WORKSPACE_ID } from '../setup';
import { AetherfyVectorsClient } from '../../src/client';
import {
  ConflictError,
  ValidationError,
  createErrorFromResponse,
} from '../../src/exceptions';
import { DistanceMetric } from '../../src/models';
import {
  DEFAULT_STORAGE_MODE,
  StorageMode,
  coerceStorageMode,
  parseStorageMode,
} from '../../src/storage-modes';
import { OPERATIONS, REPEATABLE } from '../../src/retry-policy';
import { FakeVectorsClient } from './fake-vectors-store';

const HOST = 'https://vectors.aetherfy.com';
const LIST_PATH = `/api/v1/workspace-ids/${TEST_WORKSPACE_ID}/collections`;
const ITEM_PATH = `${LIST_PATH}/docs`;
const VECTORS = { size: 768, distance: DistanceMetric.COSINE };

function newClient(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
  });
}

afterEach(() => {
  nock.cleanAll();
});

describe('StorageMode', () => {
  it('the four modes are their wire names, exact first and the default', () => {
    expect(Object.values(StorageMode)).toEqual([
      'exact',
      'balanced',
      'fast',
      'compact',
    ]);
    expect(DEFAULT_STORAGE_MODE).toBe(StorageMode.EXACT);
  });

  it('coerceStorageMode accepts the member and the name', () => {
    expect(coerceStorageMode('fast')).toBe(StorageMode.FAST);
    expect(coerceStorageMode(StorageMode.FAST)).toBe(StorageMode.FAST);
  });

  it.each(['turbo', 'Exact', '', null, undefined, 3, {}])(
    'coerceStorageMode(%p) names the accepted values',
    bad => {
      expect(() => coerceStorageMode(bad)).toThrow(
        /exact, balanced, fast, compact/
      );
    }
  );

  it('parseStorageMode keeps an unknown name instead of throwing', () => {
    expect(parseStorageMode('balanced')).toBe(StorageMode.BALANCED);
    expect(parseStorageMode('turbo4')).toBe('turbo4');
    expect(parseStorageMode(undefined)).toBeUndefined();
    expect(parseStorageMode(7)).toBeUndefined();
  });
});

describe('createCollection', () => {
  it('omitting the mode sends the body this SDK always sent', async () => {
    const scope = nock(HOST)
      .post(LIST_PATH, body => {
        expect(body).toEqual({
          name: 'docs',
          vectors: { size: 768, distance: 'Cosine' },
          description: null,
        });
        return true;
      })
      .reply(200, { regions: ['us-east-1'] });
    await newClient().createCollection('docs', VECTORS);
    expect(scope.isDone()).toBe(true);
  });

  it.each([StorageMode.BALANCED, 'balanced' as const])(
    'a named mode (%p) is sent as its wire name',
    async mode => {
      const scope = nock(HOST)
        .post(LIST_PATH, body => body.storage_mode === 'balanced')
        .reply(200, { storage_mode: 'balanced' });
      await newClient().createCollection('docs', VECTORS, {
        storageMode: mode,
      });
      expect(scope.isDone()).toBe(true);
    }
  );

  it('exact named explicitly is still sent', async () => {
    // Omitting and naming the default are different requests on the wire;
    // the SDK does not decide they mean the same.
    const scope = nock(HOST)
      .post(LIST_PATH, body => body.storage_mode === 'exact')
      .reply(200, { storage_mode: 'exact' });
    await newClient().createCollection('docs', VECTORS, {
      storageMode: StorageMode.EXACT,
    });
    expect(scope.isDone()).toBe(true);
  });

  it('an unknown mode throws before any request', async () => {
    const scope = nock(HOST).post(LIST_PATH).reply(200, {});
    await expect(
      newClient().createCollection('docs', VECTORS, {
        storageMode: 'turbo' as unknown as 'exact',
      })
    ).rejects.toThrow(/exact, balanced, fast, compact/);
    expect(scope.isDone()).toBe(false);
  });

  it('the returned collection carries the mode the server stored', async () => {
    // An idempotent re-create answers with the STORED mode, not the asked one.
    nock(HOST).post(LIST_PATH).reply(200, { storage_mode: 'fast' });
    const col = await newClient().createCollection('docs', VECTORS, {
      storageMode: StorageMode.BALANCED,
    });
    expect(col.storageMode).toBe(StorageMode.FAST);
  });

  it('a server that reports no mode leaves it undefined', async () => {
    nock(HOST)
      .post(LIST_PATH)
      .reply(200, { regions: ['us-east-1'] });
    const col = await newClient().createCollection('docs', VECTORS);
    expect(col.storageMode).toBeUndefined();
  });

  it('description, regions and a mode go in one request', async () => {
    const scope = nock(HOST)
      .post(LIST_PATH, body => {
        expect(body).toMatchObject({
          description: 'notes',
          regions: ['us-east-1'],
          storage_mode: 'compact',
        });
        return true;
      })
      .reply(200, { regions: ['us-east-1'], storage_mode: 'compact' });
    const col = await newClient().createCollection('docs', VECTORS, {
      description: 'notes',
      regions: ['us-east-1'],
      storageMode: StorageMode.COMPACT,
    });
    expect(col.regions).toEqual(['us-east-1']);
    expect(scope.isDone()).toBe(true);
  });

  it('the pre-2.0.0 positional description and regions are refused, naming the options object', async () => {
    const client = newClient() as unknown as {
      createCollection: (...args: unknown[]) => Promise<unknown>;
    };
    const scope = nock(HOST).post(LIST_PATH).reply(200, {});
    // A description string where the options object goes.
    await expect(
      client.createCollection('docs', VECTORS, 'a description')
    ).rejects.toThrow(/createCollection: options must be an object/);
    // `undefined, regions`: an empty options object and a stray argument.
    // Accepting it would place the collection in every region.
    await expect(
      client.createCollection('docs', VECTORS, undefined, ['us-east-1'])
    ).rejects.toThrow(/description and regions moved into the options object/);
    expect(scope.isDone()).toBe(false);
  });

  it('a 422 for compact below the floor is a ValidationError naming the field and code', async () => {
    nock(HOST)
      .post(LIST_PATH)
      .reply(422, {
        error: {
          code: 'STORAGE_MODE_UNSUITABLE',
          message:
            "storage_mode 'compact' needs vectors of at least 512 dimensions",
          field: 'storage_mode',
          min_vector_size: 512,
          suggested_mode: 'balanced',
        },
      });
    const error = await newClient()
      .createCollection(
        'docs',
        { size: 384, distance: DistanceMetric.COSINE },
        { storageMode: StorageMode.COMPACT }
      )
      .catch(e => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.code).toBe('STORAGE_MODE_UNSUITABLE');
    expect(error.field).toBe('storage_mode');
  });
});

describe('reading a collection', () => {
  const row = (name: string, mode?: string) => ({
    name,
    config: { params: { vectors: { size: 768, distance: 'Cosine' } } },
    points_count: 5,
    ...(mode === undefined ? {} : { storage_mode: mode }),
  });

  it('getCollection maps the wire key and passes the rest through', async () => {
    nock(HOST)
      .get(ITEM_PATH)
      .reply(200, { result: row('docs', 'compact') });
    const col = await newClient().getCollection('docs');
    expect(col.storageMode).toBe(StorageMode.COMPACT);
    expect(col).not.toHaveProperty('storage_mode');
    expect(col.points_count).toBe(5);
  });

  it('getCollections maps each collection, and keeps a mode it does not know', async () => {
    nock(HOST)
      .get(LIST_PATH)
      .reply(200, { collections: [row('a', 'exact'), row('b', 'turbo4')] });
    const [a, b] = await newClient().getCollections();
    expect(a.storageMode).toBe(StorageMode.EXACT);
    expect(b.storageMode).toBe('turbo4');
  });

  it('a collection from a server that reports no mode has none', async () => {
    nock(HOST)
      .get(ITEM_PATH)
      .reply(200, { result: row('docs') });
    const col = await newClient().getCollection('docs');
    expect(col).not.toHaveProperty('storageMode');
  });
});

describe('updateCollection', () => {
  it('a mode change is a PATCH of the collection', async () => {
    const scope = nock(HOST)
      .patch(ITEM_PATH, body => {
        expect(body).toEqual({ storage_mode: 'fast' });
        return true;
      })
      .reply(200, { storage_mode: 'fast' });
    await expect(
      newClient().updateCollection('docs', {
        storageMode: StorageMode.FAST,
      })
    ).resolves.toBe(true);
    expect(scope.isDone()).toBe(true);
  });

  it('a description alone sends only the description', async () => {
    const scope = nock(HOST)
      .patch(ITEM_PATH, body => {
        expect(body).toEqual({ description: 'notes' });
        return true;
      })
      .reply(200, {});
    await newClient().updateCollection('docs', { description: 'notes' });
    expect(scope.isDone()).toBe(true);
  });

  it('null clears the description and is not the same as omitting it', async () => {
    const scope = nock(HOST)
      .patch(ITEM_PATH, body => {
        expect(body).toEqual({ description: null });
        return true;
      })
      .reply(200, {});
    await newClient().updateCollection('docs', { description: null });
    expect(scope.isDone()).toBe(true);
  });

  it('both go in one request', async () => {
    const scope = nock(HOST)
      .patch(ITEM_PATH, body => {
        expect(body).toEqual({
          description: 'd',
          storage_mode: 'balanced',
        });
        return true;
      })
      .reply(200, {});
    await newClient().updateCollection('docs', {
      description: 'd',
      storageMode: 'balanced',
    });
    expect(scope.isDone()).toBe(true);
  });

  it('nothing to change is an error before any request', async () => {
    const scope = nock(HOST).patch(ITEM_PATH).reply(200, {});
    await expect(newClient().updateCollection('docs')).rejects.toThrow(
      /nothing to change/
    );
    await expect(newClient().updateCollection('docs', {})).rejects.toThrow(
      /nothing to change/
    );
    expect(scope.isDone()).toBe(false);
  });

  it('an unknown mode throws before any request', async () => {
    const scope = nock(HOST).patch(ITEM_PATH).reply(200, {});
    await expect(
      newClient().updateCollection('docs', {
        storageMode: 'turbo' as unknown as 'exact',
      })
    ).rejects.toThrow(/exact, balanced, fast, compact/);
    expect(scope.isDone()).toBe(false);
  });

  it('the cooldown is a non-retried ConflictError carrying its code and the seconds left', async () => {
    const scope = nock(HOST)
      .patch(ITEM_PATH)
      .once()
      .reply(409, {
        error: {
          code: 'STORAGE_MODE_CHANGE_TOO_SOON',
          message: 'It can change again in 7 minutes.',
          field: 'storage_mode',
          retry_after_seconds: 437,
          cooldown_seconds: 900,
        },
      });
    const error = await newClient()
      .updateCollection('docs', { storageMode: StorageMode.FAST })
      .catch(e => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe('STORAGE_MODE_CHANGE_TOO_SOON');
    expect(error.details).toMatchObject({ retry_after_seconds: 437 });
    // `.once()`: a retry would have found no interceptor left.
    expect(scope.isDone()).toBe(true);
  });

  it('is repeatable: a repeat after a hidden success asks for the mode it already has', () => {
    expect(OPERATIONS.updateCollection).toBe(REPEATABLE);
  });

  it('an unknown option key is a TypeError naming the accepted keys', async () => {
    await expect(
      newClient().updateCollection('docs', {
        storage_mode: 'fast',
      } as unknown as { storageMode: 'fast' })
    ).rejects.toThrow(
      /updateCollection: unknown option\(s\): storage_mode\. Accepted: description, storageMode\./
    );
  });
});

describe('error envelope: extras on the error object', () => {
  it('a 409 carries the error object as ConflictError.details', () => {
    const error = createErrorFromResponse(
      {
        error: {
          code: 'STORAGE_MODE_CHANGE_TOO_SOON',
          message: 'x',
          retry_after_seconds: 12,
        },
      },
      409,
      'Conflict'
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toMatchObject({
      retry_after_seconds: 12,
    });
  });

  it('a 400 names its field from the error object', () => {
    const error = createErrorFromResponse(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'x',
          field: 'storage_mode',
        },
      },
      400,
      'Bad Request'
    ) as ValidationError;
    expect(error.field).toBe('storage_mode');
  });
});

describe('FakeVectorsClient (the memory layer tests share it)', () => {
  it('a collection starts exact and reads back its mode', async () => {
    const fake = new FakeVectorsClient();
    await fake.createCollection('c', VECTORS);
    expect((await fake.getCollection('c')).storageMode).toBe(StorageMode.EXACT);
  });

  it('create honours a named mode', async () => {
    const fake = new FakeVectorsClient();
    const col = await fake.createCollection('c', VECTORS, {
      storageMode: StorageMode.BALANCED,
    });
    expect(col.storageMode).toBe(StorageMode.BALANCED);
  });

  it('an unknown mode is a ValidationError', async () => {
    const fake = new FakeVectorsClient();
    await expect(
      fake.createCollection('c', VECTORS, {
        storageMode: 'turbo' as unknown as 'exact',
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('compact below the floor is a 422-shaped ValidationError', async () => {
    const fake = new FakeVectorsClient();
    const error = await fake
      .createCollection(
        'c',
        { size: 384, distance: DistanceMetric.COSINE },
        { storageMode: StorageMode.COMPACT }
      )
      .catch(e => e);
    expect(error.code).toBe('STORAGE_MODE_UNSUITABLE');
    await expect(
      fake.createCollection('ok', VECTORS, {
        storageMode: StorageMode.COMPACT,
      })
    ).resolves.toBeDefined();
  });

  it('the cooldown blocks a second change until it has passed', async () => {
    const fake = new FakeVectorsClient();
    await fake.createCollection('c', VECTORS);
    await fake.updateCollection('c', { storageMode: 'fast' });
    fake.now = 100;
    const error = await fake
      .updateCollection('c', { storageMode: 'balanced' })
      .catch(e => e);
    expect(error.code).toBe('STORAGE_MODE_CHANGE_TOO_SOON');
    expect(error.details.retry_after_seconds).toBe(800);
    expect((await fake.getCollection('c')).storageMode).toBe('fast');
    fake.now = 900;
    await fake.updateCollection('c', { storageMode: 'balanced' });
    expect((await fake.getCollection('c')).storageMode).toBe('balanced');
  });

  it('asking for the current mode is a no-op that starts no cooldown', async () => {
    const fake = new FakeVectorsClient();
    await fake.createCollection('c', VECTORS);
    await fake.updateCollection('c', { storageMode: 'exact' });
    await expect(
      fake.updateCollection('c', { storageMode: 'fast' })
    ).resolves.toBe(true);
  });
});

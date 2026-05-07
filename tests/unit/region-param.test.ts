/**
 * Unit tests for the region= constructor option and /api/v1/regions
 * discovery on AetherfyVectorsClient.
 *
 * Pins the contract:
 *   - region= validates against the Fly set (iad/fra/sin) eagerly.
 *   - `await AetherfyVectorsClient.create({region: 'fra'})` runs
 *     discovery on the default global endpoint and returns a
 *     fully-ready client (mirrors Python's __init__).
 *   - `new AetherfyVectorsClient({region: 'fra'})` THROWS unless an
 *     override (endpoint= or AETHERFY_VECTORS_URL) is also present —
 *     async discovery isn't safe inside a sync constructor and
 *     silently deferring is a footgun.
 *   - When env var and region= both set, env var wins and console.warn
 *     fires (production-agent protection).
 *   - Discovery failure throws AetherfyVectorsError with a clear
 *     message at the `create()` call site (not lazily on first method).
 */

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import {
  AetherfyVectorsError,
  CollectionInOtherRegionError,
  createErrorFromResponse,
} from '../../src/exceptions';

const DEFAULT = 'https://vectors.aetherfy.com';

describe('AetherfyVectorsClient region= + discovery', () => {
  beforeEach(() => {
    delete process.env.AETHERFY_VECTORS_URL;
    delete process.env.AETHERFY_VECTORS_REGION;
    nock.cleanAll();
  });

  afterEach(() => {
    if (!nock.isDone()) {
      // eslint-disable-next-line no-console
      console.warn('Pending nock interceptors:', nock.pendingMocks());
      nock.cleanAll();
    }
  });

  describe('validation', () => {
    it('create() throws synchronously for an unknown region', async () => {
      await expect(
        AetherfyVectorsClient.create({
          apiKey: 'afy_test_1234567890123456',
          region: 'xxx' as 'iad',
          enableConnectionPooling: false,
        })
      ).rejects.toThrow(/region must be one of iad, fra, sin/);
    });

    it('new throws when region= is passed without an override', () => {
      // The footgun guard: silent lazy resolution would bite users
      // who didn't realize their first method call could 30s later
      // surface a discovery failure.
      expect(() => {
        new AetherfyVectorsClient({
          apiKey: 'afy_test_1234567890123456',
          region: 'fra',
          enableConnectionPooling: false,
        });
      }).toThrow(/region= requires async region discovery.*create/);
    });

    it('new throws for an unknown region even when endpoint= is provided', () => {
      // Validation must fire regardless of construction path — a caller
      // bypassing create() with their own endpoint shouldn't slip an
      // invalid region label through.
      expect(() => {
        new AetherfyVectorsClient({
          apiKey: 'afy_test_1234567890123456',
          region: 'xxx' as 'iad',
          endpoint: 'https://vectors-fra.aetherfy.run',
          enableConnectionPooling: false,
        });
      }).toThrow(/region must be one of iad, fra, sin/);
    });

    it('new accepts region= when endpoint= is also passed (no discovery needed)', () => {
      // create() uses this path internally — pre-resolved endpoint,
      // region= just labels the .region field for callers.
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        region: 'fra',
        endpoint: 'https://vectors-fra.aetherfy.run',
        enableConnectionPooling: false,
      });
      expect(client.region).toBe('fra');
      expect((client as unknown as { endpoint: string }).endpoint).toBe(
        'https://vectors-fra.aetherfy.run'
      );
    });
  });

  describe('discovery via create()', () => {
    it('resolves region=fra to the per-region URL via /api/v1/regions', async () => {
      nock(DEFAULT).get('/api/v1/regions').reply(200, {
        iad: 'https://vectors-iad.aetherfy.run',
        fra: 'https://vectors-fra.aetherfy.run',
        sin: 'https://vectors-sin.aetherfy.run',
      });

      const client = await AetherfyVectorsClient.create({
        apiKey: 'afy_test_1234567890123456',
        region: 'fra',
        enableConnectionPooling: false,
      });
      expect(client.region).toBe('fra');
      expect((client as unknown as { endpoint: string }).endpoint).toBe(
        'https://vectors-fra.aetherfy.run'
      );
    });

    it('two create() calls each issue their own discovery request', async () => {
      // Per-creation discovery; no module-global state leaks across
      // independently constructed clients (e.g. test suite vs prod).
      nock(DEFAULT).get('/api/v1/regions').twice().reply(200, {
        iad: 'https://vectors-iad.aetherfy.run',
        fra: 'https://vectors-fra.aetherfy.run',
      });

      const c1 = await AetherfyVectorsClient.create({
        apiKey: 'afy_test_1234567890123456',
        region: 'iad',
        enableConnectionPooling: false,
      });
      const c2 = await AetherfyVectorsClient.create({
        apiKey: 'afy_test_1234567890123456',
        region: 'fra',
        enableConnectionPooling: false,
      });
      expect((c1 as unknown as { endpoint: string }).endpoint).toBe(
        'https://vectors-iad.aetherfy.run'
      );
      expect((c2 as unknown as { endpoint: string }).endpoint).toBe(
        'https://vectors-fra.aetherfy.run'
      );
      expect(nock.isDone()).toBe(true);
    });

    it('discovery 5xx → AetherfyVectorsError at the create() call site', async () => {
      nock(DEFAULT).get('/api/v1/regions').reply(500, {});

      await expect(
        AetherfyVectorsClient.create({
          apiKey: 'afy_test_1234567890123456',
          region: 'fra',
          enableConnectionPooling: false,
        })
      ).rejects.toBeInstanceOf(AetherfyVectorsError);
    });

    it('discovery missing the requested region → throws with available list', async () => {
      nock(DEFAULT).get('/api/v1/regions').reply(200, {
        iad: 'https://vectors-iad.aetherfy.run',
      });

      await expect(
        AetherfyVectorsClient.create({
          apiKey: 'afy_test_1234567890123456',
          region: 'fra',
          enableConnectionPooling: false,
        })
      ).rejects.toThrow(/not configured at the discovery endpoint/);
    });
  });

  describe('precedence', () => {
    it('AETHERFY_VECTORS_URL wins over region= and warns (via create)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        process.env.AETHERFY_VECTORS_URL = 'http://10.0.10.243:3000';
        // create() short-circuits to the sync constructor when the env
        // var is set; no /api/v1/regions request is made.
        const client = await AetherfyVectorsClient.create({
          apiKey: 'afy_test_1234567890123456',
          region: 'fra',
          enableConnectionPooling: false,
        });
        expect((client as unknown as { endpoint: string }).endpoint).toBe(
          'http://10.0.10.243:3000'
        );
        expect(warnSpy).toHaveBeenCalled();
        const msg = warnSpy.mock.calls[0][0] as string;
        expect(msg).toMatch(/AETHERFY_VECTORS_URL/);
        expect(msg).toMatch(/region=fra/);
      } finally {
        delete process.env.AETHERFY_VECTORS_URL;
        warnSpy.mockRestore();
      }
    });

    it('explicit endpoint= skips discovery entirely (via create)', async () => {
      // No nock interceptor — if discovery were triggered, the test
      // would fail with a network error.
      const client = await AetherfyVectorsClient.create({
        apiKey: 'afy_test_1234567890123456',
        endpoint: 'http://localhost:3000',
        region: 'fra',
        enableConnectionPooling: false,
      });
      expect((client as unknown as { endpoint: string }).endpoint).toBe(
        'http://localhost:3000'
      );
    });

    it('new without region= still works for sync paths (no breaking change)', () => {
      // Backward path for callers that don't need region discovery —
      // explicit endpoint, env var, or default URL.
      const client = new AetherfyVectorsClient({
        apiKey: 'afy_test_1234567890123456',
        endpoint: 'http://localhost:3000',
        enableConnectionPooling: false,
      });
      expect(client.region).toBe(null);
      expect((client as unknown as { endpoint: string }).endpoint).toBe(
        'http://localhost:3000'
      );
    });
  });

  describe('analytics endpoint follows region', () => {
    // create() returns a client with analytics already pinned to the
    // resolved per-region URL — analytics is constructed AFTER the
    // endpoint is final. No transient state, no setBaseUrl shenanigans.
    it('analytics.baseUrl matches the resolved per-region URL', async () => {
      nock(DEFAULT).get('/api/v1/regions').reply(200, {
        iad: 'https://vectors-iad.aetherfy.run',
        fra: 'https://vectors-fra.aetherfy.run',
      });

      const client = await AetherfyVectorsClient.create({
        apiKey: 'afy_test_1234567890123456',
        region: 'fra',
        enableConnectionPooling: false,
      });
      const analytics = (
        client as unknown as { analytics: { baseUrl: string } }
      ).analytics;
      expect(analytics.baseUrl).toBe('https://vectors-fra.aetherfy.run');
    });
  });

  describe('CollectionInOtherRegionError', () => {
    // Pins createErrorFromResponse's mapping of the 409 reject body to
    // a typed exception. Callers can branch on instanceof and read the
    // typed fields without parsing the message string.
    it('maps COLLECTION_EXISTS_IN_OTHER_REGION 409 → typed exception', () => {
      const body = {
        error: {
          code: 'COLLECTION_EXISTS_IN_OTHER_REGION',
          message: "Collection 'foo' already exists in region fra. ...",
          collection_name: 'foo',
          existing_regions: ['fra'],
          requesting_region: 'iad',
        },
      };
      const err = createErrorFromResponse(body, 409, 'Conflict');
      expect(err).toBeInstanceOf(CollectionInOtherRegionError);
      const typed = err as CollectionInOtherRegionError;
      expect(typed.collectionName).toBe('foo');
      expect(typed.existingRegions).toEqual(['fra']);
      expect(typed.requestingRegion).toBe('iad');
      expect(typed.statusCode).toBe(409);
    });

    it('other 409 codes still resolve to ConflictError (not over-typed)', () => {
      const body = { error: { code: 'SOMETHING_ELSE', message: 'nope' } };
      const err = createErrorFromResponse(body, 409, 'Conflict');
      expect(err).not.toBeInstanceOf(CollectionInOtherRegionError);
      expect(err.statusCode).toBe(409);
    });
  });
});

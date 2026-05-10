/**
 * Unit tests for client.setPayload / overwritePayload / deletePayload.
 *
 * Pins:
 *   - HTTP method + path + body shape match the backend's payload endpoints.
 *   - Validators (collection name, point IDs) fire before the request.
 *   - HttpClient.delete() carries a body — extended in this commit.
 */

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { PointNotFoundError } from '../../src/exceptions';

const ENDPOINT = 'https://vectors.aetherfy.com';

function makeClient(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    endpoint: ENDPOINT,
    enableConnectionPooling: false,
  });
}

describe('AetherfyVectorsClient payload methods', () => {
  afterEach(() => {
    nock.cleanAll();
  });

  describe('setPayload', () => {
    it('POSTs to /points/payload with { payload, points }', async () => {
      const client = makeClient();
      const expectedBody = { payload: { tag: 'new' }, points: ['p1', 'p2'] };

      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload', expectedBody)
        .reply(200, { result: { status: 'ok' } });

      const out = await client.setPayload('col', { tag: 'new' }, ['p1', 'p2']);
      expect(out).toEqual({ result: { status: 'ok' } });
    });

    it('throws ValidationError on invalid collection name (no request fires)', async () => {
      const client = makeClient();
      // No nock interceptor — if the request fires, nock throws "no match".
      await expect(client.setPayload('', { x: 1 }, ['p1'])).rejects.toThrow(
        /Collection name/i
      );
    });

    it('upstream non-2xx surfaces through handleError (catch branch coverage)', async () => {
      const client = makeClient();

      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload')
        .reply(429, {
          error: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow down' },
        });

      await expect(
        client.setPayload('col', { x: 1 }, ['p1'])
      ).rejects.toThrow();
    });
  });

  describe('overwritePayload', () => {
    it('PUTs to /points/payload with { payload, points }', async () => {
      const client = makeClient();

      nock(ENDPOINT)
        .put('/api/v1/collections/col/points/payload', {
          payload: { only: 'this' },
          points: ['p1'],
        })
        .reply(200, { result: { status: 'ok' } });

      const out = await client.overwritePayload('col', { only: 'this' }, [
        'p1',
      ]);
      expect(out).toEqual({ result: { status: 'ok' } });
    });

    it('upstream non-2xx surfaces through handleError (catch branch coverage)', async () => {
      const client = makeClient();

      nock(ENDPOINT)
        .put('/api/v1/collections/col/points/payload')
        .reply(503, {
          error: { code: 'SERVICE_UNAVAILABLE', message: 'try later' },
        });

      await expect(
        client.overwritePayload('col', { x: 1 }, ['p1'])
      ).rejects.toThrow();
    });
  });

  describe('deletePayload', () => {
    it('POSTs to /points/payload/delete with { keys, points } in the body', async () => {
      const client = makeClient();

      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload/delete', {
          keys: ['old_tag', 'old_meta'],
          points: ['p1', 'p2'],
        })
        .reply(200, { result: { status: 'ok' } });

      const out = await client.deletePayload(
        'col',
        ['old_tag', 'old_meta'],
        ['p1', 'p2']
      );
      expect(out).toEqual({ result: { status: 'ok' } });
    });

    it('validates collection name before sending', async () => {
      const client = makeClient();
      await expect(client.deletePayload('', ['k'], ['p1'])).rejects.toThrow(
        /Collection name/i
      );
    });

    it('upstream non-2xx surfaces through handleError (catch branch coverage)', async () => {
      const client = makeClient();

      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload/delete')
        .reply(500, { error: { code: 'INTERNAL_ERROR', message: 'oops' } });

      await expect(
        client.deletePayload('col', ['k'], ['p1'])
      ).rejects.toThrow();
    });
  });

  describe('setPayload key= option', () => {
    it('includes key in the body when set', async () => {
      const client = makeClient();
      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload', {
          payload: { a: 1 },
          points: ['p1'],
          key: 'metadata',
        })
        .reply(200, { result: { status: 'ok' } });

      await client.setPayload('col', { a: 1 }, ['p1'], { key: 'metadata' });
    });

    it('omits key from the body when not set', async () => {
      const client = makeClient();
      nock(ENDPOINT)
        .post(
          '/api/v1/collections/col/points/payload',
          body => !('key' in body)
        )
        .reply(200, { result: { status: 'ok' } });

      await client.setPayload('col', { a: 1 }, ['p1']);
    });
  });

  describe('mergeMetadata', () => {
    it('POSTs partial under payload with key="metadata"', async () => {
      const client = makeClient();
      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload', {
          payload: { tag: 'x' },
          points: ['p1'],
          key: 'metadata',
        })
        .reply(200, { result: { status: 'ok' } });

      const out = await client.mergeMetadata('col', 'p1', { tag: 'x' });
      expect(out).toEqual({ result: { status: 'ok' } });
    });

    it('rejects non-object partial with TypeError', async () => {
      const client = makeClient();
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.mergeMetadata('col', 'p1', 'nope' as any)
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.mergeMetadata('col', 'p1', [1] as any)
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('translates a generic 404 into PointNotFoundError', async () => {
      const client = makeClient();
      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload')
        .reply(404, { message: 'No point with id missing found' });

      await expect(
        client.mergeMetadata('col', 'missing', { a: 1 })
      ).rejects.toBeInstanceOf(PointNotFoundError);
    });
  });

  describe('deleteMetadataKeys', () => {
    it('POSTs to /points/payload/delete with dotted metadata.<k> keys', async () => {
      const client = makeClient();
      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload/delete', {
          keys: ['metadata.k1', 'metadata.k2'],
          points: ['p1'],
        })
        .reply(200, { result: { status: 'ok' } });

      const out = await client.deleteMetadataKeys('col', 'p1', ['k1', 'k2']);
      expect(out).toEqual({ result: { status: 'ok' } });
    });

    it('rejects non-string-array keys with TypeError', async () => {
      const client = makeClient();
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.deleteMetadataKeys('col', 'p1', 'k1' as any)
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client.deleteMetadataKeys('col', 'p1', ['k1', 2] as any)
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('translates a generic 404 into PointNotFoundError', async () => {
      const client = makeClient();
      nock(ENDPOINT)
        .post('/api/v1/collections/col/points/payload/delete')
        .reply(404, { message: 'No point with id missing found' });

      await expect(
        client.deleteMetadataKeys('col', 'missing', ['k1'])
      ).rejects.toBeInstanceOf(PointNotFoundError);
    });
  });
});

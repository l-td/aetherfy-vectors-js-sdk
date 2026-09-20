/**
 * Unit tests for createFieldIndex / deleteFieldIndex.
 *
 * The payload-index route has existed on the backend (and replicated) for a
 * while — `PUT /collections/{name}/index` and
 * `DELETE /collections/{name}/index/{field_name}`, both on the catch-all
 * allowlist and in the proxy's replicationEndpoints — but neither vectors SDK
 * exposed it. Filtering on an unindexed key is a SCAN, not a lookup, so an SDK
 * that can create a tenant key but not index it hands the customer a
 * collection that gets slower with every tenant.
 *
 * Parity file with the Python SDK's tests/test_field_index.py.
 */

import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import { ValidationError } from '../../src/exceptions';

const HOST = 'https://vectors.aetherfy.com';

function newClient(workspace?: string): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
    ...(workspace ? { workspace } : {}),
  });
}

describe('createFieldIndex', () => {
  afterEach(() => nock.cleanAll());

  it('PUTs field_name and field_schema to the index route', async () => {
    let seen: unknown;
    const scope = nock(HOST)
      .put('/api/v1/collections/articles/index', body => {
        seen = body;
        return true;
      })
      .reply(200, { result: true });

    await expect(
      newClient().createFieldIndex('articles', 'thread_id')
    ).resolves.toBe(true);

    expect(seen).toEqual({
      field_name: 'thread_id',
      field_schema: 'keyword',
    });
    scope.done();
  });

  it('forwards the schema verbatim', async () => {
    let seen: Record<string, unknown> = {};
    const scope = nock(HOST)
      .put('/api/v1/collections/articles/index', body => {
        seen = body as Record<string, unknown>;
        return true;
      })
      .reply(200, { result: true });

    await newClient().createFieldIndex('articles', 'flag', 'bool');
    expect(seen.field_schema).toBe('bool');
    scope.done();
  });

  it('forwards a parameterised schema object verbatim', async () => {
    let seen: Record<string, unknown> = {};
    const scope = nock(HOST)
      .put('/api/v1/collections/articles/index', body => {
        seen = body as Record<string, unknown>;
        return true;
      })
      .reply(200, { result: true });

    const schema = { type: 'text', tokenizer: 'word', lowercase: true };
    await newClient().createFieldIndex('articles', 'body', schema);
    expect(seen.field_schema).toEqual(schema);
    scope.done();
  });

  it('routes through the nested workspace URL', async () => {
    const scope = nock(HOST)
      .put('/api/v1/workspaces/team-alpha/collections/articles/index')
      .reply(200, { result: true });

    await newClient('team-alpha').createFieldIndex('articles', 'thread_id');
    scope.done();
  });

  it('rejects an empty field name locally', async () => {
    await expect(newClient().createFieldIndex('articles', '')).rejects.toThrow(
      ValidationError
    );
    // No interceptor was registered, so a request would have thrown a
    // NetworkError instead — the local rejection is what kept it off the wire.
    expect(nock.pendingMocks()).toEqual([]);
  });

  it('rejects an invalid collection name locally', async () => {
    await expect(
      newClient().createFieldIndex('bad/name', 'thread_id')
    ).rejects.toThrow(ValidationError);
  });
});

describe('deleteFieldIndex', () => {
  afterEach(() => nock.cleanAll());

  it('DELETEs the field-scoped route', async () => {
    const scope = nock(HOST)
      .delete('/api/v1/collections/articles/index/thread_id')
      .reply(200, { result: true });

    await expect(
      newClient().deleteFieldIndex('articles', 'thread_id')
    ).resolves.toBe(true);
    scope.done();
  });

  it('URL-encodes a field name containing a separator', async () => {
    // The field name is one path segment; a '/' inside it must not become a
    // separator, or the request lands on a path the allowlist rejects.
    const scope = nock(HOST)
      .delete('/api/v1/collections/articles/index/metadata%2Ftag')
      .reply(200, { result: true });

    await newClient().deleteFieldIndex('articles', 'metadata/tag');
    scope.done();
  });

  it('returns false rather than throwing when the index is already gone', async () => {
    const scope = nock(HOST)
      .delete('/api/v1/collections/articles/index/thread_id')
      .reply(404, { error: { code: 'NOT_FOUND', message: 'no such index' } });

    await expect(
      newClient().deleteFieldIndex('articles', 'thread_id')
    ).resolves.toBe(false);
    scope.done();
  });

  it('rejects an empty field name locally', async () => {
    await expect(newClient().deleteFieldIndex('articles', '')).rejects.toThrow(
      ValidationError
    );
  });
});

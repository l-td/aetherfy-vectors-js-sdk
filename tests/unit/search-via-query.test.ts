/**
 * search() goes through POST /collections/{name}/points/query.
 *
 * The API refuses Qdrant's retired /points/search (410 ROUTE_RETIRED), so
 * search() sends the query route. Its public call and options are unchanged;
 * this pins the translation of EVERY option into the query body, and the
 * reading of the query response (result.points, not result).
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';

const BASE = 'https://vectors.aetherfy.com';
const QUERY_PATH = '/api/v1/collections/docs/points/query';
const VECTOR = [0.1, 0.2, 0.3];

function makeClient(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
  });
}

afterEach(() => nock.cleanAll());

describe('search() sends POST /points/query', () => {
  it('translates every option into the query body', async () => {
    let sent: Record<string, unknown> = {};
    const scope = nock(BASE)
      .post(QUERY_PATH, (body: Record<string, unknown>) => {
        sent = body;
        return true;
      })
      .reply(200, { result: { points: [] } });

    await makeClient().search('docs', VECTOR, {
      limit: 7,
      offset: 3,
      queryFilter: { must: [{ key: 'city', match: { value: 'Rome' } }], mustNot: [{ key: 'n', range: { gt: 5 } }] },
      withPayload: false,
      withVectors: true,
      scoreThreshold: 0.42,
      searchParams: { hnsw_ef: 256, exact: false },
    });

    expect(scope.isDone()).toBe(true);
    expect(sent).toEqual({
      query: VECTOR,
      limit: 7,
      offset: 3,
      filter: { must: [{ key: 'city', match: { value: 'Rome' } }], must_not: [{ key: 'n', range: { gt: 5 } }] },
      with_payload: false,
      with_vector: true,
      score_threshold: 0.42,
      params: { hnsw_ef: 256, exact: false },
    });
    // The retired spelling of the vector is gone from the body.
    expect(sent).not.toHaveProperty('vector');
  });

  it('reads the matches from result.points', async () => {
    const points = [
      { id: 1, version: 0, score: 0.99, payload: { t: 'a' } },
      { id: 'b3f7', version: 2, score: 0.5, payload: { t: 'b' }, vector: [1, 0, 0] },
    ];
    nock(BASE).post(QUERY_PATH).reply(200, { result: { points }, status: 'ok', time: 0.001 });

    expect(await makeClient().search('docs', VECTOR)).toEqual(points);
  });

  it('never calls the retired /points/search', async () => {
    const retired = nock(BASE).post('/api/v1/collections/docs/points/search').reply(410, {
      error: { code: 'ROUTE_RETIRED', message: 'retired' },
    });
    nock(BASE).post(QUERY_PATH).reply(200, { result: { points: [] } });

    await makeClient().search('docs', VECTOR);
    expect(retired.isDone()).toBe(false);
  });
});

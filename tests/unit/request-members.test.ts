/**
 * The members of the request bodies the API does not validate itself.
 *
 * The API checks every body of the filtered and point-writing endpoints (query,
 * scroll, count, delete, payload, upsert) key by key; those bodies are held to it
 * by its own tests, which read `tests/fixtures/request-bodies.json` (what the
 * client sends, kept true by `request-bodies-fixture.test.ts`) and send each
 * through that validation. There is no copy of that list here: one rule, one gate.
 *
 * What is left is the endpoints that validation does NOT judge, where the API's
 * handler simply reads the members it documents: collection create, field index,
 * schema and analyze, and retrieve. For those this file keeps the documented
 * members, and holds every body in the fixture to them.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RequestBodyRow } from './record-request-bodies';

const FIXTURE = path.resolve(__dirname, '../fixtures/request-bodies.json');

/** "METHOD path-suffix" -> the members the endpoint documents. */
const UNJUDGED: Record<string, string[]> = {
  'POST collections': ['name', 'vectors', 'description', 'regions'],
  'PUT index': ['field_name', 'field_schema'],
  'PUT schema': ['schema', 'enforcement_mode', 'description'],
  'POST schema/analyze': ['sample_size'],
  'POST points/retrieve': ['ids', 'with_payload', 'with_vector'],
};

function endpointOf(method: string, route: string): string | undefined {
  return Object.keys(UNJUDGED)
    .sort((a, b) => b.length - a.length)
    .find(key => {
      const [verb, suffix] = key.split(' ');
      return verb === method && route.endsWith(suffix);
    });
}

/** The members of `body` the endpoint does not document. */
function refused(
  method: string,
  route: string,
  body: Record<string, unknown>
): string[] {
  const endpoint = endpointOf(method, route) as string;
  return Object.keys(body).filter(k => !UNJUDGED[endpoint].includes(k));
}

const rows = (): RequestBodyRow[] =>
  JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as RequestBodyRow[];

describe('the bodies of the endpoints the API does not validate', () => {
  it('carry only documented members', () => {
    const judged = rows().filter(r => endpointOf(r.method, r.route));
    const built = new Set(judged.map(r => endpointOf(r.method, r.route)));
    expect([...built].sort()).toEqual(Object.keys(UNJUDGED).sort());
    for (const r of judged) {
      expect({
        name: r.name,
        refused: refused(r.method, r.route, r.body),
      }).toEqual({ name: r.name, refused: [] });
    }
  });

  it('are the only ones with a copy here', () => {
    for (const route of [
      '/collections/docs/points/query',
      '/collections/docs/points/scroll',
      '/collections/docs/points/count',
      '/collections/docs/points/delete',
      '/collections/docs/points/payload',
    ]) {
      expect(endpointOf('POST', route)).toBeUndefined();
    }
    expect(endpointOf('PUT', '/collections/docs/points')).toBeUndefined();
  });
});

describe('CONTROL: a stray member is named', () => {
  it.each([
    ['POST', '/collections', { name: 'x', vectors: {}, bogus: 1 }, ['bogus']],
    [
      'PUT',
      '/collections/docs/index',
      { field_name: 'a', field_type: 'keyword' },
      ['field_type'],
    ],
    [
      'PUT',
      '/collections/docs/schema',
      { schema: {}, mode: 'strict' },
      ['mode'],
    ],
    [
      'POST',
      '/collections/docs/schema/analyze',
      { sample_size: 1, limit: 2 },
      ['limit'],
    ],
    [
      'POST',
      '/collections/docs/points/retrieve',
      { ids: [1], with_vectors: true },
      ['with_vectors'],
    ],
  ])('%s %s', (method, route, body, expected) => {
    expect(refused(method, route, body)).toEqual(expected);
  });
});

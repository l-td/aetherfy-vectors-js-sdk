/**
 * An error built from a server's answer carries the server's code.
 *
 * Found by the live e2e: deleteSchema caught the server's 404 and threw a
 * fresh SchemaNotFoundError whose `code` was undefined (the server said
 * SCHEMA_NOT_DEFINED). Code branching on `err.code` never matched.
 *
 * Two kinds of test: the sites that rebuild an error are driven with the
 * contract sheet's bodies, and a rule reads src/client.ts with the TypeScript
 * compiler and fails when a `catch` block throws an SDK error that does not
 * carry the code, unless the case is listed with its reason.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import nock from 'nock';
import * as ts from 'typescript';
import { AetherfyVectorsClient } from '../../src/client';
import {
  AetherfyVectorsError,
  SchemaNotFoundError,
  ValidationError,
} from '../../src/exceptions';

const BASE = 'https://vectors.aetherfy.com';
const WS = '/api/v1/workspaces/w';

function client(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    workspace: 'w',
    enableConnectionPooling: false,
  });
}

function httpError(status: number, code: string): Error {
  return Object.assign(new Error('x'), {
    status,
    statusText: 'x',
    responseData: { error: { code, message: `${code} (prose)` } },
  });
}

afterEach(() => nock.cleanAll());

describe('deleteSchema (the reported bug)', () => {
  it.each(['SCHEMA_NOT_DEFINED', 'COLLECTION_NOT_FOUND'])(
    'a %s 404 is a SchemaNotFoundError carrying that code',
    async code => {
      nock(BASE)
        .delete(`${WS}/collections/docs/schema`)
        .reply(404, { error: { code, message: 'x', collection_name: 'docs' } });

      const err = await client()
        .deleteSchema('docs')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(SchemaNotFoundError);
      expect((err as SchemaNotFoundError).code).toBe(code);
      expect((err as SchemaNotFoundError).statusCode).toBe(404);
    }
  );
});

describe('an upsert chunk', () => {
  // Drive the chunk upload with the HTTP layer stubbed: no schema fetches, no
  // retry loop around the one error under test.
  function chunkClient(put: () => Promise<unknown>) {
    const c = client();
    (c as unknown as { httpClient: unknown }).httpClient = { put };
    (c as unknown as { fetchAndCacheSchema: unknown }).fetchAndCacheSchema =
      jest.fn().mockRejectedValue(new Error('retry failed'));
    (
      c as unknown as { getCachedPayloadSchema: unknown }
    ).getCachedPayloadSchema = jest.fn().mockResolvedValue(null);
    return (
      c as unknown as {
        _uploadPointsChunk(
          scoped: string,
          name: string,
          chunk: unknown[],
          schema: { etag?: string },
          payload: null
        ): Promise<boolean>;
      }
    )._uploadPointsChunk.bind(c);
  }

  const call = (upload: ReturnType<typeof chunkClient>) =>
    upload('w/docs', 'docs', [{ id: 1, vector: [0.1] }], {}, null).catch(
      (e: unknown) => e
    );

  it('a 400 is a ValidationError carrying the server code', async () => {
    const err = await call(
      chunkClient(() => Promise.reject(httpError(400, 'VALIDATION_ERROR')))
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).code).toBe('VALIDATION_ERROR');
  });

  it('a 5xx keeps its status and carries the server code', async () => {
    const err = await call(
      chunkClient(() => Promise.reject(httpError(500, 'INTERNAL_ERROR')))
    );
    expect(err).toBeInstanceOf(AetherfyVectorsError);
    expect((err as AetherfyVectorsError).statusCode).toBe(500);
    expect((err as AetherfyVectorsError).code).toBe('INTERNAL_ERROR');
  });

  it('a 412 whose retry fails carries the 412 code', async () => {
    const err = await call(
      chunkClient(() =>
        Promise.reject(httpError(412, 'SCHEMA_VERSION_MISMATCH'))
      )
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toMatch(/schema has changed/);
    expect((err as ValidationError).code).toBe('SCHEMA_VERSION_MISMATCH');
  });
});

describe('region discovery', () => {
  afterEach(() => {
    delete process.env.AETHERFY_VECTORS_URL;
  });

  it('a failing answer carries the server code', async () => {
    delete process.env.AETHERFY_VECTORS_URL;
    nock(BASE)
      .get('/api/v1/regions')
      .reply(503, {
        error: { code: 'WORKSPACE_LOOKUP_UNAVAILABLE', message: 'x' },
      });

    const err = await AetherfyVectorsClient.create({
      apiKey: 'afy_test_1234567890123456',
      workspace: 'w',
      apiRegion: 'eu-central-1',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AetherfyVectorsError);
    expect((err as AetherfyVectorsError).code).toBe(
      'WORKSPACE_LOOKUP_UNAVAILABLE'
    );
  });
});

// ---------------------------------------------------------------------------
// The rule: no catch block replaces a server error with a code-less one
// ---------------------------------------------------------------------------

/** `function: Class` thrown inside a catch WITHOUT the server's code, and why
 *  that is right: it is not built from a server answer. */
const NO_SERVER_ANSWER: Record<string, string> = {
  '_uploadPointsChunk: SchemaValidationError':
    "the client's own validation of the refreshed schema, not a server answer",
};

const NOT_SDK_ERRORS = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
]);

function throwsInCatch(): { key: string; where: string }[] {
  const path = join(__dirname, '..', '..', 'src', 'client.ts');
  const file = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  const found: { key: string; where: string }[] = [];

  const enclosing = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      if (
        (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) &&
        n.name
      ) {
        return n.name.getText(file);
      }
    }
    return '<module>';
  };
  const inCatch = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isCatchClause(n)) return true;
      if (ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return false;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    if (ts.isThrowStatement(node) && node.expression && inCatch(node)) {
      const expr = node.expression;
      if (
        ts.isNewExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        /Error$/.test(expr.expression.text) &&
        !NOT_SDK_ERRORS.has(expr.expression.text)
      ) {
        const cls = expr.expression.text;
        const line = file.getLineAndCharacterOfPosition(node.getStart(file));
        found.push({
          key: `${enclosing(node)}: ${cls}`,
          where: `${enclosing(node)}: throw new ${cls} (line ${line.line + 1})`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

it('no catch block throws an SDK error without the servers code', () => {
  const unlisted = throwsInCatch().filter(t => !(t.key in NO_SERVER_ANSWER));
  expect(unlisted.map(t => t.where)).toEqual([]);
});

it('the exception list has no stale entries', () => {
  const thrown = new Set(throwsInCatch().map(t => t.key));
  expect(Object.keys(NO_SERVER_ANSWER).filter(k => !thrown.has(k))).toEqual([]);
});

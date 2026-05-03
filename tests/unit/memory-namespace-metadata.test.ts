/**
 * Unit tests for Namespace.setMetadata() and Namespace.iter().
 * Both are thin delegating helpers; the tests pin that they call the right
 * vectors-client method with the right arguments.
 */

import { Namespace } from '../../src/memory/namespace';
import type { AetherfyVectorsClient } from '../../src/client';

function makeNamespace() {
  const client = {
    setPayload: jest.fn().mockResolvedValue({ status: 'ok' }),
    scrollIter: jest.fn(),
  } as unknown as AetherfyVectorsClient;
  const ns = new Namespace('my-ns', 'user_X_my-ns', client);
  return {
    ns,
    client: client as unknown as {
      setPayload: jest.Mock;
      scrollIter: jest.Mock;
    },
  };
}

describe('Namespace.setMetadata', () => {
  it('calls client.setPayload with payload={metadata: ...} and the id wrapped in an array', async () => {
    const { ns, client } = makeNamespace();
    const out = await ns.setMetadata('p1', { foo: 1, bar: true });

    expect(client.setPayload).toHaveBeenCalledWith(
      'user_X_my-ns',
      { metadata: { foo: 1, bar: true } },
      ['p1']
    );
    expect(out).toEqual({ status: 'ok' });
  });

  it('passes integer ids through unchanged', async () => {
    const { ns, client } = makeNamespace();
    await ns.setMetadata(42, { x: 1 });
    expect(client.setPayload.mock.calls[0][2]).toEqual([42]);
  });
});

describe('Namespace.iter', () => {
  // Helper to convert sync values into an async iterable that scrollIter can return.
  async function* makeAsyncIter<T>(items: T[]): AsyncGenerator<T> {
    for (const item of items) yield item;
  }

  it('yields each point from client.scrollIter', async () => {
    const { ns, client } = makeNamespace();
    client.scrollIter.mockReturnValue(
      makeAsyncIter([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    );

    const out: Array<string | number> = [];
    for await (const p of ns.iter()) out.push(p.id);

    expect(out).toEqual(['a', 'b', 'c']);
    expect(client.scrollIter).toHaveBeenCalledWith(
      'user_X_my-ns',
      expect.objectContaining({
        batchSize: undefined,
        scrollFilter: undefined,
        withPayload: undefined,
        withVectors: undefined,
      })
    );
  });

  it('forwards batchSize, filter, withPayload, withVectors to scrollIter', async () => {
    const { ns, client } = makeNamespace();
    client.scrollIter.mockReturnValue(makeAsyncIter([]));
    const flt = { must: [{ key: 'x', match: { value: 'y' } }] };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of ns.iter({
      batchSize: 100,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filter: flt as any,
      withPayload: false,
      withVectors: true,
    })) {
      /* no-op */
    }

    expect(client.scrollIter).toHaveBeenCalledWith('user_X_my-ns', {
      batchSize: 100,
      scrollFilter: flt,
      withPayload: false,
      withVectors: true,
    });
  });
});

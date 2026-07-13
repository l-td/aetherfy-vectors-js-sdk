/**
 * Unit tests for Namespace.setMetadata() and Namespace.iter().
 * Both are thin delegating helpers; the tests pin that they call the right
 * vectors-client method with the right arguments.
 */

import { Namespace } from '../../src/memory/namespace';
import { Thread } from '../../src/memory/thread';
import type { AetherfyVectorsClient } from '../../src/client';
import { AetherfyVectorsError, PointNotFoundError } from '../../src/exceptions';

// Point-id fixtures — valid ids (UUID strings). Arbitrary labels like 'p1'
// would be rejected by validatePointId on a real setPayload/deletePayload
// call; the jest-mocked client here would otherwise hide that contract.
const P1 = '00000000-0000-4000-8000-000000000001';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

function makeNamespace() {
  const client = {
    setPayload: jest.fn().mockResolvedValue({ status: 'ok' }),
    deletePayload: jest.fn().mockResolvedValue({ status: 'ok' }),
    scrollIter: jest.fn(),
  } as unknown as AetherfyVectorsClient;
  const ns = new Namespace('my-ns', 'user_X_my-ns', client);
  return {
    ns,
    client: client as unknown as {
      setPayload: jest.Mock;
      deletePayload: jest.Mock;
      scrollIter: jest.Mock;
    },
  };
}

function makeThread() {
  const client = {
    setPayload: jest.fn().mockResolvedValue({ status: 'ok' }),
    deletePayload: jest.fn().mockResolvedValue({ status: 'ok' }),
    scrollIter: jest.fn(),
  } as unknown as AetherfyVectorsClient;
  const th = new Thread('conv-1', 'user_X___thread__conv-1', client);
  return {
    th,
    client: client as unknown as {
      setPayload: jest.Mock;
      deletePayload: jest.Mock;
      scrollIter: jest.Mock;
    },
  };
}

describe('Namespace.setMetadata', () => {
  it('calls client.setPayload with payload={metadata: ...} and the id wrapped in an array', async () => {
    const { ns, client } = makeNamespace();
    const out = await ns.setMetadata(P1, { foo: 1, bar: true });

    expect(client.setPayload).toHaveBeenCalledWith(
      'user_X_my-ns',
      { metadata: { foo: 1, bar: true } },
      [P1]
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
      makeAsyncIter([{ id: A }, { id: B }, { id: C }])
    );

    const out: Array<string | number> = [];
    for await (const p of ns.iter()) out.push(p.id);

    expect(out).toEqual([A, B, C]);
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

  it('rejects { limit: 50 } as any — runtime kwarg allowlist', async () => {
    const { ns, client } = makeNamespace();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = ns.iter({ limit: 50 } as any);
    const err = await gen.next().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Namespace\.iter:/);
    expect((err as Error).message).toMatch(/limit/);
    expect(client.scrollIter).not.toHaveBeenCalled();
  });
});

describe('Namespace.mergeMetadata', () => {
  it('calls client.setPayload with key="metadata" and the partial as payload', async () => {
    const { ns, client } = makeNamespace();
    const out = await ns.mergeMetadata(P1, { reviewed: true });
    expect(client.setPayload).toHaveBeenCalledWith(
      'user_X_my-ns',
      { reviewed: true },
      [P1],
      { key: 'metadata' }
    );
    expect(out).toEqual({ status: 'ok' });
  });

  it('passes integer ids through unchanged', async () => {
    const { ns, client } = makeNamespace();
    await ns.mergeMetadata(42, { x: 1 });
    expect(client.setPayload.mock.calls[0][2]).toEqual([42]);
  });

  it('throws TypeError when partial is not a plain object', async () => {
    const { ns, client } = makeNamespace();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ns.mergeMetadata(P1, 'nope' as any)
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ns.mergeMetadata(P1, [1, 2] as any)
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ns.mergeMetadata(P1, null as any)
    ).rejects.toBeInstanceOf(TypeError);
    expect(client.setPayload).not.toHaveBeenCalled();
  });

  it('Namespace rejects reserved key "text" in partial', async () => {
    const { ns, client } = makeNamespace();
    await expect(ns.mergeMetadata(P1, { text: 'oops', ok: 1 })).rejects.toThrow(
      /Reserved keys/
    );
    expect(client.setPayload).not.toHaveBeenCalled();
  });

  it('Namespace allows role/content/ts (Thread-only reserved set)', async () => {
    const { ns, client } = makeNamespace();
    await ns.mergeMetadata(P1, { role: 'x', content: 'y', ts: 1 });
    expect(client.setPayload).toHaveBeenCalled();
  });

  it('Thread rejects reserved keys role/content/ts in partial', async () => {
    for (const bad of ['role', 'content', 'ts']) {
      const { th, client } = makeThread();
      await expect(ns_merge_thread(th, { [bad]: 'x' })).rejects.toThrow(
        /Reserved keys/
      );
      expect(client.setPayload).not.toHaveBeenCalled();
    }
  });

  it('Thread allows "text" (Namespace-only reserved key)', async () => {
    const { th, client } = makeThread();
    await th.mergeMetadata(P1, { text: 'free-on-thread' });
    expect(client.setPayload).toHaveBeenCalled();
  });

  it('translates a generic 404 into PointNotFoundError', async () => {
    const { ns, client } = makeNamespace();
    client.setPayload.mockRejectedValue(
      new AetherfyVectorsError('Not found', undefined, 404)
    );
    await expect(ns.mergeMetadata(MISSING, { k: 1 })).rejects.toBeInstanceOf(
      PointNotFoundError
    );
  });
});

describe('Namespace.deleteMetadataKeys', () => {
  it('calls client.deletePayload with dotted metadata.<k> keys', async () => {
    const { ns, client } = makeNamespace();
    const out = await ns.deleteMetadataKeys(P1, ['k1', 'k2']);
    expect(client.deletePayload).toHaveBeenCalledWith(
      'user_X_my-ns',
      ['metadata.k1', 'metadata.k2'],
      [P1]
    );
    expect(out).toEqual({ status: 'ok' });
  });

  it('throws TypeError when keys is not a string array', async () => {
    const { ns, client } = makeNamespace();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ns.deleteMetadataKeys(P1, 'k1' as any)
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ns.deleteMetadataKeys(P1, ['k1', 2] as any)
    ).rejects.toBeInstanceOf(TypeError);
    expect(client.deletePayload).not.toHaveBeenCalled();
  });

  it('Namespace rejects reserved key "text" in keys list', async () => {
    const { ns, client } = makeNamespace();
    await expect(ns.deleteMetadataKeys(P1, ['text'])).rejects.toThrow(
      /Reserved keys/
    );
    expect(client.deletePayload).not.toHaveBeenCalled();
  });

  it('Thread rejects reserved keys role/content/ts in keys list', async () => {
    for (const bad of ['role', 'content', 'ts']) {
      const { th, client } = makeThread();
      await expect(th.deleteMetadataKeys(P1, [bad])).rejects.toThrow(
        /Reserved keys/
      );
      expect(client.deletePayload).not.toHaveBeenCalled();
    }
  });

  it('translates a generic 404 into PointNotFoundError', async () => {
    const { ns, client } = makeNamespace();
    client.deletePayload.mockRejectedValue(
      new AetherfyVectorsError('Not found', undefined, 404)
    );
    await expect(ns.deleteMetadataKeys(MISSING, ['k1'])).rejects.toBeInstanceOf(
      PointNotFoundError
    );
  });
});

// Tiny helper kept inline so we don't pollute the file with another fixture
// builder for a one-line call.
async function ns_merge_thread(
  th: Thread,
  partial: Record<string, unknown>
): Promise<unknown> {
  return th.mergeMetadata(P1, partial);
}

/**
 * Unit tests for AetherfyVectorsClient.scrollIter — auto-paginating scroll.
 *
 * Pins:
 *   - Delegates to scroll() (no duplicate HTTP path).
 *   - batchSize is range-validated (1..1000, server cap from vectordb WS1).
 *   - Generator stops cleanly when nextPageOffset becomes null.
 *   - TypeScript typing enforces the kwarg allowlist; runtime tests confirm
 *     limit/offset are not accepted (covered by compile-time checking, not
 *     re-asserted at runtime — see the "as any" note below).
 */

import { AetherfyVectorsClient } from '../../src/client';
import { ScrollResult } from '../../src/models';

function makeClient(): AetherfyVectorsClient {
  return new AetherfyVectorsClient({
    apiKey: 'afy_test_1234567890123456',
    enableConnectionPooling: false,
  });
}

describe('AetherfyVectorsClient.scrollIter', () => {
  it('yields all points across pages and stops when nextPageOffset is null', async () => {
    const client = makeClient();
    const pages: ScrollResult[] = [
      { points: [{ id: 'a' }, { id: 'b' }], nextPageOffset: 'c1' },
      { points: [{ id: 'c' }, { id: 'd' }], nextPageOffset: 'c2' },
      { points: [{ id: 'e' }], nextPageOffset: null },
    ];
    const scrollSpy = jest
      .spyOn(client, 'scroll')
      .mockImplementation(async () => pages.shift()!);

    const out: Array<string | number> = [];
    for await (const p of client.scrollIter('col', { batchSize: 2 })) {
      out.push(p.id);
    }

    expect(out).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(scrollSpy).toHaveBeenCalledTimes(3);
    expect(scrollSpy.mock.calls[0][1]).toMatchObject({
      limit: 2,
      offset: undefined,
    });
    expect(scrollSpy.mock.calls[1][1]).toMatchObject({
      limit: 2,
      offset: 'c1',
    });
    expect(scrollSpy.mock.calls[2][1]).toMatchObject({
      limit: 2,
      offset: 'c2',
    });
  });

  it('empty collection yields nothing', async () => {
    const client = makeClient();
    const scrollSpy = jest.spyOn(client, 'scroll').mockResolvedValue({
      points: [],
      nextPageOffset: null,
    });

    const out: unknown[] = [];
    for await (const p of client.scrollIter('col')) {
      out.push(p);
    }

    expect(out).toEqual([]);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it('forwards filter, withPayload, withVectors to scroll()', async () => {
    const client = makeClient();
    const scrollSpy = jest.spyOn(client, 'scroll').mockResolvedValue({
      points: [],
      nextPageOffset: null,
    });
    const flt = { must: [{ key: 'category', match: { value: 'docs' } }] };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.scrollIter('col', {
      batchSize: 128,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scrollFilter: flt as any,
      withPayload: false,
      withVectors: true,
    })) {
      // no-op
    }

    expect(scrollSpy.mock.calls[0][1]).toMatchObject({
      limit: 128,
      scrollFilter: flt,
      withPayload: false,
      withVectors: true,
    });
  });

  it('throws RangeError when batchSize is 0', async () => {
    const client = makeClient();
    const scrollSpy = jest.spyOn(client, 'scroll');
    const gen = client.scrollIter('col', { batchSize: 0 });
    // Generators throw exactly once: subsequent .next() calls return
    // { done: true } per standard JS generator semantics. Capture the error
    // from a single .next() and assert both type and message on it.
    const err = await gen.next().catch(e => e);
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(/batchSize/);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('throws RangeError when batchSize exceeds 1000', async () => {
    const client = makeClient();
    const scrollSpy = jest.spyOn(client, 'scroll');
    const gen = client.scrollIter('col', { batchSize: 1001 });
    const err = await gen.next().catch(e => e);
    expect(err).toBeInstanceOf(RangeError);
    expect((err as Error).message).toMatch(/batchSize/);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('default batchSize is 256', async () => {
    const client = makeClient();
    const scrollSpy = jest.spyOn(client, 'scroll').mockResolvedValue({
      points: [],
      nextPageOffset: null,
    });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of client.scrollIter('col')) {
      /* no-op */
    }

    expect(scrollSpy.mock.calls[0][1]).toMatchObject({ limit: 256 });
  });

  it('rejects { limit: 100 } as any — runtime kwarg allowlist', async () => {
    const client = makeClient();
    const scrollSpy = jest.spyOn(client, 'scroll');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = client.scrollIter('col', { limit: 100 } as any);
    const err = await gen.next().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/scrollIter:/);
    expect((err as Error).message).toMatch(/limit/);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('rejects { offset: "x" } as any — runtime kwarg allowlist', async () => {
    const client = makeClient();
    const scrollSpy = jest.spyOn(client, 'scroll');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = client.scrollIter('col', { offset: 'x' } as any);
    const err = await gen.next().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/offset/);
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

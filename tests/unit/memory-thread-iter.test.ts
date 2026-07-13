/**
 * Unit tests for Thread.iterHistory() — full-thread message iteration.
 * Pins delegation to scrollIter (paged), client-side ts sort, and
 * skip-without-payload / skip-without-ts behavior matching history().
 */

import { Thread } from '../../src/memory/thread';
import type { AetherfyVectorsClient } from '../../src/client';

function makeThread() {
  const client = {
    scrollIter: jest.fn(),
    scroll: jest.fn(),
  } as unknown as AetherfyVectorsClient;
  const th = new Thread('t1', 'user_X_threads/t1', client);
  return {
    th,
    client: client as unknown as { scrollIter: jest.Mock; scroll: jest.Mock },
  };
}

async function* asyncFrom<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

// Point-id fixtures — valid ids (UUID strings). A real server only ever
// returns canonical UUIDs / unsigned ints as point ids; arbitrary labels
// like 'm1' would never round-trip, and the jest-mocked client here would
// otherwise hide that contract.
const M1 = '00000000-0000-4000-8000-000000000001';
const M2 = '00000000-0000-4000-8000-000000000002';
const M3 = '00000000-0000-4000-8000-000000000003';
const NO_PAYLOAD = '00000000-0000-4000-8000-0000000000fa';
const NO_TS = '00000000-0000-4000-8000-0000000000fb';

describe('Thread.iterHistory', () => {
  it('asc order yields messages oldest first', async () => {
    const { th, client } = makeThread();
    // Mixed-ts points, intentionally out of order on the wire.
    client.scrollIter.mockReturnValue(
      asyncFrom([
        { id: M3, payload: { role: 'user', content: 'c', ts: 30 } },
        { id: M1, payload: { role: 'user', content: 'a', ts: 10 } },
        { id: M2, payload: { role: 'user', content: 'b', ts: 20 } },
      ])
    );

    const ids: Array<string | number> = [];
    for await (const msg of th.iterHistory()) ids.push(msg.id);

    expect(ids).toEqual([M1, M2, M3]);
  });

  it('desc order yields messages newest first', async () => {
    const { th, client } = makeThread();
    client.scrollIter.mockReturnValue(
      asyncFrom([
        { id: M1, payload: { role: 'user', content: 'a', ts: 10 } },
        { id: M3, payload: { role: 'user', content: 'c', ts: 30 } },
        { id: M2, payload: { role: 'user', content: 'b', ts: 20 } },
      ])
    );

    const ids: Array<string | number> = [];
    for await (const msg of th.iterHistory({ order: 'desc' })) ids.push(msg.id);

    expect(ids).toEqual([M3, M2, M1]);
  });

  it('throws on invalid order', async () => {
    const { th } = makeThread();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = th.iterHistory({ order: 'random' as any });
    await expect(gen.next()).rejects.toThrow(/order/);
  });

  it('skips points without a payload', async () => {
    const { th, client } = makeThread();
    client.scrollIter.mockReturnValue(
      asyncFrom([
        { id: M1, payload: { role: 'user', content: 'a', ts: 1 } },
        { id: NO_PAYLOAD },
        { id: M2, payload: { role: 'user', content: 'b', ts: 2 } },
      ])
    );

    const ids: Array<string | number> = [];
    for await (const msg of th.iterHistory()) ids.push(msg.id);
    expect(ids).toEqual([M1, M2]);
  });

  it('skips messages without a ts field', async () => {
    const { th, client } = makeThread();
    client.scrollIter.mockReturnValue(
      asyncFrom([
        { id: M1, payload: { role: 'user', content: 'a', ts: 1 } },
        { id: NO_TS, payload: { role: 'user', content: 'x' } },
        { id: M2, payload: { role: 'user', content: 'b', ts: 2 } },
      ])
    );

    const ids: Array<string | number> = [];
    for await (const msg of th.iterHistory()) ids.push(msg.id);
    expect(ids).toEqual([M1, M2]);
  });

  it('walks scrollIter (paged), not single-shot scroll', async () => {
    const { th, client } = makeThread();
    client.scrollIter.mockReturnValue(asyncFrom([]));

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of th.iterHistory()) {
      /* no-op */
    }

    expect(client.scrollIter).toHaveBeenCalledTimes(1);
    expect(client.scroll).not.toHaveBeenCalled();
  });

  it('rejects { batchSize: 100 } as any — runtime kwarg allowlist (only `order` allowed)', async () => {
    const { th, client } = makeThread();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gen = th.iterHistory({ batchSize: 100 } as any);
    const err = await gen.next().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Thread\.iterHistory:/);
    expect((err as Error).message).toMatch(/batchSize/);
    expect(client.scrollIter).not.toHaveBeenCalled();
  });
});

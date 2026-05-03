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

describe('Thread.iterHistory', () => {
  it('asc order yields messages oldest first', async () => {
    const { th, client } = makeThread();
    // Mixed-ts points, intentionally out of order on the wire.
    client.scrollIter.mockReturnValue(
      asyncFrom([
        { id: 'm3', payload: { role: 'user', content: 'c', ts: 30 } },
        { id: 'm1', payload: { role: 'user', content: 'a', ts: 10 } },
        { id: 'm2', payload: { role: 'user', content: 'b', ts: 20 } },
      ])
    );

    const ids: string[] = [];
    for await (const msg of th.iterHistory()) ids.push(msg.id);

    expect(ids).toEqual(['m1', 'm2', 'm3']);
  });

  it('desc order yields messages newest first', async () => {
    const { th, client } = makeThread();
    client.scrollIter.mockReturnValue(
      asyncFrom([
        { id: 'm1', payload: { role: 'user', content: 'a', ts: 10 } },
        { id: 'm3', payload: { role: 'user', content: 'c', ts: 30 } },
        { id: 'm2', payload: { role: 'user', content: 'b', ts: 20 } },
      ])
    );

    const ids: string[] = [];
    for await (const msg of th.iterHistory({ order: 'desc' })) ids.push(msg.id);

    expect(ids).toEqual(['m3', 'm2', 'm1']);
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
        { id: 'm1', payload: { role: 'user', content: 'a', ts: 1 } },
        { id: 'no-payload' },
        { id: 'm2', payload: { role: 'user', content: 'b', ts: 2 } },
      ])
    );

    const ids: string[] = [];
    for await (const msg of th.iterHistory()) ids.push(msg.id);
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('skips messages without a ts field', async () => {
    const { th, client } = makeThread();
    client.scrollIter.mockReturnValue(
      asyncFrom([
        { id: 'm1', payload: { role: 'user', content: 'a', ts: 1 } },
        { id: 'no-ts', payload: { role: 'user', content: 'x' } },
        { id: 'm2', payload: { role: 'user', content: 'b', ts: 2 } },
      ])
    );

    const ids: string[] = [];
    for await (const msg of th.iterHistory()) ids.push(msg.id);
    expect(ids).toEqual(['m1', 'm2']);
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
});

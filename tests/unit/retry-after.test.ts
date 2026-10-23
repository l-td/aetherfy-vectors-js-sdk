/**
 * `Retry-After` on a 503 (RESOURCE_BUSY, SERVICE_UNAVAILABLE).
 *
 * A retried operation waits the seconds the header names: capped, never past
 * the call's own deadline. A missing or unreadable header falls back to the
 * exponential backoff. Time is a fake clock: nothing really sleeps, and the
 * waits are read off the timer the retry sets.
 */
import nock from 'nock';
import { AetherfyVectorsClient } from '../../src/client';
import {
  RateLimitExceededError,
  ServiceUnavailableError,
  createErrorFromResponse,
} from '../../src/exceptions';
import { REPEATABLE, parseRetryAfter } from '../../src/retry-policy';
import { retryWithBackoff } from '../../src/utils';

const BASE = 'https://vectors.aetherfy.com';

/**
 * Every timer the code under test sets runs at once; its delays are kept.
 * A timer of `realFrom` ms or more is a request's own timeout and stays real.
 */
function fakeClock(realFrom: number = 100_000) {
  const waits: number[] = [];
  let now = 1_000_000;
  const real = global.setTimeout;
  const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if ((ms ?? 0) >= realFrom) return real(fn, ms, ...rest);
    waits.push(ms ?? 0);
    now += ms ?? 0;
    fn();
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  return { waits, now: () => now, restore: () => spy.mockRestore() };
}

function busy(retryAfter?: number) {
  return new ServiceUnavailableError('busy', retryAfter);
}

function failingThenOk(...errors: unknown[]) {
  const queue = [...errors];
  return jest.fn(async () => {
    if (queue.length > 0) throw queue.shift();
    return 'ok';
  });
}

let clock: ReturnType<typeof fakeClock>;
beforeEach(() => {
  clock = fakeClock();
});
afterEach(() => {
  clock.restore();
  nock.cleanAll();
});

describe('reading the header', () => {
  it.each([
    ['7', 7],
    [' 2.5 ', 2.5],
    ['0', 0],
    ['', undefined],
    ['soon', undefined],
    ['-3', undefined],
    ['NaN', undefined],
    ['Infinity', undefined],
    [undefined, undefined],
    [7, undefined],
  ])('%p is %p', (value, expected) => {
    expect(parseRetryAfter(value)).toBe(expected);
  });

  it('an HTTP date is the seconds until it', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBe(0);
  });

  it('a 503 error carries the header it was built with', () => {
    const error = createErrorFromResponse(
      { error: { code: 'RESOURCE_BUSY', message: 'busy' } },
      503,
      'Service Unavailable',
      undefined,
      4
    ) as ServiceUnavailableError;
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error.retryAfter).toBe(4);
  });

  it('a 503 without the header has none', () => {
    const error = createErrorFromResponse(
      { error: { code: 'RESOURCE_BUSY', message: 'busy' } },
      503,
      'Service Unavailable'
    ) as ServiceUnavailableError;
    expect(error.retryAfter).toBeUndefined();
  });
});

describe('waiting it', () => {
  it('the wait is the headers value, not the backoff', async () => {
    const fn = failingThenOk(busy(7));
    await expect(
      retryWithBackoff(fn, { retryClass: REPEATABLE })
    ).resolves.toBe('ok');
    expect(clock.waits).toEqual([7000]);
  });

  it('each retry waits its own ask', async () => {
    await retryWithBackoff(failingThenOk(busy(2), busy(5)), {
      retryClass: REPEATABLE,
    });
    expect(clock.waits).toEqual([2000, 5000]);
  });

  it('an ask within the cap is waited exactly', async () => {
    await retryWithBackoff(failingThenOk(busy(30)), {
      retryClass: REPEATABLE,
      maxDelay: 30_000,
    });
    expect(clock.waits).toEqual([30_000]);
  });

  it('an ask beyond the cap is not cut to it and not retried', async () => {
    // Retrying at the cap would arrive before the time the server named.
    const fn = failingThenOk(busy(3600));
    const error = await retryWithBackoff(fn, {
      retryClass: REPEATABLE,
      maxDelay: 30_000,
    }).catch(e => e);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error.retryAfter).toBe(3600);
    expect(clock.waits).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the cap is the callers maxDelay', async () => {
    const refused = await retryWithBackoff(failingThenOk(busy(10)), {
      retryClass: REPEATABLE,
      maxDelay: 5000,
    }).catch(e => e);
    expect(refused.retryAfter).toBe(10);
    expect(clock.waits).toEqual([]);
    await retryWithBackoff(failingThenOk(busy(10)), {
      retryClass: REPEATABLE,
      maxDelay: 10_000,
    });
    expect(clock.waits).toEqual([10_000]);
  });

  it('a wait past the deadline is not taken', async () => {
    const fn = failingThenOk(busy(10));
    await expect(
      retryWithBackoff(fn, {
        retryClass: REPEATABLE,
        deadline: clock.now() + 5000,
        now: clock.now,
      })
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(clock.waits).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a wait that fits the deadline is taken', async () => {
    await expect(
      retryWithBackoff(failingThenOk(busy(10)), {
        retryClass: REPEATABLE,
        deadline: clock.now() + 20_000,
        now: clock.now,
      })
    ).resolves.toBe('ok');
    expect(clock.waits).toEqual([10_000]);
  });

  it('a missing header falls back to the backoff', async () => {
    await retryWithBackoff(failingThenOk(busy(undefined)), {
      retryClass: REPEATABLE,
      baseDelay: 4000,
    });
    expect(clock.waits).toHaveLength(1);
    expect(clock.waits[0]).toBeGreaterThanOrEqual(2000);
    expect(clock.waits[0]).toBeLessThanOrEqual(4000);
  });

  it('a zero wait retries at once', async () => {
    await retryWithBackoff(failingThenOk(busy(0)), { retryClass: REPEATABLE });
    expect(clock.waits).toEqual([0]);
  });

  it('the raw error of the HTTP layer carries it too', async () => {
    const raw = Object.assign(new Error('busy'), {
      status: 503,
      responseData: { error: { code: 'RESOURCE_BUSY' } },
      retryAfter: 9,
    });
    await retryWithBackoff(failingThenOk(raw), { retryClass: REPEATABLE });
    expect(clock.waits).toEqual([9000]);
  });
});

describe('through the client', () => {
  beforeEach(() => {
    clock.restore();
    clock = fakeClock(30_000); // the HTTP timeout is 30 s
  });

  it('a 503 with Retry-After is waited for that long, then the call succeeds', async () => {
    const client = new AetherfyVectorsClient({
      apiKey: 'afy_test_1234567890123456',
      workspace: 'home',
      enableConnectionPooling: false,
    });
    nock(BASE)
      .post('/api/v1/workspaces/home/collections/docs/points/count')
      .reply(
        503,
        { error: { code: 'RESOURCE_BUSY', message: 'busy' } },
        { 'Retry-After': '6' }
      );
    nock(BASE)
      .post('/api/v1/workspaces/home/collections/docs/points/count')
      .reply(200, { result: { count: 4 } });
    await expect(client.count('docs')).resolves.toBe(4);
    expect(clock.waits).toEqual([6000]);
  });

  it('a 503 whose Retry-After is unreadable uses the backoff', async () => {
    const client = new AetherfyVectorsClient({
      apiKey: 'afy_test_1234567890123456',
      workspace: 'home',
      enableConnectionPooling: false,
    });
    nock(BASE)
      .post('/api/v1/workspaces/home/collections/docs/points/count')
      .reply(
        503,
        { error: { code: 'RESOURCE_BUSY', message: 'busy' } },
        { 'Retry-After': 'soon' }
      );
    nock(BASE)
      .post('/api/v1/workspaces/home/collections/docs/points/count')
      .reply(200, { result: { count: 4 } });
    await expect(client.count('docs')).resolves.toBe(4);
    expect(clock.waits).toHaveLength(1);
    expect(clock.waits[0]).not.toBe(6000);
  });
});

describe('a 429', () => {
  const limited = (retryAfter?: number) =>
    new RateLimitExceededError('slow down', retryAfter);

  it('carries the header it was built with, else the body field', () => {
    expect(
      (
        createErrorFromResponse(
          { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow' } },
          429,
          'Too Many Requests',
          undefined,
          4
        ) as RateLimitExceededError
      ).retryAfter
    ).toBe(4);
    expect(
      (
        createErrorFromResponse(
          { retryAfter: 9, error: { code: 'RATE_LIMIT_EXCEEDED' } },
          429,
          'Too Many Requests'
        ) as RateLimitExceededError
      ).retryAfter
    ).toBe(9);
    expect(
      (
        createErrorFromResponse(
          { message: 'x' },
          429,
          'Too Many Requests'
        ) as RateLimitExceededError
      ).retryAfter
    ).toBeUndefined();
  });

  it('waits the ask, not the backoff', async () => {
    await retryWithBackoff(failingThenOk(limited(8)), {
      retryClass: REPEATABLE,
    });
    expect(clock.waits).toEqual([8000]);
  });

  it('an ask beyond the cap is not retried', async () => {
    const error = await retryWithBackoff(failingThenOk(limited(300)), {
      retryClass: REPEATABLE,
      maxDelay: 30_000,
    }).catch(e => e);
    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect(error.retryAfter).toBe(300);
    expect(clock.waits).toEqual([]);
  });

  it('an ask past the deadline is not taken', async () => {
    await expect(
      retryWithBackoff(failingThenOk(limited(10)), {
        retryClass: REPEATABLE,
        deadline: clock.now() + 5000,
        now: clock.now,
      })
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(clock.waits).toEqual([]);
  });

  it('without a retryAfter it is not retried (the rule is unchanged)', async () => {
    const fn = failingThenOk(limited(undefined));
    await expect(
      retryWithBackoff(fn, { retryClass: REPEATABLE })
    ).rejects.toBeInstanceOf(RateLimitExceededError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('the raw error of the HTTP layer carries it too', async () => {
    const raw = Object.assign(new Error('slow'), {
      status: 429,
      responseData: { error: { code: 'RATE_LIMIT_EXCEEDED' } },
      retryAfter: 3,
    });
    await retryWithBackoff(failingThenOk(raw), { retryClass: REPEATABLE });
    expect(clock.waits).toEqual([3000]);
  });

  it('through the client, the header is waited for', async () => {
    clock.restore();
    clock = fakeClock(30_000);
    const client = new AetherfyVectorsClient({
      apiKey: 'afy_test_1234567890123456',
      workspace: 'home',
      enableConnectionPooling: false,
    });
    const path = '/api/v1/workspaces/home/collections/docs/points/count';
    nock(BASE)
      .post(path)
      .reply(
        429,
        { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'slow' } },
        { 'Retry-After': '7' }
      );
    nock(BASE)
      .post(path)
      .reply(200, { result: { count: 4 } });
    await expect(client.count('docs')).resolves.toBe(4);
    expect(clock.waits).toEqual([7000]);
  });
});

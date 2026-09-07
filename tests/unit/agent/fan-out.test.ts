/**
 * `fanOut()`: input order, no swallowed failure, and the one log line.
 *
 * THE LOG LINE IS ASSERTED BYTE FOR BYTE, here and in the Python SDK's
 * matching test (`tests/agent/test_fan_out.py`). It is the convention the
 * platform cannot produce for the customer — nothing outside the machine can
 * count in-process workers — so its text is a contract between the two
 * helpers, not a debug print. A drift between the two languages would make a
 * run's width unreadable in exactly half the fleet and nothing else would
 * notice.
 */

import { fanOut, machine } from '../../../src/agent';
import { AgentError, NotRunningOnAgent } from '../../../src/agent/errors';

const SHAPE_VARS = ['AETHERFY_VCPUS', 'AETHERFY_MEMORY_MB', 'AETHERFY_REGION'];

let logged: string[];
let logSpy: jest.SpyInstance;

beforeEach(() => {
  process.env.AETHERFY_VCPUS = '4';
  process.env.AETHERFY_MEMORY_MB = '8192';
  process.env.AETHERFY_REGION = 'us-east-1';
  logged = [];
  logSpy = jest
    .spyOn(console, 'log')
    .mockImplementation((line?: unknown) => void logged.push(String(line)));
});

afterEach(() => {
  logSpy.mockRestore();
  for (const name of SHAPE_VARS) delete process.env[name];
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('machine()', () => {
  it('returns numbers, not the strings the environment carries', () => {
    const shape = machine();

    expect(shape).toEqual({ vcpus: 4, memory_mb: 8192, region: 'us-east-1' });
    expect(shape.vcpus * 8).toBe(32);
  });

  it.each(SHAPE_VARS)('names %s when it is missing', variable => {
    delete process.env[variable];

    expect(() => machine()).toThrow(NotRunningOnAgent);
    expect(() => machine()).toThrow(variable);
  });

  it('refuses a shape that is not a whole number', () => {
    process.env.AETHERFY_VCPUS = 'four';

    expect(() => machine()).toThrow(AgentError);
  });
});

describe('fanOut()', () => {
  it('returns results in input order', async () => {
    // Every worker sleeps for the inverse of its value, so completion order is
    // the exact reverse of input order — an implementation that returned
    // results as they settled would return them backwards.
    const slow = async (n: number) => {
      await sleep((5 - n) * 20);
      return n * 10;
    };

    await expect(fanOut(slow, [1, 2, 3, 4])).resolves.toEqual([10, 20, 30, 40]);
  });

  it('prints the exact log line', async () => {
    await fanOut((n: number) => n, [1, 2, 3]);

    expect(logged).toEqual([
      'aetherfy: fanning out 32 wide on 4 vCPU / 8192 MB (3 tasks)',
    ]);
  });

  it('defaults the width to eight per vCPU', async () => {
    process.env.AETHERFY_VCPUS = '1';
    process.env.AETHERFY_MEMORY_MB = '1024';

    await fanOut((n: number) => n, [1]);

    expect(logged).toEqual([
      'aetherfy: fanning out 8 wide on 1 vCPU / 1024 MB (1 tasks)',
    ]);
  });

  it('reports an explicit width as the width', async () => {
    await fanOut((n: number) => n, [1, 2], { width: 2 });

    expect(logged).toEqual([
      'aetherfy: fanning out 2 wide on 4 vCPU / 8192 MB (2 tasks)',
    ]);
  });

  it('prints the line once and only once', async () => {
    await fanOut(
      (n: number) => n,
      Array.from({ length: 20 }, (_, i) => i)
    );

    expect(logged).toHaveLength(1);
  });

  it('still reports on an empty item list', async () => {
    await expect(fanOut((n: number) => n, [])).resolves.toEqual([]);
    expect(logged).toEqual([
      'aetherfy: fanning out 32 wide on 4 vCPU / 8192 MB (0 tasks)',
    ]);
  });

  it('re-throws the first failure rather than swallowing it', async () => {
    const sometimes = async (n: number) => {
      if (n === 1 || n === 3) throw new Error(`item ${n} failed`);
      return n;
    };

    // The LOWEST-INDEXED failure, deterministically — not whichever promise
    // lost the race. Item 3 also failed and must not be the one reported.
    await expect(fanOut(sometimes, [0, 1, 2, 3])).rejects.toThrow(
      'item 1 failed'
    );
  });

  it('attempts every item even when an early one fails', async () => {
    // A worker that threw out of its own loop would leave the tail of the
    // queue unattempted, which is a different contract from "no failure is
    // swallowed".
    const seen: number[] = [];
    const sometimes = async (n: number) => {
      seen.push(n);
      if (n === 0) throw new Error('first one failed');
      return n;
    };

    await expect(fanOut(sometimes, [0, 1, 2, 3], { width: 1 })).rejects.toThrow(
      'first one failed'
    );
    expect(seen.sort()).toEqual([0, 1, 2, 3]);
  });

  it('does not hide the log line when the work fails', async () => {
    await expect(
      fanOut(async () => {
        throw new Error('nope');
      }, [1])
    ).rejects.toThrow('nope');
    expect(logged[0]).toContain('aetherfy: fanning out');
  });

  it('never runs more than width at once', async () => {
    let running = 0;
    let peak = 0;
    const work = async (n: number) => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(5);
      running -= 1;
      return n;
    };

    await fanOut(
      work,
      Array.from({ length: 12 }, (_, i) => i),
      { width: 3 }
    );

    expect(peak).toBe(3);
  });

  it('materializes an iterable once', async () => {
    // A generator must not be consumed by the count in the log line and then
    // found empty by the pool.
    function* items() {
      yield 1;
      yield 2;
      yield 3;
    }

    await expect(fanOut((n: number) => n * 2, items())).resolves.toEqual([
      2, 4, 6,
    ]);
    expect(logged[0]).toContain('(3 tasks)');
  });

  it('refuses a width below one', async () => {
    await expect(fanOut((n: number) => n, [1], { width: 0 })).rejects.toThrow(
      AgentError
    );
  });

  it('accepts a synchronous function', async () => {
    await expect(fanOut((n: number) => n + 1, [1, 2])).resolves.toEqual([2, 3]);
  });
});

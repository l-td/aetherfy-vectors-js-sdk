/**
 * `writeResult()`: the bytes that land on disk, and the one refusal that
 * happens before they do.
 *
 * Pinned against aetherfy-control-plane `orchestrator/image_generator.py`,
 * whose task supervisor prepares the file, injects its path as
 * `AETHERFY_SPAWN_RESULT_PATH`, and afterwards reads it back with
 * `len(raw) > _RESULT_MAX_BYTES` over the RAW BYTES — which is why the check
 * here measures the encoded bytes and not the string length. The cap itself is
 * injected as `AETHERFY_RUN_INLINE_MAX_BYTES`
 * (`orchestrator/fly_manager.py`).
 *
 * Real files in a scratch directory, not a mocked `fs`: the claim is about what
 * the supervisor will read back, and a double proves only the double.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { machine, writeResult } from '../../../src/agent';
import { NotRunningOnAgent, ResultTooLarge } from '../../../src/agent/errors';

const CAP = 64;

let scratch: string;
let resultPath: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'aetherfy-result-'));
  resultPath = join(scratch, 'result.json');
  process.env.AETHERFY_SPAWN_RESULT_PATH = resultPath;
  process.env.AETHERFY_RUN_INLINE_MAX_BYTES = String(CAP);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  delete process.env.AETHERFY_SPAWN_RESULT_PATH;
  delete process.env.AETHERFY_RUN_INLINE_MAX_BYTES;
});

describe('writeResult()', () => {
  it('leaves exactly the JSON the platform will read', async () => {
    await writeResult({ rows: 128, date: '2026-09-08' });

    const raw = readFileSync(resultPath);
    expect(JSON.parse(raw.toString('utf8'))).toEqual({
      rows: 128,
      date: '2026-09-08',
    });
  });

  it('takes a result that is not an object', async () => {
    // The control plane's column is `Any`, so a list or a scalar is a result.
    await writeResult([1, 2, 3]);
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual([1, 2, 3]);
  });

  it.each([[null], [undefined]])(
    'writes the literal null the platform reads as nothing (%p)',
    async value => {
      // image_generator.py's _collect_result: "A child that writes the literal
      // `null` reads here as 'returned nothing'." Documented, not invented.
      // `undefined` matters on its own: JSON.stringify returns undefined for
      // it, which would otherwise land on disk as the four letters "unde".
      await writeResult(value);
      expect(readFileSync(resultPath, 'utf8')).toBe('null');
    }
  );

  it('lets the last call win', async () => {
    await writeResult({ attempt: 1 });
    await writeResult({ attempt: 2 });
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({
      attempt: 2,
    });
  });

  it('names the missing variable and writes nothing', async () => {
    delete process.env.AETHERFY_SPAWN_RESULT_PATH;

    await expect(writeResult({ rows: 1 })).rejects.toThrow(NotRunningOnAgent);
    await expect(writeResult({ rows: 1 })).rejects.toThrow(
      /AETHERFY_SPAWN_RESULT_PATH/
    );
    expect(existsSync(resultPath)).toBe(false);
  });

  it('does not claim the platform always sets the result path', async () => {
    // THE DEFAULT SENTENCE IS FALSE FOR THIS ONE VARIABLE, and this is the only
    // variable in the module for which it is. image_generator.py offers the
    // result path only inside `if _RESULT_MAX_BYTES > 0`; a task machine with
    // no cap, and every service machine, reaches this error on a platform that
    // deliberately did not set it. Telling that customer "the platform sets it
    // before your entrypoint starts" sends them to debug their own code.
    delete process.env.AETHERFY_SPAWN_RESULT_PATH;

    const error = await writeResult({ rows: 1 }).catch(e => e as Error);
    const message = (error as Error).message;

    expect(message).not.toContain('the platform sets');
    expect(message).toContain('AETHERFY_RUN_INLINE_MAX_BYTES');
    // ...and it says WRITE, not read, because that is what this call does.
    expect(message).toContain('writes its answer to');
  });

  it('says this is a task-only call', async () => {
    // THE SERVICE CASE IS NOT A MISCONFIGURATION, it is the wrong call. A
    // service machine has no runs, so it is never given a result path and this
    // can never succeed there — no cap, no redeploy and no support ticket will
    // change that. Saying only "the path is missing" would leave a service
    // author hunting for the setting that turns it on.
    delete process.env.AETHERFY_SPAWN_RESULT_PATH;

    const error = await writeResult({ rows: 1 }).catch(e => e as Error);
    const message = (error as Error).message;

    expect(message).toContain('TASK-ONLY');
    expect(message).toContain('service');
    expect(message).toContain('never');
    // And it names the way out, rather than only the wall.
    expect(message).toContain('HTTP');
  });

  it('keeps the default sentence for every other variable', async () => {
    // A negative control on the override: widening it to every call site would
    // make the assertion above unremarkable and would drop a true sentence from
    // the variables Aetherfy really does always inject.
    delete process.env.AETHERFY_VCPUS;

    let message = '';
    try {
      machine();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(
      'the platform sets AETHERFY_VCPUS before your entrypoint starts'
    );
  });
});

describe('writeResult() and the inline cap', () => {
  it('refuses over the cap and leaves no file', async () => {
    const oversized = { blob: 'x'.repeat(CAP) };
    const expected = new TextEncoder().encode(JSON.stringify(oversized)).length;

    await expect(writeResult(oversized)).rejects.toMatchObject({
      name: 'ResultTooLarge',
      maxBytes: CAP,
      resultBytes: expected,
    });
    expect(expected).toBeGreaterThan(CAP);
    // THE REFUSAL IS BEFORE THE WRITE. A half-written oversized file would be
    // read by the supervisor as this run's answer and reported as too_large —
    // the same outcome the refusal exists to replace.
    expect(existsSync(resultPath)).toBe(false);
  });

  it('writes a result of exactly the cap', async () => {
    // The supervisor's own comparison is `len(raw) > cap`, so the boundary
    // value is accepted. A `>=` here would refuse a result the platform stores.
    const value = 'x'.repeat(CAP - 2);
    expect(JSON.stringify(value)).toHaveLength(CAP);

    await writeResult(value);
    expect(readFileSync(resultPath, 'utf8')).toBe(JSON.stringify(value));
  });

  it('reads the cap from the environment rather than assuming one', async () => {
    // A hardcoded cap would pass every test above and be wrong on every machine
    // whose memory step buys a different one.
    process.env.AETHERFY_RUN_INLINE_MAX_BYTES = '8';

    await expect(writeResult({ rows: 128 })).rejects.toMatchObject({
      maxBytes: 8,
    });
  });

  it.each(['', '0', 'not-a-number', '-1'])(
    'writes anyway when the cap is unusable (%p)',
    async cap => {
      // THE PLATFORM ENFORCES THE CAP; this check is a courtesy. Refusing
      // because the courtesy is unavailable would lose a result the platform
      // would have accepted, which is strictly worse than not checking.
      process.env.AETHERFY_RUN_INLINE_MAX_BYTES = cap;
      const big = { blob: 'x'.repeat(CAP * 4) };

      await writeResult(big);
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual(big);
    }
  );

  it('measures bytes, not characters', async () => {
    // The supervisor reads the file in binary and compares byte lengths, and
    // JSON.stringify does NOT escape non-ASCII — so a string whose length is
    // under the cap can be a file that is over it.
    process.env.AETHERFY_RUN_INLINE_MAX_BYTES = '20';
    const value = '€€€€€'; // 5 characters, 15 bytes, plus 2 quotes

    await expect(writeResult(value)).resolves.toBeUndefined();
    expect(readFileSync(resultPath).length).toBe(17);
    expect(readFileSync(resultPath).length).toBeGreaterThan(
      JSON.stringify(value).length
    );

    process.env.AETHERFY_RUN_INLINE_MAX_BYTES = '16';
    await expect(writeResult(value)).rejects.toMatchObject({
      resultBytes: 17,
      maxBytes: 16,
    });
  });

  it('is a ResultTooLarge and not a spawn error', async () => {
    // Nothing crossed the network, so there is no status and no platform code
    // to carry — and a catch written for a refused spawn must not swallow this.
    const error = await writeResult({ blob: 'x'.repeat(CAP) }).catch(e => e);
    expect(error).toBeInstanceOf(ResultTooLarge);
    expect(
      (error as ResultTooLarge & { status?: number }).status
    ).toBeUndefined();
  });
});

describe('writeResult() and what cannot be serialized', () => {
  it('lets a cycle through as the TypeError it is, writing nothing', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(writeResult(cyclic)).rejects.toBeInstanceOf(TypeError);
    expect(existsSync(resultPath)).toBe(false);
  });

  it('writes non-finite numbers as null, which is valid JSON', async () => {
    // JSON.stringify's own rule, and the reason this helper does not police
    // them. The Python helper has to refuse them explicitly, because its json
    // writes bare `NaN` tokens no other reader accepts. Both languages end up
    // writing valid JSON; only the route there differs.
    await writeResult({ score: NaN, ratio: Infinity });
    expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({
      score: null,
      ratio: null,
    });
  });
});

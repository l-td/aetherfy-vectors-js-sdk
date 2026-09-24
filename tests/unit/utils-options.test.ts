/**
 * Unit tests for assertAllowedOptionKeys — runtime kwarg-allowlist guard
 * shared by scrollIter, Namespace.iter, and Thread.iterHistory.
 */

import { assertAllowedOptionKeys } from '../../src/utils/options';

describe('assertAllowedOptionKeys', () => {
  const ALLOWED = ['batchSize', 'filter', 'withPayload', 'withVectors'];

  it('empty options object → no throw', () => {
    expect(() => assertAllowedOptionKeys({}, ALLOWED, 'm')).not.toThrow();
  });

  it('all-allowed keys → no throw', () => {
    expect(() =>
      assertAllowedOptionKeys(
        {
          batchSize: 256,
          filter: { must: [] },
          withPayload: true,
          withVectors: false,
        },
        ALLOWED,
        'm'
      )
    ).not.toThrow();
  });

  it('subset of allowed keys → no throw', () => {
    expect(() =>
      assertAllowedOptionKeys({ batchSize: 100 }, ALLOWED, 'm')
    ).not.toThrow();
  });

  it('one unknown key → throws with method name and the unknown key in the message', () => {
    expect(() =>
      assertAllowedOptionKeys({ limit: 100 }, ALLOWED, 'scrollIter')
    ).toThrow(/scrollIter: unknown option\(s\): limit/);
  });

  it('multiple unknown keys → throws listing each of them', () => {
    expect(() =>
      assertAllowedOptionKeys(
        { limit: 100, offset: 'x', random: true },
        ALLOWED,
        'scrollIter'
      )
    ).toThrow(/limit.*offset.*random/);
  });

  it('mixed allowed + unknown → throws naming only the unknown ones', () => {
    // jest's .toThrow() takes string | RegExp | Constructable | Error, not
    // a callback — so capture the thrown error via try/catch and assert
    // separately. Same pattern as the "no guidance" test below.
    let captured: Error | null = null;
    try {
      assertAllowedOptionKeys(
        { batchSize: 100, limit: 50 }, // batchSize ok, limit unknown
        ALLOWED,
        'm'
      );
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).not.toBeNull();
    // Only `limit` is reported as unknown; batchSize appears solely in the
    // list of accepted options.
    expect(captured!.message).toMatch(/unknown option\(s\): limit\. /);
    expect(captured!.message).not.toMatch(/unknown option\(s\):[^.]*batchSize/);
  });

  it('guidance line is appended when provided', () => {
    expect(() =>
      assertAllowedOptionKeys(
        { limit: 100 },
        ALLOWED,
        'scrollIter',
        'Pass batchSize to control page size; limit and offset are owned by the iterator.'
      )
    ).toThrow(/limit and offset are owned by the iterator/);
  });

  it('no guidance → message ends after the accepted list (no trailing space)', () => {
    let captured: Error | null = null;
    try {
      assertAllowedOptionKeys({ limit: 100 }, ALLOWED, 'm');
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).not.toBeNull();
    expect(captured).toBeInstanceOf(TypeError);
    expect(captured!.message).toBe(
      'm: unknown option(s): limit. Accepted: batchSize, filter, withPayload, withVectors.'
    );
  });
});

/**
 * optionKeys(): the runtime key list of an options type cannot drift from the
 * type, in either direction, without a COMPILE error.
 *
 * The assertions that matter here are the `@ts-expect-error` lines, not the
 * `expect` calls. ts-jest type-checks this file, and an `@ts-expect-error`
 * over a line that compiles is itself an error (TS2578), so the file stops
 * compiling and the suite goes red if optionKeys() ever loses either check:
 *
 *   - MISSING: a key the type declares and the list leaves out. This is what
 *     happens when a field is added to an interface and not to its list, and
 *     the new field would then be refused for every caller.
 *   - EXTRA: a key the list names and the type does not declare. This is what
 *     happens when a field is removed from an interface (or misspelt in the
 *     list), and the list would then accept a key nothing reads.
 *
 * Both are exercised on a real public options type (ClientConfig) as well as a
 * toy one, so a change to how ClientConfig is declared (an index signature, a
 * `Partial<>` wrapper) that would quietly defeat the check shows up here too.
 * Neither call below runs: they sit in a function that is never invoked,
 * because the point is what the compiler says about them.
 */

import { ClientConfig } from '../../src/models';
import { optionKeys } from '../../src/utils/options';

interface Toy {
  required: string;
  optional?: number;
}

// Never called: see the header.
export function compileTimeChecks(): void {
  // Complete and exact: compiles.
  optionKeys<Toy>({ required: true, optional: true });

  // @ts-expect-error MISSING: `optional` is declared on Toy and left out.
  optionKeys<Toy>({ required: true });

  // @ts-expect-error EXTRA: `stray` is not declared on Toy.
  optionKeys<Toy>({ required: true, optional: true, stray: true });

  // @ts-expect-error MISSING, on a real options type: `apiRegion` left out.
  optionKeys<ClientConfig>({
    apiKey: true,
    endpoint: true,
    timeout: true,
    enableConnectionPooling: true,
    workspace: true,
  });

  optionKeys<ClientConfig>({
    apiKey: true,
    endpoint: true,
    timeout: true,
    enableConnectionPooling: true,
    workspace: true,
    apiRegion: true,
    // @ts-expect-error EXTRA, on a real options type: the pre-rename name.
    region: true,
  });
}

describe('optionKeys', () => {
  it('returns exactly the keys it was given, frozen', () => {
    const keys = optionKeys<Toy>({ required: true, optional: true });

    expect([...keys].sort()).toEqual(['optional', 'required']);
    expect(Object.isFrozen(keys)).toBe(true);
  });
});

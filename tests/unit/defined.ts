/**
 * `value`, or a test failure that names what was missing.
 *
 * Replaces `value!` in tests: a non-null assertion that is wrong surfaces as
 * a TypeError somewhere downstream, with no hint of which lookup came back
 * empty. This says so, and needs no lint exemption.
 */
export function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${what} to be defined`);
  }
  return value;
}

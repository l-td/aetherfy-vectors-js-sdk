import { Filter } from '../models';

/**
 * Filter clause translation: SDK vocabulary -> wire vocabulary.
 *
 * Why this exists: the JS SDK speaks camelCase (`mustNot`, `withPayload`,
 * `scoreThreshold`) and the API speaks snake_case. Every other option on
 * every other method is translated explicitly at the call site — but the
 * filter object used to be forwarded to the engine VERBATIM. `must` and
 * `should` survived that by accident (they are spelled identically in both
 * vocabularies); `mustNot` did not. The engine has no `mustNot` key, so a
 * `mustNot` clause was dropped on the floor: no error, no warning, and the
 * points the caller meant to exclude came back in the results.
 *
 * The Python SDK never had the bug — `Filter.to_dict()` emits `must_not`
 * (aetherfy_vectors/models.py) — so this closes a cross-SDK behavior split
 * as well.
 *
 * Two properties are load-bearing:
 *
 *   1. Unknown keys throw. The 958a600 discipline: a filter clause that the
 *      SDK does not recognize is a caller mistake, and silently forwarding
 *      it is how `mustNot` stayed invisible for so long. TypeScript's
 *      excess-property check only fires on fresh object literals, so a
 *      pre-built variable, an `as any` cast, or any untyped JS caller can
 *      reach here with `{ must_not: [...] }` or `{ mustnot: [...] }`. They
 *      fail loudly instead.
 *
 *   2. Output key order is fixed (must, must_not, should) rather than
 *      caller insertion order. Server cache keys are derived from the
 *      request body BYTES, so two callers writing the same three clauses in
 *      different orders would otherwise occupy two cache entries. A fixed
 *      order collapses them onto one.
 *
 * Insertion order here IS the emitted order — do not reorder casually.
 */
const FILTER_CLAUSE_WIRE_KEYS: ReadonlyArray<readonly [keyof Filter, string]> =
  [
    ['must', 'must'],
    ['mustNot', 'must_not'],
    ['should', 'should'],
  ];

const KNOWN_CLAUSES: ReadonlySet<string> = new Set(
  FILTER_CLAUSE_WIRE_KEYS.map(([sdkKey]) => sdkKey as string)
);

/**
 * Translate a `Filter` into the request-body object the API expects.
 *
 * Returns `undefined` for `undefined`/`null` input so callers can assign the
 * result straight into a body literal — `JSON.stringify` omits the key, and
 * a filterless request keeps the byte-for-byte body it always had.
 *
 * @param filter - The caller's filter, in SDK (camelCase) vocabulary.
 * @param methodName - Method name, used in the error message on an unknown key.
 * @throws Error if the filter carries a key outside {must, mustNot, should}.
 */
export function serializeFilter(
  filter: Filter | undefined | null,
  methodName: string
): Record<string, unknown> | undefined {
  if (filter === undefined || filter === null) return undefined;

  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error(
      `${methodName}: filter must be an object with must / mustNot / should clauses.`
    );
  }

  const unknown = Object.keys(filter).filter(k => !KNOWN_CLAUSES.has(k));
  if (unknown.length > 0) {
    const snakeHint = unknown.includes('must_not')
      ? ' Write the clause as `mustNot`; the SDK translates it to the wire key `must_not`.'
      : '';
    throw new Error(
      `${methodName}: unknown filter clause(s): ${unknown.join(', ')}. ` +
        `Valid clauses are must, mustNot, should.${snakeHint}`
    );
  }

  const out: Record<string, unknown> = {};
  for (const [sdkKey, wireKey] of FILTER_CLAUSE_WIRE_KEYS) {
    const value = filter[sdkKey];
    if (value !== undefined) out[wireKey] = value;
  }
  return out;
}

import { Filter } from '../models';

/**
 * Filter clause translation: SDK vocabulary -> wire vocabulary.
 *
 * Why this exists: the JS SDK speaks camelCase (`mustNot`, `minShould`,
 * `withPayload`, `scoreThreshold`) and the API speaks snake_case. Every other
 * option on every other method is translated explicitly at the call site, and
 * so is the filter: `must` and `should` are spelled identically in both
 * vocabularies, `mustNot` and `minShould` are not.
 *
 * Two properties are load-bearing:
 *
 *   1. The SDK judges no key. The API checks every key of a filter and
 *      answers an unknown one with a 400 INVALID_FILTER naming the key's path
 *      and the nearest valid key (thrown as `InvalidFilterError`), so a
 *      clause name the SDK does not translate (`must_not` written by hand, a
 *      typo, a clause added to the API tomorrow) is sent as written and
 *      judged there. A list of valid names kept here could only lag the API:
 *      the previous one refused `min_should` for as long as it existed.
 *
 *   2. Output key order is fixed (must, must_not, should, min_should, then any
 *      other key in the caller's order) rather than caller insertion order.
 *      Server cache keys are derived from the request body BYTES, so two
 *      callers writing the same clauses in different orders would otherwise
 *      occupy two cache entries. A fixed order collapses them onto one.
 *
 * Insertion order here IS the emitted order — do not reorder casually.
 */
const FILTER_CLAUSE_WIRE_KEYS: ReadonlyArray<readonly [keyof Filter, string]> =
  [
    ['must', 'must'],
    ['mustNot', 'must_not'],
    ['should', 'should'],
    ['minShould', 'min_should'],
  ];

const TRANSLATED_CLAUSES: ReadonlySet<string> = new Set(
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
 * @param methodName - Method name, used in the error message when the filter is not an object.
 * @throws Error if the filter is not an object.
 */
export function serializeFilter(
  filter: Filter | undefined | null,
  methodName: string
): Record<string, unknown> | undefined {
  if (filter === undefined || filter === null) return undefined;

  if (typeof filter !== 'object' || Array.isArray(filter)) {
    throw new Error(
      `${methodName}: filter must be an object with must / mustNot / should / minShould clauses.`
    );
  }

  const out: Record<string, unknown> = {};
  for (const [sdkKey, wireKey] of FILTER_CLAUSE_WIRE_KEYS) {
    const value = filter[sdkKey];
    if (value !== undefined) out[wireKey] = value;
  }
  // Every other key goes as written, to be judged by the API.
  for (const [key, value] of Object.entries(filter)) {
    if (!TRANSLATED_CLAUSES.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

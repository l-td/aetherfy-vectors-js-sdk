/**
 * Runtime guard: an options object carries only the keys its type declares.
 *
 * Why this exists: TypeScript rejects an unknown key only in a fresh object
 * literal at a typed call site. A plain-JavaScript caller, an options object
 * built elsewhere, a spread, or an `as any` cast gets no check at all, and the
 * SDK reads only the keys it knows, so the stray key is ignored. The case that
 * mattered: `new AetherfyVectorsClient({ apiKey, region: 'eu-central-1' })`
 * (the Python SDK's pre-rename spelling) constructed a client connected to the
 * DEFAULT endpoint, with no error. The Python SDK raises TypeError for an
 * unknown keyword argument; every public options object here does the same.
 *
 * THE ALLOWED KEYS ARE DERIVED, NOT RETYPED. Each list is built with
 * {@link optionKeys}, whose argument must name every key of the type, and
 * nothing else, or the SDK does not compile:
 *
 *   - a field added to the interface and not to the list is a missing
 *     property ("Property 'x' is missing in type ...");
 *   - a key in the list that the interface does not have is an excess
 *     property in an object literal ("Object literal may only specify known
 *     properties").
 *
 * So the runtime list cannot drift from the type in either direction without
 * `npm run type-check` (and the unit lane, which compiles the same source)
 * going red. tests/unit/option-keys.test.ts pins both directions of the
 * mechanism itself.
 *
 * A KEY IS A KEY, WHATEVER ITS VALUE. `{ region: undefined }` is refused like
 * `{ region: 'eu-central-1' }`: Python's `f(region=None)` is a TypeError too,
 * because what is checked is the NAME the caller used, not the value. A
 * declared key set to `undefined` is accepted and means "not set", as it
 * always has.
 *
 * Data objects are out of scope: a point, a payload, a schema, a collection's
 * vector config, a spawn payload. Those are values the caller hands over, not
 * keyword arguments, and the Python SDK does not key-check their dict
 * equivalents either. Filters have their own guard (`serializeFilter`).
 */

/**
 * Every key of `T`, each mapped to `true` — optional keys included, so none
 * can be left out.
 */
export type OptionKeyShape<T> = { readonly [K in keyof T]-?: true };

/**
 * The runtime key list of an options type. Pass an object literal naming every
 * key of `T` with the value `true`; see the module comment for why this is a
 * compile error when it drifts.
 */
export function optionKeys<T>(shape: OptionKeyShape<T>): readonly string[] {
  return Object.freeze(Object.keys(shape));
}

/**
 * Throw a TypeError naming the method and every key of `options` that is not
 * in `allowed`. `options` must be a plain object (callers default it to `{}`,
 * so an omitted argument never reaches here as `undefined`).
 */
export function assertAllowedOptionKeys(
  options: unknown,
  allowed: readonly string[],
  methodName: string,
  guidance?: string
): void {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError(
      `${methodName}: options must be an object, got ${
        options === null
          ? 'null'
          : Array.isArray(options)
            ? 'an array'
            : typeof options
      }.`
    );
  }
  const unknown = Object.keys(options).filter(k => !allowed.includes(k));
  if (unknown.length > 0) {
    const guidanceLine = guidance ? ` ${guidance}` : '';
    throw new TypeError(
      `${methodName}: unknown option(s): ${unknown.join(', ')}. ` +
        `Accepted: ${allowed.join(', ')}.${guidanceLine}`
    );
  }
}

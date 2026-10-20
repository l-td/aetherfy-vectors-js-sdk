/**
 * Collection storage modes.
 *
 * A collection's storage mode is a preset for how its vectors are stored
 * and searched. The service compiles it to the engine's configuration; the
 * caller never sends engine tuning directly.
 *
 * - `exact` (the default): full-precision vectors in memory, search reads
 *   them.
 * - `balanced`: an 8-bit copy of each vector is searched, the originals sit on
 *   disk and rescore the best candidates. Uses far less memory than exact.
 * - `fast`: the same 8-bit copy, with the originals kept in memory too. Uses
 *   MORE memory than exact, not less.
 *
 * `fast` is available on the Performance plan and above; `exact` and
 * `balanced` on every plan. A mode outside the plan throws
 * StorageModeNotInPlanError.
 *
 * The Python SDK accepts the same names (`storage_mode`).
 */

export enum StorageMode {
  EXACT = 'exact',
  BALANCED = 'balanced',
  FAST = 'fast',
}

/** What a collection created without `storageMode` gets. */
export const DEFAULT_STORAGE_MODE = StorageMode.EXACT;

const NAMES: readonly string[] = Object.values(StorageMode);

/**
 * `value` as a StorageMode.
 *
 * @throws TypeError if it is not one of the three modes. A typo fails here,
 *   before a round trip, and names the accepted values.
 */
export function coerceStorageMode(value: unknown): StorageMode {
  if (typeof value === 'string' && NAMES.includes(value)) {
    return value as StorageMode;
  }
  throw new TypeError(
    `Invalid storageMode: ${JSON.stringify(value)}. ` +
      `Must be one of: ${NAMES.join(', ')}`
  );
}

/**
 * Read a mode off a server response. A known mode becomes the enum member; a
 * name this SDK has not heard of (a newer server) is returned as the plain
 * string rather than throwing, so listing collections keeps working across a
 * server upgrade; anything else (an older server that reports no mode) is
 * `undefined`.
 */
export function parseStorageMode(
  value: unknown
): StorageMode | string | undefined {
  return typeof value === 'string' ? value : undefined;
}

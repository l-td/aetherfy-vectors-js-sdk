/**
 * Collection performance modes.
 *
 * A collection's performance mode is a preset for how its vectors are stored
 * and searched. The service compiles it to the engine's configuration; the
 * caller never sends engine tuning directly.
 *
 * - `exact` (the default): full-precision vectors in memory, search reads
 *   them.
 * - `balanced`: an 8-bit copy of each vector is searched, the originals sit on
 *   disk and rescore the best candidates. Uses far less memory than exact.
 * - `fast`: the same 8-bit copy, with the originals kept in memory too. Uses
 *   MORE memory than exact, not less.
 * - `compact`: a 2-bit copy, originals on disk. The smallest footprint and the
 *   lossiest mode; needs vectors of at least 512 dimensions.
 *
 * The Python SDK accepts the same names (`performance_mode`).
 */

export enum PerformanceMode {
  EXACT = 'exact',
  BALANCED = 'balanced',
  FAST = 'fast',
  COMPACT = 'compact',
}

/** A mode as the caller may write it: the enum member or its name. */
export type PerformanceModeInput =
  | PerformanceMode
  | 'exact'
  | 'balanced'
  | 'fast'
  | 'compact';

/** What a collection created without `performanceMode` gets. */
export const DEFAULT_PERFORMANCE_MODE = PerformanceMode.EXACT;

const NAMES: readonly string[] = Object.values(PerformanceMode);

/**
 * `value` as a PerformanceMode.
 *
 * @throws TypeError if it is not one of the four modes. A typo fails here,
 *   before a round trip, and names the accepted values.
 */
export function coercePerformanceMode(value: unknown): PerformanceMode {
  if (typeof value === 'string' && NAMES.includes(value)) {
    return value as PerformanceMode;
  }
  throw new TypeError(
    `Invalid performanceMode: ${JSON.stringify(value)}. ` +
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
export function parsePerformanceMode(
  value: unknown
): PerformanceMode | string | undefined {
  return typeof value === 'string' ? value : undefined;
}

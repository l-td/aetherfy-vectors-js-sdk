/**
 * Byte-bounded chunking for upsert payloads.
 *
 * Single source of truth for the rule: never POST/PUT more than
 * MAX_REQUEST_BYTES of points to the backend in one HTTP request. The
 * client→backend hop terminates at Cloudflare's edge, whose body-size cap
 * is 100 MB on Free/Pro/Business plans (500 MB on Enterprise). A request
 * exceeding that cap is rejected with 413 BEFORE reaching our origin —
 * the server-side streaming chunker can't help because Cloudflare buffers
 * the body before forwarding.
 *
 * Why bytes, not point count: a 1000-vector batch is ~35 MB for 384-dim
 * vectors and ~138 MB for 1536-dim vectors. A count cap that's safe for
 * the largest case wastes throughput on the smallest. A byte cap is
 * robust across dim and payload shape.
 *
 * Mirror of vectordb/backend/services/chunking.js (server-side) with a
 * higher threshold tuned to Cloudflare's edge limit instead of Qdrant's
 * 32 MB body cap.
 */

/**
 * Per-HTTP-request byte target. The binding constraint is NOT Cloudflare's
 * 100 MB body cap — it's the BACKEND'S PROCESSING TIME. The server re-chunks
 * each request into ~12 MB Qdrant sub-batches and writes them with
 * `wait=true` (Qdrant segment commit ~1-5 s each, serial) inside a 90 s
 * request timeout. An 80 MB request stacks ~7 commits and can exceed 90 s,
 * which the proxy/origin returns as a 5xx — the chunk then lands in
 * PartialUpsertError.failed. (`wait=true` is load-bearing: cross-region
 * replication retrieves points by ID and relies on committed ⟺ retrievable,
 * so it can't be relaxed.)
 *
 * 24 MB ≈ 2 server sub-batches ≈ well under the 90 s budget with wide
 * margin, and far under the 100 MB body cap. Larger upserts simply become
 * more (reliable) requests. Tunable down to ~12 MB (1 sub-batch/request)
 * for maximum margin if commits run slow under load.
 *
 * Mirror of aetherfy_vectors/chunking.py — keep the two in lockstep.
 */
export const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

const FLOAT_JSON_BYTES = 18;
const POINT_FRAMING_BYTES = 100;

/**
 * Estimate the JSON wire size of a single point.
 *
 * Returns 0 for unmeasurable input (caller treats as "send alone" so the
 * chunker doesn't infinite-loop on adversarial input). Otherwise:
 *   framing + (vector.length × 18) + JSON.stringify(payload).length
 *
 * Vector serialization is skipped — V8 stringifies a float as up to 17
 * significant digits + comma, so `vector.length * 18` is a deterministic
 * upper bound that costs O(1) instead of O(dim) per point.
 *
 * On a non-stringifiable (circular) payload, returns MAX_REQUEST_BYTES so
 * the offending point gets isolated in its own chunk and the eventual
 * server-side error message points at the right point id.
 */
export function pointWireBytes(point: unknown): number {
  if (!point || typeof point !== 'object') return 0;
  const p = point as { vector?: unknown; payload?: unknown };
  let bytes = POINT_FRAMING_BYTES;
  if (Array.isArray(p.vector)) {
    bytes += p.vector.length * FLOAT_JSON_BYTES;
  }
  if (p.payload && typeof p.payload === 'object') {
    try {
      bytes += JSON.stringify(p.payload).length;
    } catch {
      return MAX_REQUEST_BYTES;
    }
  }
  return bytes;
}

/**
 * Split an in-memory points array into byte-bounded chunks.
 *
 * Generator so callers can pipeline (POST chunk N while preparing
 * chunk N+1). The chunker accumulates one point at a time and flushes
 * before adding a point that would push the in-flight chunk past
 * targetBytes.
 *
 * Single-point overflow: if one point exceeds targetBytes on its own, it
 * gets its own chunk. The backend (or Cloudflare) may reject it, but the
 * SDK never silently drops data — every point is at least attempted.
 * Callers (upsert) catch the resulting error and surface the point id
 * so the user knows exactly which point is too large.
 */
export function* chunkPointsByBytes<T>(
  points: T[],
  targetBytes: number = MAX_REQUEST_BYTES
): Generator<T[]> {
  if (!Array.isArray(points) || points.length === 0) return;

  let buf: T[] = [];
  let bufBytes = 0;

  for (const point of points) {
    const pb = pointWireBytes(point);
    if (buf.length > 0 && bufBytes + pb > targetBytes) {
      yield buf;
      buf = [];
      bufBytes = 0;
    }
    buf.push(point);
    bufBytes += pb;
  }

  if (buf.length > 0) yield buf;
}

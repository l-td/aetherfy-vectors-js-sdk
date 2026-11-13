/**
 * The in-process memory of `agentUrl` and `agentUrls`.
 *
 * It holds NAME -> URL and nothing else, for {@link PEER_CACHE_SECONDS}. That is
 * the whole of what is safe to remember: a peer's address changes when the peer
 * is recreated, so anything that outlives the address (the peer's state, its
 * kind, the lookup's status) would be a copy that could disagree with the
 * platform. An entry that is not fresh is not served and is dropped on the read
 * that finds it expired.
 *
 * ONLY AN ANSWER IS CACHED. A refusal (no such peer, a peer with no URL) is not
 * remembered, because the very next thing a caller does about it is create or
 * start the peer, and a cached "not found" would then be served for up to
 * thirty seconds after the peer exists.
 *
 * THE CLOCK IS INJECTED. `clock` is any function returning seconds from an
 * arbitrary origin; the default is `performance.now() / 1000`, which is
 * monotonic and immune to wall-clock adjustments. Tests hand in a function over
 * a number they move by hand, so no test ever waits for an expiry.
 */

/**
 * How long a looked-up address is served without asking the control plane
 * again. `fresh: true` skips it. Thirty seconds is the window in which a
 * recreated peer can still be reached at its old address: long enough that a
 * busy caller does one lookup per peer per half minute rather than one per
 * call, short enough that the retired-address retry in `callAgent` is the
 * exception and not the rule.
 */
export const PEER_CACHE_SECONDS = 30;

/**
 * THE LAST ADDRESS KNOWN FOR A PEER outlives the window above, and is served only when the control plane
 * could not answer (429, 5xx, unreachable): an address that was right thirty seconds ago usually still is,
 * and a call that would have worked must not fail because a lookup was refused. It is dropped the moment
 * the control plane answers that the peer is gone (404 or 409), and it is never served to a caller that
 * asked for a fresh one or to the re-lookup after an address stopped answering.
 *
 * HOW LONG AFTER A FAILED LOOKUP THE CONTROL PLANE IS NOT ASKED AGAIN: its Retry-After, kept between the
 * floor and the cap. The floor is what a failure without a Retry-After waits (a sick control plane must not
 * get a lookup per call); the cap stops one long Retry-After from pinning a stale address for minutes.
 */
export const PEER_RETRY_FLOOR_SECONDS = 5;
export const PEER_RETRY_CAP_SECONDS = 60;

/** Seconds not to ask again after a failed lookup that carried this Retry-After (or none). */
export function retryDelay(retryAfter: number | undefined): number {
  if (retryAfter === undefined || Number.isNaN(retryAfter)) {
    return PEER_RETRY_FLOOR_SECONDS;
  }
  return Math.min(Math.max(retryAfter, 0), PEER_RETRY_CAP_SECONDS);
}

export interface PeerWait {
  /** Seconds left of the wait. */
  left: number;
  status: number | undefined;
  code: string | undefined;
}

export type Clock = () => number;

const monotonicSeconds: Clock = () => performance.now() / 1000;

/** Name -> URL for each peer looked up by name, and one entry for the list. */
export class PeerCache {
  private clock: Clock;
  private urls = new Map<string, { url: string; storedAt: number }>();
  private list: { urls: Record<string, string>; storedAt: number } | null =
    null;
  private knownUrls = new Map<string, string>();
  private knownList: Record<string, string> | null = null;
  // key (a name, or null for the list) -> when the failed lookup may be repeated, and what failed
  private blockedUntil = new Map<
    string | null,
    { until: number; status: number | undefined; code: string | undefined }
  >();

  constructor(clock: Clock = monotonicSeconds) {
    this.clock = clock;
  }

  /**
   * Forget everything and use `clock` from now on. For tests: the process's
   * one cache is shared by every call, so a test starts from an empty one with
   * a clock it owns.
   */
  reset(clock: Clock = monotonicSeconds): void {
    this.clock = clock;
    this.urls.clear();
    this.list = null;
    this.knownUrls.clear();
    this.knownList = null;
    this.blockedUntil.clear();
  }

  private fresh(storedAt: number): boolean {
    return this.clock() - storedAt < PEER_CACHE_SECONDS;
  }

  getUrl(name: string): string | undefined {
    const entry = this.urls.get(name);
    if (entry === undefined) return undefined;
    if (this.fresh(entry.storedAt)) return entry.url;
    this.urls.delete(name);
    return undefined;
  }

  putUrl(name: string, url: string): void {
    this.urls.set(name, { url, storedAt: this.clock() });
    this.knownUrls.set(name, url);
    this.blockedUntil.delete(name);
  }

  lastKnownUrl(name: string): string | undefined {
    return this.knownUrls.get(name);
  }

  /** The control plane said the peer is gone: no stale address may be served for it. */
  forgetUrl(name: string): void {
    this.knownUrls.delete(name);
    this.blockedUntil.delete(name);
  }

  block(
    key: string | null,
    seconds: number,
    status: number | undefined,
    code: string | undefined
  ): void {
    this.blockedUntil.set(key, {
      until: this.clock() + seconds,
      status,
      code,
    });
  }

  /** The failed lookup still being waited out, or undefined. */
  blocked(key: string | null): PeerWait | undefined {
    const entry = this.blockedUntil.get(key);
    if (entry === undefined) return undefined;
    const left = entry.until - this.clock();
    if (left <= 0) {
      this.blockedUntil.delete(key);
      return undefined;
    }
    return { left, status: entry.status, code: entry.code };
  }

  /** A COPY: a caller who edits what it was handed must not edit the cache. */
  getList(): Record<string, string> | undefined {
    if (this.list === null) return undefined;
    if (this.fresh(this.list.storedAt)) return { ...this.list.urls };
    this.list = null;
    return undefined;
  }

  putList(urls: Record<string, string>): void {
    this.list = { urls: { ...urls }, storedAt: this.clock() };
    this.knownList = { ...urls };
    this.blockedUntil.delete(null);
  }

  /** A COPY, like getList. */
  lastKnownList(): Record<string, string> | undefined {
    return this.knownList === null ? undefined : { ...this.knownList };
  }
}

/** The one cache of this process. */
export const peerCache = new PeerCache();

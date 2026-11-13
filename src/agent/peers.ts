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

export type Clock = () => number;

const monotonicSeconds: Clock = () => performance.now() / 1000;

/** Name -> URL for each peer looked up by name, and one entry for the list. */
export class PeerCache {
  private clock: Clock;
  private urls = new Map<string, { url: string; storedAt: number }>();
  private list: { urls: Record<string, string>; storedAt: number } | null =
    null;

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
  }
}

/** The one cache of this process. */
export const peerCache = new PeerCache();

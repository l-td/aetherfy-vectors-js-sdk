/**
 * THE package version, and the only literal of it in this tree.
 *
 * It was three literals: `VERSION` in src/index.ts, the User-Agent in
 * src/http/client.ts, and the agent helper's own. The second had already
 * drifted — it still announced 1.0.0 from a 1.1.0 package — and a drifted
 * version string is only ever discovered by whoever is trying to reproduce a
 * bug report from a User-Agent that named the wrong release.
 *
 * It lives in its own module rather than in src/index.ts because the agent
 * subpath needs it too, and importing the root entry there would pull the
 * whole vector client (and axios with it) into a bundle whose job is to read
 * environment variables.
 *
 * package.json is the authority; `tests/unit/agent/packaging.test.ts` pins
 * this against it, and pins both consumers against this.
 */
export const SDK_VERSION = '1.1.0';

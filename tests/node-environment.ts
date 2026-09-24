/**
 * The node test environment, plus one guarantee: whatever network interception
 * a test file set up is removed when that file is done — even if it never ran
 * a single test.
 *
 * Why this exists: tests/node-setup.ts turns nock on for every file
 * (`disableNetConnect`) and used to turn it off in an `afterAll`. A file that
 * fails to LOAD — a thrown error at module scope, a type error ts-jest reports
 * — runs no tests, so its `afterAll` never ran, and its nock instance stayed
 * hooked into Node's http/fetch. Jest gives each file its own nock module but
 * the worker's http module is shared, so every later file on that worker was
 * answered by the leaked instance first: no interceptors, net connect disabled,
 * "Nock: Disallowed net connect" for requests the file HAD mocked. It looked
 * like a load-dependent flake because which files share a worker changes with
 * load; it was deterministic given the order. (Reproduced 2026-09-24: a suite
 * that throws on load, then usage-stats.test.ts, in one process.)
 *
 * `teardown()` runs for every file whatever happened in it, so the restore
 * lives here. node-setup.ts registers it on the file's global; this calls it.
 */
import { TestEnvironment } from 'jest-environment-node';

export default class NodeTestEnvironment extends TestEnvironment {
  async teardown(): Promise<void> {
    const restore = (
      this.global as { __restoreNetworkInterception?: () => void }
    ).__restoreNetworkInterception;
    if (typeof restore === 'function') restore();
    await super.teardown();
  }
}

/**
 * FIXTURE, not a test of the SDK: run only by
 * tests/unit/jest-load-crash-isolation.test.ts. It fails to LOAD on purpose —
 * a throw at module scope, so no test in it ever starts and no afterAll runs.
 * First it records that it ran, so the caller can prove the order.
 */
import { appendFileSync } from 'node:fs';

const orderFile = process.env.AFY_FIXTURE_ORDER_FILE;
if (orderFile) appendFileSync(orderFile, 'a\n');

throw new Error('crash during load (fixture)');

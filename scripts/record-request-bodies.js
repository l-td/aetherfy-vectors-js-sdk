#!/usr/bin/env node

/**
 * Regenerate tests/fixtures/request-bodies.json from the client's mocked HTTP
 * layer:
 *
 *   npm run record:request-bodies
 *
 * Run it after a change to a request the client builds, and commit the file with
 * the change. tests/unit/request-bodies-fixture.test.ts fails while it is stale.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const result = spawnSync(
  process.execPath,
  [
    path.resolve(__dirname, '..', 'node_modules', 'jest', 'bin', 'jest.js'),
    '-c',
    'jest.config.js',
    'tests/unit/request-bodies-fixture.test.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, RECORD_REQUEST_BODIES: '1' },
  }
);
process.exit(result.status === null ? 1 : result.status);

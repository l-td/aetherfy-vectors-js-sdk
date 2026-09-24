/**
 * FIXTURE, not a test of the SDK: run only by
 * tests/unit/jest-load-crash-isolation.test.ts, always AFTER
 * a-crashes-on-load.test.ts in the same process. Its mocked request must be
 * served by ITS nock — which it is only if the crashed file's nock was switched
 * off when that file ended.
 */
import { appendFileSync } from 'node:fs';
import * as http from 'node:http';

import nock from 'nock';

it('is served the reply it mocked', async () => {
  const orderFile = process.env.AFY_FIXTURE_ORDER_FILE;
  if (orderFile) appendFileSync(orderFile, 'b\n');

  const scope = nock('http://fixture.test')
    .get('/ping')
    .reply(200, 'served by nock');

  const body = await new Promise<string>((resolve, reject) => {
    http
      .get('http://fixture.test/ping', response => {
        let data = '';
        response.on('data', chunk => (data += chunk));
        response.on('end', () => resolve(data));
      })
      .on('error', reject);
  });

  expect(body).toBe('served by nock');
  expect(scope.isDone()).toBe(true);
});

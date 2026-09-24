/**
 * The unknown-option refusal survives the build, in every published format.
 *
 * Why this exists: the refusal matters most to the callers TypeScript never
 * sees, plain JavaScript, and they run dist/, not src/. The unit lane proves
 * the source; this proves what a customer installs: the packed tarball,
 * installed into a scratch project (installed-package.ts), loaded through the
 * installed package.json by a fresh `node` process per format.
 *
 *   - require (CommonJS) and import (ESM) of the root: the constructor refuses
 *     `region`, the Python SDK's pre-rename spelling, naming it. On 2b58def it
 *     constructed silently, connected to the default endpoint.
 *   - the same for the agent subpath's fanOut, a second bundle entry.
 *   - the browser build named by the "browser" condition, in a bare global
 *     scope as a page gives a UMD bundle.
 *
 * POSITIVE CONTROL, per format: the same constructor with only declared keys
 * builds a client. A probe that threw for some other reason (a load failure, a
 * missing export) would otherwise read as the refusal. The error is checked by
 * class AND by the exact message, which also proves the minified build kept
 * the property names the accepted list is made of.
 *
 * Needs a BUILT dist/ (or a tarball): `npm run test:package`, which CI runs
 * after `npm run build:prod`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';

import { MANIFEST, installPackage, probe } from './installed-package';

const ROOT = MANIFEST.name;
const AGENT = `${MANIFEST.name}/agent`;

const EXPECTED = {
  refused: {
    isTypeError: true,
    message:
      'AetherfyVectorsClient constructor: unknown option(s): region. ' +
      'Accepted: apiKey, endpoint, timeout, enableConnectionPooling, ' +
      'workspace, apiRegion.',
  },
  control: true,
  fanOut: {
    isTypeError: true,
    message: 'fanOut: unknown option(s): widht. Accepted: width.',
  },
};

/**
 * The probe body, the same for both module formats: `root` and `agent` are
 * bound by the format-specific preamble.
 */
const CHECKS = `
  const refusalOf = fn => {
    try { fn(); return null; }
    catch (e) { return { isTypeError: e instanceof TypeError, message: e.message }; }
  };
  const key = 'afy_test_1234567890123456';
  process.env.AETHERFY_VCPUS = '1';
  process.env.AETHERFY_MEMORY_MB = '256';
  process.env.AETHERFY_REGION = 'us-east-1';
  const out = {
    refused: refusalOf(() => new root.AetherfyVectorsClient({ apiKey: key, region: 'eu-central-1' })),
    control: new root.AetherfyVectorsClient({ apiKey: key, enableConnectionPooling: false }) instanceof root.AetherfyVectorsClient,
  };
  agent.fanOut(x => x, [], { widht: 2 }).then(
    () => { out.fanOut = null; console.log(JSON.stringify(out)); },
    e => {
      out.fanOut = { isTypeError: e instanceof TypeError, message: e.message };
      console.log(JSON.stringify(out));
    }
  );
`;

let scratch: string;
let cleanup: (() => void) | undefined;

beforeAll(() => {
  ({ scratch, cleanup } = installPackage());
}, 600_000);

afterAll(() => {
  cleanup?.();
});

describe('the installed package refuses an unknown option', () => {
  it('require (CommonJS)', () => {
    const result = probe<typeof EXPECTED>(
      scratch,
      'unknown-options.cjs',
      `const root = require('${ROOT}');
       const agent = require('${AGENT}');
       ${CHECKS}`
    );

    expect(result).toEqual(EXPECTED);
  });

  it('import (ESM)', () => {
    const result = probe<typeof EXPECTED>(
      scratch,
      'unknown-options.mjs',
      `import * as root from '${ROOT}';
       import * as agent from '${AGENT}';
       ${CHECKS}`
    );

    expect(result).toEqual(EXPECTED);
  });

  it('the browser build', () => {
    const installed = join(scratch, 'node_modules', ...ROOT.split('/'));
    const browserPath = MANIFEST.exports['.'].browser;
    if (typeof browserPath !== 'string') {
      throw new Error('exports["."].browser must name one file');
    }
    const code = readFileSync(join(installed, browserPath), 'utf8');

    // A bare global scope, as a page gives a UMD bundle. TypeError comes from
    // the sandbox's own realm, so it is compared there.
    const sandbox: Record<string, unknown> = { console, setTimeout };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: browserPath });
    const result = vm.runInContext(
      `(() => {
        const root = AetherfyVectors;
        try {
          new root.AetherfyVectorsClient({ apiKey: 'afy_test_1234567890123456', region: 'eu-central-1' });
          return { refused: null };
        } catch (e) {
          return {
            refused: { isTypeError: e instanceof TypeError, message: e.message },
            control: new root.AetherfyVectorsClient({ apiKey: 'afy_test_1234567890123456' }) instanceof root.AetherfyVectorsClient,
          };
        }
      })()`,
      sandbox
    ) as { refused: unknown; control?: boolean };

    expect(result).toEqual({
      refused: EXPECTED.refused,
      control: EXPECTED.control,
    });
  });
});

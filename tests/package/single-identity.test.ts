/**
 * One identity per class, in the package a customer actually installs.
 *
 * Why this exists: `AgentError extends AetherfyVectorsError` in TypeScript, and
 * until 2026-09-24 that was FALSE at runtime for every customer. Rollup built
 * the root and the agent subpath as two independent bundles, each with its own
 * copy of src/exceptions.ts, so
 *     new AgentError('x') instanceof AetherfyVectorsError   // false
 * and a catch-all on the base class silently skipped every agent error. The
 * same symptom has a second road, the DUAL PACKAGE HAZARD: a CommonJS build
 * and an ESM build are two packages to Node, and an app that loads both (its
 * own `import`, a dependency's `require`) gets every class twice.
 *
 * The fix is one CommonJS build with both entry points and a shared chunk, and
 * ESM entry points that are thin wrappers over it (Node's documented "ES module
 * wrapper" approach). This test holds it:
 *
 *   It tests the TARBALL, never dist/: `npm pack`, then `npm install` of that
 *   tarball into a scratch project. What `files` and `exports` ship is the
 *   only place a chunk left out of the package, or an exports path pointing at
 *   nothing, can be seen. Every probe runs in a fresh `node` process inside
 *   the scratch project, so resolution is Node's own, through the installed
 *   package.json.
 *
 *   (b) require: an agent error is an instance of the root's base class, and
 *       AgentError's prototype parent IS that class object.
 *   (c) import: the same.
 *   (d) THE HAZARD: one process that imports one entry and requires the other,
 *       both ways round — the same class objects whichever format loaded them.
 *   (e) every name the CJS entry exports, the ESM entry exports (the ESM
 *       wrappers are generated, and must not drop one), and the same default.
 *   (f) the browser build named by the "browser" condition loads and exposes
 *       the client class.
 *   (g) strict TypeScript consumers of both entry points compile against the
 *       installed package under `moduleResolution: bundler` AND `node16`: an
 *       ES module (.mts) that uses the root's DEFAULT import, and a CommonJS
 *       one (.cts) — one per side of the exports map, each with its own
 *       `types`. Before the generated .d.mts twins, node16 found no ES-module
 *       declarations, fell back to index.d.ts (a CommonJS declaration here),
 *       and typed the default import as the module object: "Cannot use
 *       namespace 'AetherfyVectorsClient' as a type", "not constructable".
 *       And under `node10` (TypeScript's classic Node resolution, which
 *       ignores "exports"): a CommonJS consumer of both entries. There the root
 *       resolves through the top-level "types" field and `/agent` through
 *       "typesVersions"; without that mapping `aetherfy-vectors/agent` had no
 *       declarations at all under node10.
 *
 * WHICH TARBALL: see installed-package.ts. With AETHERFY_PACKAGE_TARBALL set,
 * the release's own tarball; unset, dist/ packed here.
 *
 * ANTI-NO-OP: every file the exports map points at must be IN the tarball (read
 * from the tarball itself, not from npm's report of what it packed), and each
 * probe must see a non-empty export list. A test that loaded nothing must not
 * read as a pass.
 *
 * This file needs a BUILT dist/ (or a tarball). It is not part of the unit lane,
 * which runs on source: `npm run test:package`, which CI runs after
 * `npm run build:prod`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { URL, URLSearchParams } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';
import * as vm from 'node:vm';
import { execFileSync } from 'node:child_process';

import {
  ExportTarget,
  MANIFEST,
  REPO_ROOT,
  installPackage,
  probe as probeIn,
} from './installed-package';

/** Every file path an exports target can resolve to, however deeply nested. */
function targetPaths(target: ExportTarget): string[] {
  return typeof target === 'string'
    ? [target]
    : Object.values(target).flatMap(targetPaths);
}

const ROOT = MANIFEST.name;
const AGENT = `${MANIFEST.name}/agent`;

let scratch: string;
let packedFiles: string[];
let cleanup: (() => void) | undefined;

beforeAll(() => {
  ({ scratch, packedFiles, cleanup } = installPackage());
}, 600_000);

afterAll(() => {
  cleanup?.();
});

function probe<T>(file: string, source: string): T {
  return probeIn<T>(scratch, file, source);
}

interface Identity {
  instance: boolean;
  proto: boolean;
  rootKeys: number;
  agentKeys: number;
}

const IDENTITY_CHECKS = `
  const identity = {
    instance: new agent.AgentError('x') instanceof root.AetherfyVectorsError,
    proto: Object.getPrototypeOf(agent.AgentError) === root.AetherfyVectorsError,
    rootKeys: Object.keys(root).length,
    agentKeys: Object.keys(agent).length,
  };
`;

describe('the packed tarball', () => {
  it('contains every file its exports map points at (anti-no-op)', () => {
    const targets = Object.values(MANIFEST.exports)
      .flatMap(targetPaths)
      .map(p => p.replace(/^\.\//, ''));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter(t => !packedFiles.includes(t))).toEqual([]);
    expect(
      packedFiles.filter(f => /\.(c|m)?js$/.test(f)).length
    ).toBeGreaterThan(0);
  });

  it('(b) require: an agent error is an instance of the root base class', () => {
    const result = probe<Identity>(
      'identity.cjs',
      `const root = require('${ROOT}');
       const agent = require('${AGENT}');
       ${IDENTITY_CHECKS}
       console.log(JSON.stringify(identity));`
    );
    expect(result.rootKeys).toBeGreaterThan(0);
    expect(result.agentKeys).toBeGreaterThan(0);
    expect({ instance: result.instance, proto: result.proto }).toEqual({
      instance: true,
      proto: true,
    });
  });

  it('(c) import: an agent error is an instance of the root base class', () => {
    const result = probe<Identity>(
      'identity.mjs',
      `import * as root from '${ROOT}';
       import * as agent from '${AGENT}';
       ${IDENTITY_CHECKS}
       console.log(JSON.stringify(identity));`
    );
    expect(result.rootKeys).toBeGreaterThan(0);
    expect(result.agentKeys).toBeGreaterThan(0);
    expect({ instance: result.instance, proto: result.proto }).toEqual({
      instance: true,
      proto: true,
    });
  });

  it('(d) the dual package hazard: import one entry, require the other', () => {
    // ESM process: import the root, require the agent (and the root again).
    const fromEsm = probe<Record<string, boolean>>(
      'hazard.mjs',
      `import * as esmRoot from '${ROOT}';
       import { createRequire } from 'node:module';
       const require = createRequire(import.meta.url);
       const cjsAgent = require('${AGENT}');
       const cjsRoot = require('${ROOT}');
       console.log(JSON.stringify({
         cjsAgentErrorIsEsmRootBase:
           new cjsAgent.AgentError('x') instanceof esmRoot.AetherfyVectorsError,
         sameBaseClass: esmRoot.AetherfyVectorsError === cjsRoot.AetherfyVectorsError,
         sameClientClass: esmRoot.AetherfyVectorsClient === cjsRoot.AetherfyVectorsClient,
       }));`
    );
    // CJS process: require the root, import the agent.
    const fromCjs = probe<Record<string, boolean>>(
      'hazard.cjs',
      `const cjsRoot = require('${ROOT}');
       import('${AGENT}').then(esmAgent => import('${ROOT}').then(esmRoot => {
         console.log(JSON.stringify({
           esmAgentErrorIsCjsRootBase:
             new esmAgent.AgentError('x') instanceof cjsRoot.AetherfyVectorsError,
           sameAgentError: esmAgent.AgentError === require('${AGENT}').AgentError,
           sameBaseClass: esmRoot.AetherfyVectorsError === cjsRoot.AetherfyVectorsError,
         }));
       }));`
    );
    expect(fromEsm).toEqual({
      cjsAgentErrorIsEsmRootBase: true,
      sameBaseClass: true,
      sameClientClass: true,
    });
    expect(fromCjs).toEqual({
      esmAgentErrorIsCjsRootBase: true,
      sameAgentError: true,
      sameBaseClass: true,
    });
  });

  it('(e) the ESM entries export every name the CJS entries do', () => {
    const parity = probe<
      Record<
        string,
        { missing: string[]; extra: string[]; sameDefault: boolean }
      >
    >(
      'parity.mjs',
      `import { createRequire } from 'node:module';
       const require = createRequire(import.meta.url);
       const out = {};
       for (const spec of ['${ROOT}', '${AGENT}']) {
         const cjs = require(spec);
         const esm = await import(spec);
         const cjsNames = Object.keys(cjs).filter(n => n !== 'default');
         const esmNames = Object.keys(esm).filter(n => n !== 'default');
         out[spec] = {
           count: cjsNames.length,
           missing: cjsNames.filter(n => !esmNames.includes(n)),
           extra: esmNames.filter(n => !cjsNames.includes(n)),
           sameDefault: esm.default === cjs.default,
         };
       }
       console.log(JSON.stringify(out));`
    );
    for (const spec of [ROOT, AGENT]) {
      expect(
        (parity[spec] as unknown as { count: number }).count
      ).toBeGreaterThan(0);
      expect({ spec, ...parity[spec] }).toEqual({
        spec,
        count: expect.any(Number),
        missing: [],
        extra: [],
        sameDefault: true,
      });
    }
  });

  it('(f) the browser build loads and exposes the client class', () => {
    const installed = join(scratch, 'node_modules', ...ROOT.split('/'));
    const browserPath = MANIFEST.exports['.'].browser;
    if (typeof browserPath !== 'string') {
      throw new Error('exports["."].browser must name one file');
    }
    const code = readFileSync(join(installed, browserPath), 'utf8');

    // A bare global scope, as a page gives a UMD bundle: no `module`, no
    // `exports`, no `define`, so it must attach itself to the global.
    const sandbox: Record<string, unknown> = {
      console,
      setTimeout,
      clearTimeout,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: browserPath });

    const exported = sandbox.AetherfyVectors as
      | Record<string, unknown>
      | undefined;
    expect(typeof exported?.AetherfyVectorsClient).toBe('function');
  });

  // The consumer uses the root's DEFAULT import (the form the docs show), named
  // value and type imports from both entry points, and the subclass relation
  // the runtime tests above prove — so a declaration that drifted from the
  // runtime shape fails here, not in a customer's editor.
  const CONSUMER = `import AetherfyVectorsClient, {
  AetherfyVectorsError,
  type ScrollOptions,
  type ScrollResult,
} from '${ROOT}';
import { AgentError, spawn, type Run } from '${AGENT}';

const client: AetherfyVectorsClient = new AetherfyVectorsClient({
  apiKey: 'afy_test_1234567890123456',
});
const base: AetherfyVectorsError = new AgentError('x');
const options: ScrollOptions = { limit: 1 };
const page: Promise<ScrollResult> = client.scroll('docs', options);
const run: Promise<{ spawn_id: string }> = spawn('child');
export const used: unknown[] = [base, page, run, null as Run | null];
`;

  // node10 predates "exports" and ES-module syntax in declarations: a plain
  // CommonJS consumer, named imports only, one value and one type from each
  // entry point.
  const NODE10_CONSUMER = `import { AetherfyVectorsClient, ScrollOptions } from '${ROOT}';
import { AgentError, Run } from '${AGENT}';

const client: AetherfyVectorsClient = new AetherfyVectorsClient({
  apiKey: 'afy_test_1234567890123456',
});
const options: ScrollOptions = { limit: 1 };
const error: Error = new AgentError('x');
export const used: unknown[] = [client, options, error, null as Run | null];
`;

  it.each([
    {
      resolution: 'bundler',
      module: 'esnext',
      files: ['consumer.mts', 'consumer.cts'],
    },
    {
      resolution: 'node16',
      module: 'node16',
      files: ['consumer.mts', 'consumer.cts'],
    },
    { resolution: 'node10', module: 'commonjs', files: ['consumer-node10.ts'] },
  ])(
    '(g) strict TypeScript consumers type-check under moduleResolution $resolution',
    ({ resolution, module, files }) => {
      // bundler/node16: the same source as an ES module and as CommonJS, the
      // two sides of the exports map, each with its own `types`. node10: the
      // CommonJS consumer above, through "types" and "typesVersions".
      writeFileSync(join(scratch, 'consumer.mts'), CONSUMER);
      writeFileSync(join(scratch, 'consumer.cts'), CONSUMER);
      writeFileSync(join(scratch, 'consumer-node10.ts'), NODE10_CONSUMER);
      const config = `tsconfig.${resolution}.json`;
      writeFileSync(
        join(scratch, config),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'es2022',
            lib: ['es2022', 'dom'],
            module,
            moduleResolution: resolution,
            // The package's own declarations are checked too, not skipped:
            // they are what this test is about.
            skipLibCheck: false,
            // Node's types from this repo's lockfile, as any Node consumer has.
            typeRoots: [join(REPO_ROOT, 'node_modules', '@types')],
            types: ['node'],
          },
          files,
        })
      );
      const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
      let output = '';
      try {
        execFileSync(process.execPath, [tsc, '-p', config], {
          cwd: scratch,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string };
        output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`.trim();
        if (!output) output = String(error);
      }
      expect(output).toBe('');
    }
  );
});

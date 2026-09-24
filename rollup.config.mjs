import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve as resolvePath, sep } from 'node:path';

import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import nodePolyfills from 'rollup-plugin-polyfill-node';

// Check for production mode safely across environments
const isProduction = process.env.NODE_ENV === 'production';

/**
 * The ESM entry points, each a WRAPPER over the CommonJS entry it names.
 *
 * .mjs, NOT .esm.js: this package has no "type": "module", so a .js file has
 * no declared module type — Node tries it as CommonJS, fails, and reparses it
 * as ESM, which it calls out as a performance overhead and warns about with
 * MODULE_TYPELESS_PACKAGE_JSON. (Measured on node 22.20.0: the warning prints
 * from a repo checkout and is suppressed under node_modules, so it is not
 * customer log noise; the extension is still the correct one, one reparse
 * less on every import, and a clean console for a linked workspace, a
 * vendored copy or a bundler's dev server.)
 *
 * Each wrapper has a DECLARATION TWIN (.d.mts), and package.json names both in
 * "exports" (`import: { types: .d.mts, default: .mjs }`). Without it,
 * TypeScript under node16/nodenext found no .d.mts, fell back to the .d.ts —
 * which this package's missing "type": "module" makes a CommonJS declaration —
 * and typed `import AetherfyVectorsClient from 'aetherfy-vectors'` in an ES
 * module as the whole module object: "not constructable", while at runtime the
 * default IS the class. `declarations` is the .d.ts tsc emits for the entry,
 * which the twin re-exports.
 */
const ESM_WRAPPERS = {
  'index.cjs.js': {
    wrapper: 'index.mjs',
    twin: 'index.d.mts',
    declarations: 'index.d.ts',
  },
  'agent.cjs.js': {
    wrapper: 'agent.esm.mjs',
    twin: 'agent.d.mts',
    declarations: 'agent/index.d.ts',
  },
};

/**
 * Generate the ESM wrappers from the BUILT CommonJS entries.
 *
 * ONE IDENTITY PER CLASS. An ESM build of its own would be a second copy of
 * every class — Node's "dual package hazard": an app whose own code `import`s
 * this package while a dependency `require`s it gets two AetherfyVectorsError
 * objects, and `instanceof` fails across them. A wrapper that re-exports the
 * CommonJS module's own bindings (Node's documented "ES module wrapper"
 * approach) cannot diverge from it: both formats hand out the same objects.
 *
 * The export list is READ OFF the built module (require it, Object.keys), never
 * written by hand — a hand-kept list drifts the first time someone adds an
 * export. The wrapper destructures the CommonJS module object rather than using
 * named imports, so it does not depend on Node's static analysis of the
 * CommonJS file (cjs-module-lexer) to find the names.
 *
 * `default` is re-exported as the CommonJS module's `default` property, NOT as
 * the module object: `import AetherfyVectorsClient from 'aetherfy-vectors'` is
 * documented and must keep returning the client class. An entry with no
 * default export (the agent subpath) gets none.
 *
 * The twin says the same in types: `export *` from the entry's declarations,
 * plus, when there is a default, `export { <Name> as default }`, where <Name> is
 * READ OFF the built module too — the one named export that is the very object
 * `default` is. Nothing about the default is written down twice.
 */
function esmWrappers() {
  return {
    name: 'esm-wrappers',
    writeBundle(options, bundle) {
      const require = createRequire(import.meta.url);
      const outDir = resolvePath(options.dir);
      // Watch mode rebuilds in the same process: never read a stale module.
      for (const key of Object.keys(require.cache)) {
        if (key.startsWith(outDir + sep)) delete require.cache[key];
      }
      for (const [cjsFile, { wrapper, twin, declarations }] of Object.entries(
        ESM_WRAPPERS
      )) {
        if (!bundle[cjsFile] || !bundle[cjsFile].isEntry) {
          this.error(
            `${cjsFile} is not an entry of this build, so ${wrapper} cannot wrap it.`
          );
        }
        if (!existsSync(resolvePath(outDir, declarations))) {
          this.error(
            `${declarations} was not emitted, so ${twin} would re-export nothing.`
          );
        }
        const cjs = require(resolvePath(outDir, cjsFile));
        const names = Object.keys(cjs).filter(name => name !== 'default');
        if (names.length === 0) {
          this.error(
            `${cjsFile} exports nothing; refusing to write an empty ${wrapper}.`
          );
        }
        let defaultName = null;
        if ('default' in cjs) {
          const matches = names.filter(name => cjs[name] === cjs.default);
          if (matches.length !== 1) {
            this.error(
              `${cjsFile}'s default export is ${matches.length === 0 ? 'no' : 'more than one'} named export ` +
                `(${matches.join(', ') || 'none'}), so ${twin} cannot name its type.`
            );
          }
          defaultName = matches[0];
        }

        const header = [
          `// GENERATED by rollup.config.mjs from ./${cjsFile}. Do not edit.`,
        ];
        const wrapperLines = [
          ...header,
          '// An ES module wrapper over the CommonJS build, so `import` and',
          '// `require` return the same class objects (one identity per class).',
          `import cjs from './${cjsFile}';`,
          '',
          `export const {\n${names.map(name => `  ${name},`).join('\n')}\n} = cjs;`,
        ];
        if (defaultName) wrapperLines.push('export default cjs.default;');
        writeFileSync(
          resolvePath(outDir, wrapper),
          `${wrapperLines.join('\n')}\n`
        );

        const from = `./${declarations.replace(/\.d\.ts$/, '.js')}`;
        const twinLines = [
          ...header,
          `// The ES-module declarations for ./${wrapper}: its types are those of`,
          `// ./${declarations}${defaultName ? ', with the default export named for what it is' : ''}.`,
          `export * from '${from}';`,
        ];
        if (defaultName) {
          twinLines.push(
            `export { ${defaultName} as default } from '${from}';`
          );
        }
        writeFileSync(resolvePath(outDir, twin), `${twinLines.join('\n')}\n`);
      }
    },
  };
}

export default [
  // Node.js: ONE CommonJS build with BOTH entry points.
  //
  // One build, not one per entry point, so the modules both entries share
  // (src/exceptions.ts above all) land in ONE shared chunk that both require.
  // Two builds gave each entry its own copy of AetherfyVectorsError, and
  // `new AgentError('x') instanceof AetherfyVectorsError` was false for every
  // customer. tests/package/single-identity.test.ts holds this.
  //
  // The agent helper is still its OWN entry point, not a re-export from index:
  // code running on a machine has no reason to load the whole vector client
  // (and axios with it) to read an environment variable. It shares only what
  // it actually imports. It is also why the browser bundle below does not
  // carry it — `node:fs/promises` has no meaning there, and a task does not
  // run in a browser.
  {
    input: { index: 'src/index.ts', agent: 'src/agent/index.ts' },
    output: {
      dir: 'dist',
      format: 'cjs',
      exports: 'named',
      sourcemap: true,
      entryFileNames: '[name].cjs.js',
      // No hash: the file set is the same on every build, so nothing that
      // names a dist file (package.json, CI, the e2e suite) is chasing it.
      chunkFileNames: 'chunks/[name].cjs.js',
    },
    external: ['cross-fetch', 'form-data', 'node:fs/promises'],
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        sourceMap: true,
      }),
      resolve({
        preferBuiltins: true,
      }),
      commonjs(),
      isProduction && terser(),
      esmWrappers(),
    ].filter(Boolean),
  },

  // Browser build (secondary). SELF-CONTAINED on purpose: a page loads this
  // one file and never mixes it with the Node entry points above, so a copy
  // of the classes here cannot meet the copy in the CommonJS build.
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/browser.js',
      format: 'umd',
      name: 'AetherfyVectors',
      sourcemap: true,
    },
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        sourceMap: true,
      }),
      resolve({
        browser: true,
        preferBuiltins: false,
      }),
      commonjs(),
      nodePolyfills(),
      isProduction && terser(),
    ].filter(Boolean),
  },
];

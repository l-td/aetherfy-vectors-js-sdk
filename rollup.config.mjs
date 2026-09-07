import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';
import nodePolyfills from 'rollup-plugin-polyfill-node';

// Check for production mode safely across environments
const isProduction = process.env.NODE_ENV === 'production';

export default [
  // Node.js builds (primary)
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/index.cjs.js',
        format: 'cjs',
        sourcemap: true,
      },
      {
        // .mjs, NOT .esm.js — see the agent entry below for the reasoning.
        // Short version: this package has no "type": "module", so Node has
        // to sniff a .js file's module type and reparse it as ESM.
        file: 'dist/index.mjs',
        format: 'es',
        sourcemap: true,
      },
    ],
    external: ['cross-fetch', 'form-data'],
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
    ].filter(Boolean),
  },

  // The agent helper, its own entry point (secondary).
  //
  // A SEPARATE ENTRY, not a re-export from index: the helper is imported by
  // code running ON a machine, which has no reason to pull the whole vector
  // client (and axios with it) into its process to read an environment
  // variable. It is also why the browser bundle below does not carry it —
  // `node:fs/promises` has no meaning there, and a task does not run in a
  // browser.
  {
    input: 'src/agent/index.ts',
    output: [
      {
        file: 'dist/agent.cjs.js',
        format: 'cjs',
        sourcemap: true,
      },
      {
        // .mjs, NOT .esm.js. This package has no "type": "module", so a .js
        // file has no declared module type: Node tries to parse it as
        // CommonJS, fails, and reparses it as ESM — which it calls out as a
        // performance overhead — and prints MODULE_TYPELESS_PACKAGE_JSON.
        //
        // MEASURED, node 22.20.0, the same bytes in two places: the warning
        // prints from a repo checkout and is SUPPRESSED under node_modules,
        // which is where a normal `npm install` puts us. So this is not the
        // customer-facing log noise it first looked like; it is the correct
        // extension, one less reparse on every import, and a clean console
        // for anyone consuming the package outside node_modules — a linked
        // workspace, a vendored copy, a bundler's dev server.
        // dist/index.mjs above carries the same rename for the same reason.
        file: 'dist/agent.esm.mjs',
        format: 'es',
        sourcemap: true,
      },
    ],
    external: ['node:fs/promises'],
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
    ].filter(Boolean),
  },

  // Browser build (secondary)
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

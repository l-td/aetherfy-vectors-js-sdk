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
        file: 'dist/index.esm.js',
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
        // .mjs, NOT .esm.js: this package has no "type": "module", so Node
        // must reparse a .js file as ESM and prints a MODULE_TYPELESS_PACKAGE_JSON
        // warning into the importing process's stdout. On an Aetherfy machine
        // that stdout IS the run's logs, so the warning would land in every
        // customer's log output. (dist/index.esm.js has the same shape and the
        // same warning; renaming it would change a published entry point, so it
        // is left alone.)
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

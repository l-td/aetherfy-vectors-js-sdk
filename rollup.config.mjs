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
        sourcemap: true
      },
      {
        file: 'dist/index.esm.js', 
        format: 'es',
        sourcemap: true
      }
    ],
    external: ['cross-fetch', 'form-data'],
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        sourceMap: true
      }),
      resolve({
        preferBuiltins: true
      }),
      commonjs(),
      isProduction && terser()
    ].filter(Boolean)
  },
  
  // Browser build (secondary)
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/browser.js',
      format: 'umd',
      name: 'AetherfyVectors',
      sourcemap: true
    },
    plugins: [
      typescript({
        tsconfig: './tsconfig.json',
        sourceMap: true
      }),
      resolve({
        browser: true,
        preferBuiltins: false
      }),
      commonjs(),
      nodePolyfills(),
      isProduction && terser()
    ].filter(Boolean)
  }
];
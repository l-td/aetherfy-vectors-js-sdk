/**
 * The PACKAGE lane: tests of the built, packed, installed SDK.
 *
 * Separate from jest.config.js on purpose. The unit lane runs on source and
 * must not need a build; these tests need one, and run in CI after
 * `npm run build:prod`. A tarball test that ran before the build would test
 * whatever dist/ the previous build left behind.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/package'],
  testMatch: ['<rootDir>/tests/package/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tests/tsconfig.json' }],
  },
};

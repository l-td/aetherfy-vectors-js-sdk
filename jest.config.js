module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          rootDir: '.',
          types: ['jest', 'node'],
        },
      },
    ],
  },
  coverageProvider: 'v8',
  projects: [
    {
      displayName: 'node',
      // node + a teardown that always removes nock; see the file.
      testEnvironment: '<rootDir>/tests/node-environment.ts',
      testMatch: ['<rootDir>/tests/unit/**/*.test.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/tests/setup.ts',
        '<rootDir>/tests/node-setup.ts',
      ],
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          {
            tsconfig: '<rootDir>/tests/tsconfig.json',
          },
        ],
      },
    },
    {
      displayName: 'browser',
      testEnvironment: 'jsdom',
      testMatch: ['<rootDir>/tests/browser/**/*.test.ts'],
      setupFilesAfterEnv: [
        '<rootDir>/tests/setup.ts',
        '<rootDir>/tests/browser-setup.ts',
      ],
      transform: {
        '^.+\\.ts$': [
          'ts-jest',
          {
            tsconfig: '<rootDir>/tests/tsconfig.json',
          },
        ],
      },
    },
  ],
};

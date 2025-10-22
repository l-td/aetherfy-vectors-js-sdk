#!/usr/bin/env node

/**
 * Test runner script for Aetherfy Vectors JavaScript SDK
 *
 * Equivalent to Python's pytest with various options
 */

const { execSync } = require('child_process');
const fs = require('fs');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step) {
  log(`\n🧪 ${step}`, 'cyan');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function run(command, description) {
  try {
    log(`Running: ${command}`, 'blue');
    execSync(command, { stdio: 'inherit' });
    logSuccess(`${description} completed`);
    return true;
  } catch (error) {
    logError(`${description} failed: ${error.message}`);
    return false;
  }
}

function runTests(options = {}) {
  const {
    verbose = false,
    coverage = false,
    watch = false,
    testPattern = '',
    browser = false,
    parallel = false,
    bail = false,
    silent = false,
  } = options;

  let jestCommand = 'npx jest';

  if (verbose) jestCommand += ' --verbose';
  if (coverage) jestCommand += ' --coverage';
  if (watch) jestCommand += ' --watch';
  if (browser) jestCommand += ' --testEnvironment=jsdom';
  if (parallel) jestCommand += ' --maxWorkers=4';
  if (bail) jestCommand += ' --bail';
  if (silent) jestCommand += ' --silent';

  if (testPattern) {
    jestCommand += ` --testNamePattern="${testPattern}"`;
  }

  return run(jestCommand, 'Test execution');
}

function runSpecificTestSuite(suite) {
  logStep(`Running ${suite} tests`);

  const suitePatterns = {
    unit: 'tests/unit/**/*.test.ts',
    functional: 'tests/functional/**/*.test.ts',
    browser: 'tests/browser/**/*.test.ts',
    auth: 'tests/unit/auth.test.ts',
    client: 'tests/unit/client.test.ts',
    utils: 'tests/unit/utils.test.ts',
    exceptions: 'tests/unit/exceptions.test.ts',
  };

  const pattern = suitePatterns[suite];
  if (!pattern) {
    logError(`Unknown test suite: ${suite}`);
    return false;
  }

  return run(`npx jest ${pattern} --verbose`, `${suite} tests`);
}

function runLinting() {
  logStep('Running linting (equivalent to mypy)');

  // TypeScript type checking (equivalent to mypy)
  const typeCheckResult = run('npx tsc --noEmit', 'TypeScript type checking');

  // ESLint (code quality)
  const lintResult = run('npx eslint src tests --ext .ts', 'ESLint checking');

  return typeCheckResult && lintResult;
}

function runFormatting() {
  logStep('Running code formatting (equivalent to black)');
  return run(
    'npx prettier --check src/**/*.ts tests/**/*.ts',
    'Prettier format checking'
  );
}

function fixFormatting() {
  logStep('Fixing code formatting');
  return run(
    'npx prettier --write src/**/*.ts tests/**/*.ts',
    'Prettier format fixing'
  );
}

function runCoverageReport() {
  logStep('Generating coverage report');

  const success = run(
    'npx jest --coverage --coverageReporters=text --coverageReporters=html --coverageReporters=lcov',
    'Coverage generation'
  );

  if (success) {
    log('\n📊 Coverage report generated:', 'cyan');
    log('- HTML report: coverage/lcov-report/index.html', 'blue');
    log('- LCOV report: coverage/lcov.info', 'blue');
  }

  return success;
}

function validateTestEnvironment() {
  logStep('Validating test environment');

  // Check if test files exist
  const testDirs = ['tests/unit', 'tests/functional', 'tests/browser'];
  const missingDirs = testDirs.filter(dir => !fs.existsSync(dir));

  if (missingDirs.length > 0) {
    logError(`Missing test directories: ${missingDirs.join(', ')}`);
    return false;
  }

  // Check if jest config exists
  if (!fs.existsSync('jest.config.js')) {
    logError('jest.config.js not found');
    return false;
  }

  logSuccess('Test environment validated');
  return true;
}

function printTestSummary() {
  logStep('Test Summary');

  try {
    // Get test file counts
    const unitTests = fs
      .readdirSync('tests/unit')
      .filter(f => f.endsWith('.test.ts')).length;
    const functionalTests = fs
      .readdirSync('tests/functional')
      .filter(f => f.endsWith('.test.ts')).length;
    const browserTests = fs
      .readdirSync('tests/browser')
      .filter(f => f.endsWith('.test.ts')).length;

    log(`📁 Unit tests: ${unitTests} files`, 'blue');
    log(`📁 Functional tests: ${functionalTests} files`, 'blue');
    log(`📁 Browser tests: ${browserTests} files`, 'blue');
    log(
      `📁 Total: ${unitTests + functionalTests + browserTests} test files`,
      'cyan'
    );
  } catch (error) {
    logError(`Could not generate test summary: ${error.message}`);
  }
}

function main() {
  const startTime = Date.now();
  const args = process.argv.slice(2);

  // Parse command line arguments
  const options = {
    verbose: args.includes('-v') || args.includes('--verbose'),
    coverage: args.includes('--coverage') || args.includes('--cov'),
    watch: args.includes('--watch'),
    browser: args.includes('--browser'),
    parallel: args.includes('--parallel'),
    bail: args.includes('--bail'),
    silent: args.includes('--silent'),
    lint: args.includes('--lint'),
    format: args.includes('--format'),
    fixFormat: args.includes('--fix-format'),
    help: args.includes('--help') || args.includes('-h'),
  };

  if (options.help) {
    log(
      `
🧪 Aetherfy Vectors SDK Test Runner

Usage: node scripts/test.js [options] [test-pattern]

Options:
  -v, --verbose          Verbose output (equivalent to pytest -v)
  --coverage, --cov      Generate coverage report 
  --watch               Watch mode for development
  --browser             Run browser-specific tests
  --parallel            Run tests in parallel
  --bail                Stop on first failure
  --silent              Minimal output
  --lint                Run type checking and linting (equivalent to mypy + pylint)
  --format              Check code formatting (equivalent to black --check)
  --fix-format          Fix code formatting (equivalent to black)

Test Suites:
  unit                  Run only unit tests
  functional            Run only functional tests (mocked workflows)
  browser               Run only browser tests
  auth                  Run only authentication tests
  client                Run only client tests
  utils                 Run only utility tests
  exceptions            Run only exception tests

Examples:
  node scripts/test.js -v                    # Verbose tests (like pytest -v)
  node scripts/test.js --coverage            # With coverage
  node scripts/test.js --lint                # Type check + lint (like mypy)
  node scripts/test.js --format              # Format check (like black --check)
  node scripts/test.js unit                  # Only unit tests
  node scripts/test.js auth --verbose        # Auth tests with verbose output
  node scripts/test.js --watch               # Watch mode

Python Equivalents:
  pytest tests/ -v              →  node scripts/test.js -v
  python -m mypy src/            →  node scripts/test.js --lint  
  black src/                     →  node scripts/test.js --fix-format
  black --check src/             →  node scripts/test.js --format
  pytest --cov=src tests/        →  node scripts/test.js --coverage
    `,
      'cyan'
    );
    process.exit(0);
  }

  log('🎯 Aetherfy Vectors SDK Test Runner', 'cyan');

  if (!validateTestEnvironment()) {
    process.exit(1);
  }

  let success = true;

  try {
    // Handle specific test suites
    const testSuite = args.find(arg =>
      [
        'unit',
        'functional',
        'browser',
        'auth',
        'client',
        'utils',
        'exceptions',
      ].includes(arg)
    );

    if (testSuite) {
      success = runSpecificTestSuite(testSuite);
    } else {
      // Handle special operations
      if (options.lint) {
        success = runLinting();
      } else if (options.format) {
        success = runFormatting();
      } else if (options.fixFormat) {
        success = fixFormatting();
      } else if (options.coverage) {
        success = runCoverageReport();
      } else {
        // Run all tests with options
        success = runTests(options);
      }
    }

    if (success) {
      printTestSummary();
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      log(
        `\n🎉 All operations completed successfully in ${duration}s`,
        'green'
      );
    } else {
      process.exit(1);
    }
  } catch (error) {
    logError(`Test execution failed: ${error.message}`);
    process.exit(1);
  }
}

main();

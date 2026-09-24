#!/usr/bin/env node

/**
 * Build script for Aetherfy Vectors JavaScript SDK
 *
 * This script handles the complete build process:
 * - Clean previous build
 * - Run TypeScript compilation
 * - Bundle with Rollup
 * - Generate documentation
 * - Validate build output
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ANSI color codes for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logStep(step) {
  log(`\n🚀 ${step}`, 'cyan');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function run(command, description) {
  try {
    log(`Running: ${command}`, 'blue');
    execSync(command, { stdio: 'inherit' });
    logSuccess(`${description} completed`);
  } catch (error) {
    logError(`${description} failed: ${error.message}`);
    process.exit(1);
  }
}

function checkPrerequisites() {
  logStep('Checking prerequisites');

  // Check if package.json exists
  if (!fs.existsSync('package.json')) {
    logError('package.json not found');
    process.exit(1);
  }

  // Check if src directory exists
  if (!fs.existsSync('src')) {
    logError('src directory not found');
    process.exit(1);
  }

  // Check if node_modules exists
  if (!fs.existsSync('node_modules')) {
    logWarning('node_modules not found, running npm install');
    run('npm install', 'Dependencies installation');
  }

  logSuccess('Prerequisites checked');
}

function cleanBuild() {
  logStep('Cleaning previous build');

  if (fs.existsSync('dist')) {
    fs.rmSync('dist', { recursive: true, force: true });
    logSuccess('Cleaned dist directory');
  }

  if (fs.existsSync('coverage')) {
    fs.rmSync('coverage', { recursive: true, force: true });
    logSuccess('Cleaned coverage directory');
  }
}

function typeCheck() {
  logStep('Running TypeScript type checking');
  run('npx tsc --noEmit', 'Type checking');
}

function lint() {
  logStep('Running ESLint');
  run('npx eslint src --ext .ts', 'Linting');
}

function format() {
  logStep('Checking code formatting');
  run('npx prettier --check src/**/*.ts', 'Format checking');
}

function buildBundle() {
  logStep('Building bundle with Rollup');
  run('npx rollup -c rollup.config.mjs', 'Bundle creation');
}

/**
 * Every file package.json promises a consumer: main, module, types, browser,
 * every target under "exports" at any depth of nesting, and every
 * typesVersions target. READ FROM package.json, never listed here — a subpath
 * added there extends this check by itself, and there is no second list to
 * forget. (There were three: this one, scripts/build-fast.js's, and CI's
 * `test -f` step. Each had already drifted from the others.)
 */
function promisedFiles() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const files = new Set();
  const collect = target => {
    if (typeof target === 'string') files.add(target.replace(/^\.\//, ''));
    else if (target && typeof target === 'object') {
      Object.values(target).forEach(collect);
    }
  };
  ['main', 'module', 'types', 'browser'].forEach(field => collect(pkg[field]));
  collect(pkg.exports);
  collect(pkg.typesVersions);
  return [...files].sort();
}

function validateBuild() {
  logStep('Validating build output');

  // A promised file that resolves to nothing is invisible until someone
  // imports it, and by then the package is published.
  const requiredFiles = promisedFiles();
  if (requiredFiles.length === 0) {
    logError('package.json promises no files; refusing to call that valid');
    process.exit(1);
  }

  const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));

  if (missingFiles.length > 0) {
    logError(`Missing build files: ${missingFiles.join(', ')}`);
    process.exit(1);
  }

  logSuccess(`Build validation completed (${requiredFiles.length} promised files)`);
}

function generateDocs() {
  logStep('Generating documentation');

  try {
    run(
      'npx typedoc src/index.ts --out docs/api',
      'API documentation generation'
    );
  } catch (error) {
    logWarning(
      `Documentation generation failed - continuing without docs: ${error.message}`
    );
  }
}

function printBuildSummary() {
  logStep('Build Summary');

  const distFiles = fs
    .readdirSync('dist')
    .filter(file => file.endsWith('.js') || file.endsWith('.d.ts'));

  distFiles.forEach(file => {
    const filePath = path.join('dist', file);
    const stats = fs.statSync(filePath);
    const sizeKB = (stats.size / 1024).toFixed(2);
    log(`📦 ${file}: ${sizeKB} KB`, 'blue');
  });

  logSuccess('Build completed successfully!');
}

function main() {
  const startTime = Date.now();

  log('🎯 Starting Aetherfy Vectors SDK Build', 'magenta');

  try {
    checkPrerequisites();
    cleanBuild();
    typeCheck();
    if (skipLint) {
      logWarning('Skipping linting');
    } else {
      lint();
    }
    if (skipFormat) {
      logWarning('Skipping format checking');
    } else {
      format();
    }
    buildBundle();
    validateBuild();
    if (skipDocs) {
      logWarning('Skipping documentation generation');
    } else {
      generateDocs();
    }
    printBuildSummary();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`\n🎉 Build completed in ${duration}s`, 'green');
  } catch (error) {
    logError(`Build failed: ${error.message}`);
    process.exit(1);
  }
}

// Handle command line arguments
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  log(
    `
Aetherfy Vectors SDK Build Script

Usage: node scripts/build.js [options]

Options:
  --help, -h     Show this help message
  --skip-lint    Skip linting
  --skip-format  Skip format checking
  --skip-docs    Skip documentation generation
  --production   Production build (with optimizations)

Examples:
  node scripts/build.js
  node scripts/build.js --production
  node scripts/build.js --skip-lint --skip-format
  `,
    'cyan'
  );
  process.exit(0);
}

// Skip flags based on arguments
const skipLint = args.includes('--skip-lint');
const skipFormat = args.includes('--skip-format');
const skipDocs = args.includes('--skip-docs');

if (args.includes('--production')) {
  process.env.NODE_ENV = 'production';
  log('🏭 Production build mode enabled', 'yellow');
}

// Run the build
main();

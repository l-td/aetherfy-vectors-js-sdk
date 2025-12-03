#!/usr/bin/env node

/**
 * Fast build script - Only bundles the SDK without linting, formatting, or docs
 * Use this for quick builds during development or when you just need the dist files
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
  log(`\n🚀 ${step}`, 'cyan');
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
  } catch (error) {
    logError(`${description} failed: ${error.message}`);
    process.exit(1);
  }
}

function cleanBuild() {
  logStep('Cleaning previous build');
  if (fs.existsSync('dist')) {
    fs.rmSync('dist', { recursive: true, force: true });
    logSuccess('Cleaned dist directory');
  }
}

function typeCheck() {
  logStep('Running TypeScript type checking');
  run('npx tsc --noEmit', 'Type checking');
}

function buildBundle() {
  logStep('Building bundle with Rollup');
  run('npx rollup -c rollup.config.mjs', 'Bundle creation');
}

function validateBuild() {
  logStep('Validating build output');

  const requiredFiles = [
    'dist/index.cjs.js',
    'dist/index.esm.js',
    'dist/browser.js',
    'dist/index.d.ts',
  ];

  const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));

  if (missingFiles.length > 0) {
    logError(`Missing build files: ${missingFiles.join(', ')}`);
    process.exit(1);
  }

  logSuccess('Build validation completed');
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

  log('⚡ Fast Build - SDK Only (no linting/formatting/docs)', 'cyan');

  // Handle command line arguments
  const args = process.argv.slice(2);

  if (args.includes('--production')) {
    process.env.NODE_ENV = 'production';
    log('🏭 Production mode enabled', 'yellow');
  }

  const skipTypeCheck = args.includes('--skip-types');

  try {
    cleanBuild();
    if (!skipTypeCheck) {
      typeCheck();
    } else {
      log('⚠️  Skipping type checking', 'yellow');
    }
    buildBundle();
    validateBuild();
    printBuildSummary();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    log(`\n🎉 Fast build completed in ${duration}s`, 'green');
  } catch (error) {
    logError(`Build failed: ${error.message}`);
    process.exit(1);
  }
}

main();

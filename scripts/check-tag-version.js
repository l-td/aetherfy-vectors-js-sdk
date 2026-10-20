#!/usr/bin/env node
/**
 * Refuse a release whose git tag is not the package's version.
 *
 * Run by .github/workflows/release.yml right after the checkout, before
 * anything is built, packed or published:
 *
 *   node scripts/check-tag-version.js "$TAG"
 *
 * The tag must be `v` + package.json's version (src/version.ts holds the same
 * literal; tests/unit/agent/packaging.test.ts pins it). Exit 0 when they
 * match, 1 when they do not, with both values printed.
 */
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
);
const tag = process.argv[2];

if (!tag) {
  console.error('usage: check-tag-version.js <tag>');
  process.exit(1);
}
if (tag !== `v${pkg.version}`) {
  console.error(
    `The tag '${tag}' is not this package's version '${pkg.version}' ` +
      `(expected 'v${pkg.version}'). Nothing is published.`
  );
  process.exit(1);
}
console.log(`tag ${tag} matches version ${pkg.version}`);

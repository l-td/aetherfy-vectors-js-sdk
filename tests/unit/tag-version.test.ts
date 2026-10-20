/**
 * The release refuses a tag that is not the package version. Runs
 * scripts/check-tag-version.js the way .github/workflows/release.yml does,
 * and holds the workflow to running it before anything is packed or
 * published.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-tag-version.js');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

function exitCode(tag: string): number {
  try {
    execFileSync(process.execPath, [SCRIPT, tag], { stdio: 'pipe' });
    return 0;
  } catch (error: unknown) {
    return (error as { status: number }).status;
  }
}

it('the matching tag passes', () => {
  expect(exitCode(`v${pkg.version}`)).toBe(0);
});

it.each(['v9.9.9', pkg.version, '', 'v1.2'])(
  'CONTROL: a mismatched tag (%j) fails',
  tag => {
    expect(exitCode(tag)).toBe(1);
  }
);

it('the workflow checks the tag before packing or publishing', () => {
  const workflow = readFileSync(
    join(ROOT, '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  const check = workflow.indexOf('node scripts/check-tag-version.js "$TAG"');
  expect(check).toBeGreaterThan(-1);
  expect(check).toBeLessThan(workflow.indexOf('npm run deploy-check'));
  expect(check).toBeLessThan(workflow.indexOf('npm pack'));
  expect(check).toBeLessThan(workflow.indexOf('npm publish'));
});

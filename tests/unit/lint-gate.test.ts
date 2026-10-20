/**
 * CI fails on an ESLint warning. `npm run lint` (what ci.yml runs) goes
 * through scripts/test.js, so the flag is held there.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

it('the lint step runs eslint with --max-warnings 0', () => {
  const script = readFileSync(join(ROOT, 'scripts', 'test.js'), 'utf8');
  expect(script).toMatch(
    /npx eslint src tests --ext \.ts --max-warnings 0['"`]/
  );
});

it('ci.yml runs that lint step', () => {
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  expect(ci).toMatch(/run: npm run lint\b/);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  expect(pkg.scripts.lint).toBe('node scripts/test.js --lint');
});

/**
 * The release builds on a Node the CI matrix runs. .github/workflows/release.yml
 * runs the whole deploy check, packs and publishes on one Node. If that Node is
 * not in .github/workflows/ci.yml's matrix, the release runs on a version
 * nothing tests, or one past its end of life once the matrix moves on.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const WORKFLOWS = join(__dirname, '..', '..', '.github', 'workflows');

function releaseNode(text: string): string {
  const found = [
    ...text.matchAll(/^\s*node-version:\s*['"]?([0-9.x]+)['"]?\s*$/gm),
  ].map(m => m[1]);
  expect(found).toHaveLength(1);
  return found[0];
}

function testedNodes(text: string): string[] {
  const found = [...text.matchAll(/^\s*node-version:\s*\[([^\]]*)\]/gm)].map(
    m => m[1]
  );
  expect(found).toHaveLength(1);
  return found[0]
    .split(',')
    .map(v => v.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

it('the release Node is in the CI matrix', () => {
  const release = releaseNode(
    readFileSync(join(WORKFLOWS, 'release.yml'), 'utf8')
  );
  const tested = testedNodes(readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8'));
  expect(tested).toContain(release);
});

it('a release Node outside the matrix is caught', () => {
  expect(testedNodes('node-version: [22.x, 24.x]\n')).not.toContain(
    releaseNode("node-version: '20.x'\n")
  );
});

/**
 * The package's promises about the agent helper, checked against package.json.
 *
 * These are the failures nothing else catches until a customer hits them:
 * a subpath export pointing at a file the build does not emit, a User-Agent
 * naming a release that never shipped, and a runtime dependency slipped in by
 * a helper that is required to add none.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

import { AGENT_HELPER_VERSION } from '../../../src/agent';
import { HttpClient } from '../../../src/http/client';
import { VERSION } from '../../../src/index';
import { SDK_VERSION } from '../../../src/version';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const pkg = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
) as {
  version: string;
  dependencies: Record<string, string>;
  exports: Record<string, Record<string, string>>;
  files: string[];
};

/** Every .ts file under `dir`, excluding declarations. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('packaging', () => {
  it('stamps the User-Agent with the version being published', () => {
    // A helper that announced 1.0.0 from a 1.1.0 package would make a
    // platform-side log useless for exactly the question it gets asked: which
    // helper is this run using.
    expect(AGENT_HELPER_VERSION).toBe(pkg.version);
  });

  it('keeps the package version and the exported VERSION in step', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('has ONE version literal, and every consumer reads it', () => {
    // There were three: VERSION, the HTTP client's User-Agent, and the agent
    // helper's. The middle one had already drifted — it announced 1.0.0 from a
    // 1.1.0 package — and a drifted version string is only ever discovered by
    // whoever is trying to reproduce a bug report from a User-Agent naming the
    // wrong release. src/version.ts is now the only literal.
    expect(SDK_VERSION).toBe(pkg.version);
    expect(VERSION).toBe(SDK_VERSION);
    expect(AGENT_HELPER_VERSION).toBe(SDK_VERSION);

    // The vector client's User-Agent, read off a real instance rather than off
    // the source: the assertion is about the header that actually goes out.
    const headers = (
      new HttpClient() as unknown as { defaultHeaders: Record<string, string> }
    ).defaultHeaders;
    expect(headers['User-Agent']).toBe(`Aetherfy-Vectors-JS/${pkg.version}`);
  });

  it('leaves no second version literal in the source', () => {
    // The pin above only proves the values AGREE today. This proves there is
    // nothing left to disagree: a re-introduced literal is caught where someone
    // types it, not at the release where it drifts.
    const offenders = sourceFiles(join(REPO_ROOT, 'src'))
      .filter(file => !file.endsWith(`${sep}version.ts`))
      .filter(file => {
        const text = readFileSync(file, 'utf8');
        return (
          text.includes(`'${pkg.version}'`) || text.includes(`"${pkg.version}"`)
        );
      })
      .map(file => file.slice(REPO_ROOT.length + 1));

    expect(offenders).toEqual([]);
  });

  it('exports the ./agent subpath with all three entries', () => {
    expect(pkg.exports['./agent']).toEqual({
      types: './dist/agent/index.d.ts',
      import: './dist/agent.esm.mjs',
      require: './dist/agent.cjs.js',
    });
  });

  it('ships dist, so the subpath resolves in the published tarball', () => {
    // `files` decides what npm packs. dist/**/* covers dist/agent.*.js and
    // dist/agent/index.d.ts alike.
    expect(pkg.files).toContain('dist/**/*');
  });

  it('adds no runtime dependency', () => {
    // The helper's transport is the runtime's own fetch and node:fs/promises.
    // If this list ever grows because of src/agent, the helper stopped being
    // free to install in a container that pinned its own tree.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      'axios',
      'cross-fetch',
      'form-data',
    ]);
  });
});

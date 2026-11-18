/**
 * THE PUBLISHED SOURCE NAMES NO PROVIDER.
 *
 * The package ships src/** with its comments, so what a comment says about the platform's infrastructure is read by
 * customers. Customer-facing text never names the vendors behind the platform: it says "the service's edge", "the
 * backend". This reads every source file the package ships and fails on a vendor's name, with a control that proves the
 * scan can see one.
 */
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '../../src');
// The compute and edge vendors, spelled the ways they appear in comments, URLs and hostnames.
const VENDOR_NAMES =
  /cloudflare|fly\.io|flyctl|\bfly machines?\b|machines\.dev|cfargotunnel/i;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|js|json)$/.test(entry.name) ? [full] : [];
  });
}

function offences(text: string): string[] {
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => VENDOR_NAMES.test(line))
    .map(({ number }) => `line ${number}`);
}

describe('the package source', () => {
  const files = sourceFiles(SRC);

  it('is found (a scan that finds nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('names no provider', () => {
    const found = files.flatMap(file =>
      offences(fs.readFileSync(file, 'utf8')).map(
        where => `${path.relative(SRC, file)}: ${where}`
      )
    );
    expect(found).toEqual([]);
  });

  // CONTROL: the scan sees a vendor's name when one is there.
  it('control: a comment naming the edge vendor is found', () => {
    expect(
      offences('// a body cap at the Cloudflare edge\nconst a = 1;')
    ).toEqual(['line 1']);
    expect(offences('// the backend\n// see fly.io docs')).toEqual(['line 2']);
    expect(offences("// the service's edge, the backend")).toEqual([]);
  });
});

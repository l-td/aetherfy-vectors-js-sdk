/**
 * The installed package, for the PACKAGE lane: pack (or take) a tarball,
 * install it into a scratch project, and run probes there with Node's own
 * resolution, through the installed package.json.
 *
 * WHICH TARBALL. With AETHERFY_PACKAGE_TARBALL set, THAT file — the release
 * packs once, tests the tarball, and publishes the same file, so the bytes a
 * customer installs are the bytes tested. Unset, it packs dist/ itself (local
 * runs, and the CI matrix). Either way it prints the tarball's sha1, which is
 * the `shasum` npm reports for a publish of it.
 *
 * npm is run through the shell (`execSync`) because on Windows it is a .cmd
 * shim, which Node refuses to spawn without one. Paths are quoted: they can
 * contain spaces.
 */

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const REPO_ROOT = join(__dirname, '..', '..');

/** A conditional exports target: a path, or conditions nesting more targets. */
export type ExportTarget = string | { [condition: string]: ExportTarget };

export interface Manifest {
  name: string;
  exports: Record<string, Record<string, ExportTarget>>;
}

export const MANIFEST: Manifest = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
);

export interface InstalledPackage {
  /** The scratch project the tarball is installed into. */
  scratch: string;
  /** The regular files in the tarball, read from the archive itself. */
  packedFiles: string[];
  /** Remove everything this created. */
  cleanup: () => void;
}

/**
 * The regular files in a .tgz, from the archive itself: gunzip, then walk the
 * 512-byte tar headers. npm prefixes every entry with `package/`, stripped
 * here. PAX / GNU long-name records (type x, g, L) are skipped, not read.
 */
function tarballFiles(tarball: string): string[] {
  const tar = gunzipSync(readFileSync(tarball));
  const field = (block: Buffer, start: number, length: number): string =>
    block
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/s, '');
  const files: string[] = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = field(header, 156, 1);
    const prefix = field(header, 345, 155);
    const name = prefix
      ? `${prefix}/${field(header, 0, 100)}`
      : field(header, 0, 100);
    if (type === '0' || type === '') files.push(name.replace(/^package\//, ''));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Get the tarball (given, or packed here) and install it once. */
export function installPackage(): InstalledPackage {
  const workDir = mkdtempSync(join(tmpdir(), 'afy-package-'));
  const given = process.env.AETHERFY_PACKAGE_TARBALL;
  let tarball: string;
  if (given) {
    tarball = isAbsolute(given) ? given : resolve(REPO_ROOT, given);
  } else {
    const packed = JSON.parse(
      execSync(`npm pack --json --pack-destination "${workDir}"`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ) as { filename: string }[];
    tarball = join(workDir, packed[0].filename);
  }
  const packedFiles = tarballFiles(tarball);
  const shasum = createHash('sha1').update(readFileSync(tarball)).digest('hex');
  // eslint-disable-next-line no-console
  console.log(`package test: ${tarball}\nshasum: ${shasum}`);

  const scratch = join(workDir, 'scratch');
  mkdirSync(scratch);
  writeFileSync(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'afy-scratch', version: '0.0.0', private: true })
  );
  execSync(`npm install "${tarball}" --no-audit --no-fund --no-package-lock`, {
    cwd: scratch,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    scratch,
    packedFiles,
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  };
}

/** Write `source` into the scratch project, run it with node, parse its JSON. */
export function probe<T>(scratch: string, file: string, source: string): T {
  writeFileSync(join(scratch, file), source);
  const out = execFileSync(process.execPath, [file], {
    cwd: scratch,
    encoding: 'utf8',
  });
  return JSON.parse(out) as T;
}

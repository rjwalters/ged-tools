#!/usr/bin/env node
// Release manifest: the bridge between the private content audit and CI publishing.
//
// The private-indicator audit runs on the operator's machine against a
// consumer's genealogy data, which must never reach this public repository or
// its CI. So the audited package is pinned by content instead: after the
// audit passes, `write` records the SHA-256 of every file in the packed
// tarball, and the manifest (hashes only — nothing private) is committed.
// The release workflow packs from the tagged commit and runs `verify`; it
// publishes only if every file matches. CI can therefore publish exactly the
// contents that were audited, and nothing else.
//
//   node scripts/release-manifest.js write  <package.tgz>   → release-manifests/<version>.json
//   node scripts/release-manifest.js verify <package.tgz> [<manifest.json>]
//
// Hashes are per file, not of the tarball: gzip and tar headers differ
// between npm versions, the file contents do not.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).replaceAll('\\', '/')] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

export function readTarball(tgz) {
  const dir = mkdtempSync(join(tmpdir(), 'release-manifest-'));
  try {
    execFileSync('tar', ['-xzf', resolve(tgz), '-C', dir]);
    const pkgDir = join(dir, 'package');
    const files = hashTree(pkgDir);
    const { name, version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    return { name, version, files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every difference between a manifest and a packed tarball; empty means identical. */
export function compare(manifest, packed) {
  const problems = [];
  if (manifest.name !== packed.name) problems.push(`name: manifest ${manifest.name}, package ${packed.name}`);
  if (manifest.version !== packed.version) problems.push(`version: manifest ${manifest.version}, package ${packed.version}`);
  for (const [f, h] of Object.entries(manifest.files)) {
    if (!(f in packed.files)) problems.push(`missing from package: ${f}`);
    else if (packed.files[f] !== h) problems.push(`content differs: ${f}`);
  }
  for (const f of Object.keys(packed.files)) if (!(f in manifest.files)) problems.push(`not in manifest: ${f}`);
  return problems;
}

function main([verb, tgz, manifestPath]) {
  if (!['write', 'verify'].includes(verb) || !tgz) {
    console.error('usage: release-manifest.js write <package.tgz> | verify <package.tgz> [<manifest.json>]');
    return 1;
  }
  const packed = readTarball(tgz);
  const path = manifestPath ?? join(root, 'release-manifests', `${packed.version}.json`);
  if (verb === 'write') {
    mkdirSync(join(root, 'release-manifests'), { recursive: true });
    writeFileSync(path, JSON.stringify({ name: packed.name, version: packed.version, files: packed.files }, null, 2) + '\n');
    console.log(`wrote ${relative(root, path)}: ${Object.keys(packed.files).length} files`);
    return 0;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`no audited manifest for ${packed.version} (${relative(root, path)}): ${err.message}`);
    return 1;
  }
  const problems = compare(manifest, packed);
  if (problems.length) {
    console.error(`REFUSED: the package does not match the audited manifest\n  ${problems.join('\n  ')}`);
    return 1;
  }
  console.log(`verified: ${packed.name}@${packed.version}, ${Object.keys(packed.files).length} files match the audited manifest`);
  return 0;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

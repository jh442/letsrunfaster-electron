#!/usr/bin/env node
/**
 * Download the pinned engine release for the current platform.
 *
 * The engine is a PyInstaller binary published by the letsrunfaster-ingestor
 * repo. This script pins the version in engine.json, verifies the artifact
 * against that release's SHA256SUMS.txt, and places it in resources/bin so
 * electron-builder can ship it as an extra resource.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'engine.json'), 'utf8'));

const platformKey = `${process.platform}-${process.arch}`;
const asset = spec.assets[platformKey];
const releaseBase = `https://github.com/${spec.repo}/releases/download/v${spec.version}`;
const outputName = process.platform === 'win32' ? 'lrf-ingestor.exe' : 'lrf-ingestor';
const outputFile = path.join(root, 'resources', 'bin', outputName);

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${url}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  if (!asset) {
    throw new Error(
      `No engine build is published for ${platformKey}. Known: ${Object.keys(spec.assets).join(', ')}`,
    );
  }

  process.stdout.write(`Downloading engine v${spec.version} (${platformKey})…\n`);
  const sums = (await download(`${releaseBase}/SHA256SUMS.txt`)).toString('utf8');
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];

  if (!expected) {
    throw new Error(`${asset} is not listed in ${releaseBase}/SHA256SUMS.txt`);
  }

  const binary = await download(`${releaseBase}/${asset}`);
  const actual = crypto.createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${asset}\n  expected ${expected}\n  actual   ${actual}`);
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, binary);
  fs.chmodSync(outputFile, 0o755);
  process.stdout.write(`engine v${spec.version} -> ${path.relative(root, outputFile)} (sha256 verified)\n`);
}

main().catch((err) => {
  process.stderr.write(`fetch-engine failed: ${err.message}\n`);
  process.exit(1);
});

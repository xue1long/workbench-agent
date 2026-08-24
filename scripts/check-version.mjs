#!/usr/bin/env node
// scripts/check-version.mjs — verify the version in package.json appears in
// CHANGELOG.md under the "[Unreleased]" or a [X.Y.Z] heading. Catches stale
// docs after a manual version bump that forgot the CHANGELOG entry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

const pkg = readJson(path.join(ROOT, 'package.json'));
const version = pkg.version;
if (!version || typeof version !== 'string') {
  process.stderr.write(`check-version: package.json has no version\n`);
  process.exit(1);
}
const changelog = readText(path.join(ROOT, 'CHANGELOG.md'));
const headings = Array.from(changelog.matchAll(/^##\s*\[([^\]]+)\]/gm)).map((m) => m[1]);
const semverish = new RegExp(`\\b${version.replace(/\./g, '\\.')}\\b`);
const foundInReleased = headings.some((h) => h === version);
const foundInUnreleased = headings.includes('Unreleased');
const versionReferenced = semverish.test(changelog);

if (!foundInUnreleased && !foundInReleased) {
  process.stderr.write(`check-version: version ${version} has no [Unreleased] or [${version}] heading in CHANGELOG.md\n`);
  process.exit(1);
}
if (!versionReferenced) {
  process.stderr.write(`check-version: version ${version} is not mentioned in CHANGELOG.md\n`);
  process.exit(1);
}
process.stdout.write(`check-version: ${version} found in CHANGELOG.md\n`);

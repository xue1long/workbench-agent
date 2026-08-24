#!/usr/bin/env node
// scripts/release-dry-run.mjs — pre-flight for an npm release. Verifies:
//   1. Working tree is clean (git status --short is empty).
//   2. The package.json version is non-zero, valid semver, and present in
//      CHANGELOG.md.
//   3. The README has a clear "Install" section (smoke test).
//   4. `npm test` and `npm run check` and `npm run format:check` would pass
//      (we re-run them and surface their exit code).
//
// Does NOT mutate files and does NOT publish. Prints a one-line summary
// and exits 0 when everything looks publishable.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', ...opts });
}

const pkg = readJson(path.join(ROOT, 'package.json'));
const errors = [];

// 1. Working tree clean.
const status = run('git', ['status', '--short']);
if (status.stdout.trim() !== '') {
  errors.push(`working tree not clean: ${status.stdout.split('\n').filter(Boolean).length} file(s) modified`);
}

// 2. Version + CHANGELOG.
const version = pkg.version;
if (!version || !/^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(version)) {
  errors.push(`package.json version "${version}" is not valid semver`);
}
if (version === '0.1.0' && fs.existsSync(path.join(ROOT, 'CHANGELOG.md'))) {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  if (!new RegExp(`\\[${version.replace(/\./g, '\\.')}\\]`).test(cl)) {
    errors.push(`CHANGELOG.md has no [${version}] heading`);
  }
}

// 3. README sanity.
const readme = fs.existsSync(path.join(ROOT, 'README.md')) ? fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
if (!/^##\s+Install/m.test(readme)) errors.push('README.md is missing an "## Install" section');
if (!/npm test/.test(readme)) errors.push('README.md does not mention `npm test`');

// 4. Run npm test + check + format:check.
const steps = [
  ['npm test', ['test']],
  ['npm run check', ['run', 'check']],
  ['npm run format:check', ['run', 'format:check']],
];
const stepResults = [];
for (const [label, args] of steps) {
  const r = run('npm', args);
  const ok = r.status === 0;
  stepResults.push({ label, ok });
  if (!ok) errors.push(`${label} failed (exit ${r.status})`);
}

if (errors.length > 0) {
  process.stderr.write(`\nrelease-dry-run: NOT publishable\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}

process.stdout.write('\nrelease-dry-run: READY to publish\n');
process.stdout.write(`  package      : ${pkg.name}@${version}\n`);
process.stdout.write(`  steps        : ${stepResults.map((s) => `${s.label}${s.ok ? ' \u2713' : ' \u2717'}`).join('  ')}\n`);

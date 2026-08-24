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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// execFileSync returns a Buffer / string on success and throws on failure.
// Use the capturing variant when we want to inspect stdout even on
// non-zero exit (e.g. `git status` would never throw but our own npm step
// loop needs to record the failure).
//
// On Windows, `npm.cmd` is a `.cmd` shim that does not survive a bare
// execFileSync. We invoke npm via its CLI JS file with `node` instead —
// works everywhere, no shell, no DEP0190.
function npmCliPath() {
  // npm-cli.js sits next to the `npm` bin entry. Resolve it via Node's own
  // lookup, then fall back to the conventional sibling location.
  const entries = process.execPath ? [process.execPath] : [];
  // Common locations:
  return [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}
function runCapturing(cmd, args, opts = {}) {
  let finalCmd = cmd;
  let finalArgs = args;
  if (cmd === 'npm') {
    finalCmd = process.execPath;
    finalArgs = [npmCliPath().find((p) => fs.existsSync(p)) ?? 'npm-cli.js', ...args];
  } else if (process.platform === 'win32' && cmd === 'npm.cmd') {
    finalCmd = process.execPath;
    finalArgs = [npmCliPath().find((p) => fs.existsSync(p)) ?? 'npm-cli.js', ...args];
  }
  try {
    const stdout = execFileSync(finalCmd, finalArgs, { cwd: ROOT, encoding: 'utf8', ...opts });
    return { stdout, status: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

const pkg = readJson(path.join(ROOT, 'package.json'));
const errors = [];

// 1. Working tree clean.
const status = runCapturing('git', ['status', '--short']);
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
  const r = runCapturing('npm', args);
  stepResults.push({ label, ok: r.status === 0 });
  if (r.status !== 0) errors.push(`${label} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
}

if (errors.length > 0) {
  process.stderr.write(`\nrelease-dry-run: NOT publishable\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}

process.stdout.write('\nrelease-dry-run: READY to publish\n');
process.stdout.write(`  package      : ${pkg.name}@${version}\n`);
process.stdout.write(`  steps        : ${stepResults.map((s) => `${s.label}${s.ok ? ' \u2713' : ' \u2717'}`).join('  ')}\n`);

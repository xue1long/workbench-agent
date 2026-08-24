#!/usr/bin/env node
// scripts/check-syntax.mjs — fail the run if any *.mjs / *.js under
// core/, adapters/, apps/, src/, tests/, scripts/ has a syntax error.
// Uses Node's built-in --check mode; no third-party dependency.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = ['core', 'adapters', 'apps', 'src', 'tests', 'scripts'];

function collect(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(full, out);
    } else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name) && !entry.name.endsWith('.min.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = TARGETS.flatMap((t) => collect(path.join(ROOT, t)));
let failed = 0;

for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed += 1;
    process.stderr.write(`syntax error in ${path.relative(ROOT, file)}\n${r.stderr}\n`);
  }
}

if (failed > 0) {
  process.stderr.write(`check-syntax: ${failed} file(s) failed\n`);
  process.exit(1);
}
process.stdout.write(`check-syntax: ${files.length} file(s) ok\n`);

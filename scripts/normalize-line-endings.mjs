#!/usr/bin/env node
// scripts/normalize-line-endings.mjs — fix CRLF + trailing whitespace + final newline
// for every tracked text file. Run once after enabling .gitattributes to
// avoid creating commits that look like massive churn.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
if (r.status !== 0) {
  process.stderr.write(`git ls-files failed: ${r.stderr}`);
  process.exit(1);
}
const files = r.stdout.trim().split('\n').filter(Boolean);

let changed = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    continue; // binary or unreadable
  }
  if (raw.length === 0) continue;

  let normalized = raw.replace(/\r\n/g, '\n');
  normalized = normalized.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');
  if (!normalized.endsWith('\n')) normalized += '\n';
  normalized = normalized.replace(/\n{2,}$/, '\n');

  if (normalized !== raw) {
    fs.writeFileSync(abs, normalized, 'utf8');
    changed += 1;
    process.stdout.write(`normalized ${rel}\n`);
  }
}
process.stdout.write(`\nnormalize-line-endings: ${changed} file(s) changed\n`);

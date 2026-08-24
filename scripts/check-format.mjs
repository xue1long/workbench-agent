#!/usr/bin/env node
// scripts/check-format.mjs — verify that every tracked source file matches
// the .editorconfig rules (indent 2 spaces, LF line endings, trailing
// newline, final newline only). Does NOT mutate files — fails fast and
// prints a clear diagnostic so the author can fix it.
//
// Zero npm dependencies; intentionally narrow. Reformatting is a separate
// step (run in your editor or by hand). The whole point of this gate is
// to catch the boring regressions — mixed tabs/spaces, CRLF, missing
// final newline — before they leak into CI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = ['core', 'adapters', 'apps', 'src', 'tests', 'scripts', 'src/workbench.mjs'];
const INDENT = 2;

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
    } else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function topLevel(dir) {
  return [path.join(ROOT, dir)].flat();
}

const files = TARGETS.flatMap((t) => (t.endsWith('.mjs') ? [path.join(ROOT, t)] : collect(path.join(ROOT, t))));

let failed = 0;
const problems = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const raw = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(raw, 'utf8');
  // LF only (no CRLF).
  if (raw.includes('\r\n')) {
    failed += 1;
    problems.push(`${rel}: contains CRLF line endings`);
  }
  // Trailing whitespace on lines (common bash / PowerShell artifact).
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 0 && /\s$/.test(line)) {
      failed += 1;
      problems.push(`${rel}:${i + 1}: trailing whitespace`);
      break;
    }
  }
  // Final newline (the file must end with exactly one).
  if (bytes > 0 && !raw.endsWith('\n')) {
    failed += 1;
    problems.push(`${rel}: missing trailing newline`);
  } else if (raw.endsWith('\n\n')) {
    failed += 1;
    problems.push(`${rel}: extra blank line at end of file`);
  }
  // Indent: each non-blank line's leading whitespace must be only spaces, and the depth must be a multiple of INDENT.
  // Skip JSDoc continuation lines (`*`) and `//` comments to avoid false positives.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
    const m = /^( *)([^ ].*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    if (indent % INDENT !== 0) {
      failed += 1;
      problems.push(`${rel}:${i + 1}: indent ${indent} is not a multiple of ${INDENT}`);
      break;
    }
  }
}

if (failed > 0) {
  for (const p of problems) process.stderr.write(`${p}\n`);
  process.stderr.write(`\ncheck-format: ${failed} issue(s) across ${files.length} file(s)\n`);
  process.exit(1);
}
process.stdout.write(`check-format: ${files.length} file(s) ok\n`);

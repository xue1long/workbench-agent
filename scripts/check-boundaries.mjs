#!/usr/bin/env node
// scripts/check-boundaries.mjs — enforce the architectural boundary contract
// declared in docs/ENGINEERING.md §"The boundary contract".
//
// Walks every *.mjs and *.js under src/, apps/, adapters/, core/, schemas/,
// parses the static import declarations, classifies each by source/target
// package, and fails the build when an import direction is forbidden.
//
// Usage:
//   node scripts/check-boundaries.mjs [--root <dir>] [--quiet]
//
// Exit codes:
//   0 — no violations
//   1 — one or more violations found
//   2 — usage error

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';

// ── Boundary matrix ────────────────────────────────────────────────────────
//
// Source-prefix : array of allowed import-target prefixes within the repo.
// `null` means "any within the same top-level directory tree is allowed".
// `forbidConcrete` : array of file-name patterns that, when imported from
// this source-prefix, are always a violation (e.g. concrete adapter files).
//
// Adding a new subtree? Extend this table; do not weaken the rules below it.

const MATRIX = [
  // src/ is the CLI bootstrap surface. It is the single exception allowed to
  // import concrete adapter classes — that is how it wires `workbench plan`
  // / `apply` etc. to the right adapter implementations. The registry in
  // core/adapters.mjs is still the recommended surface for everything else.
  { src: 'src', allow: ['core', 'adapters', 'schemas', 'apps', 'adapters-concrete'], forbidConcrete: [] },
  { src: 'apps', allow: ['core', 'schemas'], forbidConcrete: ['adapters'] },
  { src: 'adapters', allow: ['core', 'adapters'], forbidConcrete: ['apps', 'src'] },
  { src: 'core/intelligence', allow: ['core/(?!laboratory)'], forbidConcrete: ['apps', 'adapters'] },
  { src: 'core/laboratory', allow: ['core'], forbidConcrete: ['apps'] },
  // core/* may import `adapters/index.js` (the registry entry point) for
  // its side effect of registering concrete adapters, but it must NOT
  // import concrete adapter files directly. The boundary gate enforces
  // that distinction via the `adapters-concrete` token below.
  { src: 'core', allow: ['core', 'adapters-concrete'], forbidConcrete: ['adapters', 'apps', 'src'] },
  { src: 'schemas', allow: [], forbidConcrete: [] },
];

// ── Argument parsing ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
let root = process.cwd();
let quiet = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') {
    root = args[++i];
  } else if (args[i] === '--quiet') {
    quiet = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    process.stdout.write(
      'Usage: node scripts/check-boundaries.mjs [--root <dir>] [--quiet]\n'
    );
    process.exit(0);
  } else {
    process.stderr.write(`unknown argument: ${args[i]}\n`);
    process.exit(2);
  }
}
root = root.replace(/[/\\]+$/, '');

// ── File discovery ─────────────────────────────────────────────────────────

const SCAN_DIRS = ['src', 'apps', 'adapters', 'core', 'schemas'];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
    } else if (st.isFile() && /\.(mjs|js)$/.test(name)) {
      out.push(full);
    }
  }
}

const files = [];
for (const top of SCAN_DIRS) {
  walk(join(root, top), files);
}

// ── Import extraction (regex-based, ESM only) ─────────────────────────────
//
// Matches the three import shapes we care about:
//   import x from 'foo'
//   import { y } from 'foo'
//   import 'foo'
// Skips `node:` builtins and bare specifiers (no relative path / no leading .).

const IMPORT_RE =
  /(?:^|[^.\w])import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

function extractImports(source) {
  const out = [];
  let m;
  while ((m = IMPORT_RE.exec(source)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function isExternal(spec) {
  if (spec.startsWith('node:')) return true;
  if (!spec.startsWith('.')) return true;
  return false;
}

function normalize(relPath) {
  return relPath.split(sep).join('/');
}

// ── Classification ─────────────────────────────────────────────────────────

function resolveImport(fromFile, spec) {
  // fromFile is repo-relative (forward slashes).
  // spec is the literal import string.
  // We only resolve same-repo relative imports.
  const fromDir = posix.dirname(fromFile);
  const parts = spec.split('/');
  const stack = fromDir.split('/');
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      stack.pop();
      continue;
    }
    stack.push(p);
  }
  // Resolve to a directory and a file-with-extension.
  const joined = stack.join('/');
  const candidates = [
    joined,
    `${joined}.mjs`,
    `${joined}.js`,
    `${joined}/index.mjs`,
    `${joined}/index.js`,
  ];
  // We return the joined (directory-style) path; concrete-vs-index decision
  // happens downstream so error messages are stable.
  return joined;
}

function classifyTarget(srcPrefix, targetRepoPath) {
  // Find the most specific matrix row.
  const row = MATRIX.find((r) => srcPrefix === r.src || srcPrefix.startsWith(`${r.src}/`));
  if (!row) return { kind: 'unknown-source' };

  const top = targetRepoPath.split('/')[0];
  const isAdapterConcrete =
    top === 'adapters' &&
    targetRepoPath !== 'adapters/index.js' &&
    targetRepoPath !== 'adapters/index.mjs';
  const isAdapterIndex =
    top === 'adapters' &&
    (targetRepoPath === 'adapters/index.js' || targetRepoPath === 'adapters/index.mjs');

  // adapters-concrete is a per-row special token that controls the
  // concrete-adapter exception:
  //   - For src/: allows ANY adapters/* file (CLI bootstrap wires up
  //     concrete classes by name).
  //   - For core/: allows ONLY adapters/index.js (the registry entry
  //     point); concrete adapter files are still forbidden.
  const allowsConcreteAdapters =
    row.allow.includes('adapters-concrete') && row.src === 'src';
  const allowsAdapterIndex =
    row.allow.includes('adapters-concrete') && row.src === 'core';

  // Concrete-adapter files: forbidden unless the row explicitly allows
  // them via the src-bootstrap exception OR the source file is the
  // adapters/ bulk-import entry point (any file literally named
  // index.js or index.mjs under adapters/ — these are the registry
  // surface the boundary contract specifically permits).
  const isAdapterIndexFile =
    srcPrefix.startsWith('adapters') &&
    (srcPrefix === 'adapters' || srcPrefix.endsWith('/index'));
  if (isAdapterConcrete && !allowsConcreteAdapters && !isAdapterIndexFile) {
    return {
      kind: 'forbidden-concrete',
      reason: 'concrete adapter file (use adapters/index.js)',
    };
  }

  // forbidConcrete entries forbid concrete top-level dirs; the index
  // entry point is not concrete and is handled below. Only apply
  // forbidConcrete to concrete targets.
  if (row.forbidConcrete.includes(top) && !isAdapterIndex) {
    return {
      kind: 'forbidden-direction',
      reason: `${row.src} may not import ${top}`,
    };
  }

  // adapters/index.js: when the row is core/, this is the only allowed
  // way to touch the adapters subtree. For other rows that don't list
  // 'adapters' or 'adapters-concrete', this is still forbidden.
  if (isAdapterIndex) {
    if (allowsAdapterIndex || row.allow.includes('adapters') || row.allow.includes('adapters-concrete')) {
      return { kind: 'allowed' };
    }
    return {
      kind: 'forbidden-direction',
      reason: `${row.src} may not import ${top}`,
    };
  }

  // Check the allow list. Each entry is either:
  //   - a literal top-level prefix to match the start of targetRepoPath, OR
  //   - a regex pattern starting with "(?!" (negative lookahead) or any
  //     string containing regex metachars.
  for (const allowed of row.allow) {
    if (allowed === 'adapters-concrete') continue; // handled above
    if (allowed.includes('(') || allowed.includes('[') || allowed.includes('.')) {
      const re = new RegExp(`^${allowed}`);
      if (re.test(targetRepoPath)) return { kind: 'allowed' };
    } else {
      if (targetRepoPath === allowed || targetRepoPath.startsWith(`${allowed}/`)) {
        return { kind: 'allowed' };
      }
    }
  }

  return {
    kind: 'forbidden-direction',
    reason: `${row.src} may not import ${top}`,
  };
}

// ── Walk ───────────────────────────────────────────────────────────────────

const violations = [];

for (const fullPath of files) {
  const rel = normalize(relative(root, fullPath));
  let content;
  try {
    content = readFileSync(fullPath, 'utf8');
  } catch {
    continue;
  }
  const imports = extractImports(content);
  for (const spec of imports) {
    if (isExternal(spec)) continue;
    const target = resolveImport(rel, spec);
    if (!target.startsWith('src/') && !target.startsWith('apps/') && !target.startsWith('adapters/') && !target.startsWith('core/') && !target.startsWith('schemas/')) {
      continue; // resolves outside the matrix; ignore
    }
    // srcPrefix is the directory containing the source file (forward slashes,
    // no trailing slash). classifyTarget uses this to pick the matrix row.
    const srcPrefix = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const verdict = classifyTarget(srcPrefix, target);
    if (verdict.kind === 'allowed' || verdict.kind === 'unknown-source') continue;
    violations.push({
      file: rel,
      spec,
      target,
      reason: verdict.reason || verdict.kind,
    });
  }
}

// ── Report ─────────────────────────────────────────────────────────────────

if (violations.length === 0) {
  if (!quiet) {
    process.stdout.write(`boundary check: 0 violations across ${files.length} files\n`);
  }
  process.exit(0);
}

for (const v of violations) {
  process.stdout.write(
    `boundary violation: ${v.file} imports '${v.spec}' (resolves to ${v.target}) — ${v.reason}\n`
  );
}
process.stdout.write(
  `\nboundary check: ${violations.length} violation(s) across ${files.length} files\n`
);
process.exit(1);

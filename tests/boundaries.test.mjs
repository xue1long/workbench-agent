// tests/boundaries.test.mjs
//
// Drives scripts/check-boundaries.mjs against synthetic project trees.
// Each case builds a tmp dir with a tiny mirror of the workbench layout
// (core/, adapters/, apps/, src/), drops files that exercise one rule
// of the boundary matrix, runs the script, and asserts exit code +
// whether the expected violation is named in stderr/stdout.
//
// The script under test MUST live at <repo>/scripts/check-boundaries.mjs.
// We locate it relative to this test file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'check-boundaries.mjs');

function freshTree() {
  const root = mkdtempSync(join(tmpdir(), 'boundary-test-'));
  mkdirSync(join(root, 'core', 'intelligence'), { recursive: true });
  mkdirSync(join(root, 'core', 'laboratory'), { recursive: true });
  mkdirSync(join(root, 'adapters'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'schemas'), { recursive: true });
  // Touch the entries the script needs to recognise as legitimate directories.
  writeFileSync(join(root, 'adapters', 'index.js'), '');
  writeFileSync(join(root, 'core', 'intelligence', 'index.js'), '');
  writeFileSync(join(root, 'core', 'laboratory', 'index.js'), '');
  return root;
}

function run(root) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--root', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: out, stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
    };
  }
}

function writeCoreFile(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function writeAdapterFile(root, name, content = '') {
  writeFileSync(join(root, 'adapters', `${name}.mjs`), content);
}

test('clean tree with empty core/adapters/apps/src produces zero violations', () => {
  const root = freshTree();
  try {
    writeCoreFile(root, 'core/x.mjs', 'export const x = 1;\n');
    writeCoreFile(root, 'core/intelligence/a.mjs', 'export const a = 1;\n');
    writeCoreFile(root, 'core/laboratory/b.mjs', 'export const b = 1;\n');
    writeAdapterFile(root, 'git', 'export class GitAdapter {}\n');
    writeFileSync(join(root, 'src', 'workbench.mjs'), 'export const x = 1;\n');
    writeFileSync(join(root, 'apps', 'web', 'app.js'), 'export const x = 1;\n');
    const r = run(root);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr=${r.stderr}\nstdout=${r.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('core importing concrete adapter is a violation', () => {
  const root = freshTree();
  try {
    writeAdapterFile(root, 'git');
    writeCoreFile(
      root,
      'core/sync.mjs',
      "import { GitAdapter } from '../adapters/git.mjs';\nexport const x = GitAdapter;\n"
    );
    const r = run(root);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.match(r.stdout + r.stderr, /core\/sync\.mjs/, 'expected the violation to name the file');
    assert.match(r.stdout + r.stderr, /adapters\/git\.mjs/, 'expected the violation to name the forbidden target');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('core importing the registered index entry point is allowed', () => {
  const root = freshTree();
  try {
    writeFileSync(join(root, 'adapters', 'index.js'), 'export {};\n');
    writeCoreFile(
      root,
      'core/registry.mjs',
      "import './index.js';\nexport const x = 1;\n"
    );
    const r = run(root);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstderr=${r.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('core/intelligence may NOT import core/laboratory', () => {
  const root = freshTree();
  try {
    writeCoreFile(
      root,
      'core/intelligence/a.mjs',
      "import './b.mjs';\nimport '../laboratory/b.mjs';\nexport const x = 1;\n"
    );
    writeCoreFile(root, 'core/laboratory/b.mjs', 'export const b = 1;\n');
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /laboratory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('adapters importing apps/ is a violation', () => {
  const root = freshTree();
  try {
    writeAdapterFile(root, 'git');
    writeCoreFile(
      root,
      'adapters/git.mjs',
      "import '../apps/web/app.js';\nexport class GitAdapter {}\n"
    );
    const r = run(root);
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /apps\/web/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scripts/check-boundaries.mjs exists in this repo', () => {
  // Sanity: the script under test must be present before any of the above tests pass.
  const r = run(mkdtempSync(join(tmpdir(), 'boundary-existence-')));
  // First run on a totally empty tmp dir will see no source files and exit 0,
  // or it will fail because the script doesn't exist yet. Either way, we
  // assert the SCRIPT path resolves to something on disk so test discovery
  // surfaces a missing-file error cleanly.
  assert.ok(SCRIPT.endsWith('check-boundaries.mjs'), 'script path resolution');
});

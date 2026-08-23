import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ProjectManager, ProjectError, validateProject } from '../core/projects.mjs';
import { GitAdapter, isSafeRemoteUrl } from '../adapters/git.mjs';

// ---------- GitAdapter: URL safety ----------------------------------------

test('isSafeRemoteUrl accepts https, ssh, file, and relative paths', () => {
  assert.ok(isSafeRemoteUrl('https://github.com/foo/bar.git'));
  assert.ok(isSafeRemoteUrl('http://example.com/x.git'));
  assert.ok(isSafeRemoteUrl('ssh://git@example.com/repo'));
  assert.ok(isSafeRemoteUrl('git@example.com:repo.git'));
  assert.ok(isSafeRemoteUrl('file:///tmp/repo'));
  assert.ok(isSafeRemoteUrl('./local-repo'));
  assert.ok(isSafeRemoteUrl('../sibling-repo'));
  assert.ok(isSafeRemoteUrl('/abs/path/repo'));
});

test('isSafeRemoteUrl rejects empty / non-string / ambiguous input', () => {
  assert.equal(isSafeRemoteUrl(''), false);
  assert.equal(isSafeRemoteUrl(null), false);
  assert.equal(isSafeRemoteUrl(undefined), false);
  assert.equal(isSafeRemoteUrl(42), false);
  assert.equal(isSafeRemoteUrl('not a url'), false);
});

// ---------- GitAdapter: refuse list --------------------------------------

test('GitAdapter refuses force-push / branch-delete / reset-hard by default', () => {
  const git = new GitAdapter();
  for (const method of ['forcePush', 'deleteBranch', 'resetHard']) {
    assert.throws(
      () => git[method](),
      (err) => err.code === 'ADAPTER_ACTION_REFUSED'
    );
  }
});

// ---------- GitAdapter: clone via fake runner -----------------------------

function fakeRunner(script) {
  return (args, opts = {}) => {
    const key = args.join(' ');
    const step = script[key];
    if (!step) {
      return { status: 1, stdout: '', stderr: `fakeRunner: no script for [${key}]` };
    }
    return typeof step === 'function' ? step(args, opts) : { ...step };
  };
}

test('GitAdapter.clone rejects unsafe URLs without invoking the runner', () => {
  const git = new GitAdapter({ runner: fakeRunner({}) });
  assert.throws(() => git.clone('not a url', '/tmp/x'), (err) => err.code === 'GIT_UNSAFE_URL');
});

test('GitAdapter.clone calls git with a validated arg array and records success', () => {
  const calls = [];
  const git = new GitAdapter({
    runner: (args, opts = {}) => {
      calls.push(args);
      if (args[0] === 'clone') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === '-C' && args[2] === 'checkout') return { status: 0, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected' };
    },
  });
  const res = git.clone('https://github.com/foo/bar.git', '/tmp/bar', 'main');
  assert.deepEqual(res, { ok: true, target: '/tmp/bar', ref: 'main' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['clone', 'https://github.com/foo/bar.git', '/tmp/bar']);
  assert.deepEqual(calls[1], ['-C', '/tmp/bar', 'checkout', 'main']);
});

test('GitAdapter.clone surfaces a structured error on clone failure', () => {
  const git = new GitAdapter({
    runner: (args) => args[0] === 'clone'
      ? { status: 128, stdout: '', stderr: 'repository not found' }
      : { status: 0, stdout: '', stderr: '' },
  });
  assert.throws(
    () => git.clone('https://github.com/foo/missing.git', '/tmp/x'),
    (err) => err.code === 'GIT_CLONE_FAILED' && /repository not found/.test(err.message)
  );
});

test('GitAdapter.clone surfaces GIT_CHECKOUT_FAILED when the post-clone checkout fails', () => {
  const git = new GitAdapter({
    runner: (args) => args[0] === 'clone'
      ? { status: 0, stdout: '', stderr: '' }
      : { status: 1, stdout: '', stderr: 'invalid ref' },
  });
  assert.throws(
    () => git.clone('https://example.com/x.git', '/tmp/x', 'bogus-ref'),
    (err) => err.code === 'GIT_CHECKOUT_FAILED'
  );
});

test('GitAdapter.fetch surfaces GIT_FETCH_FAILED when the network call fails', () => {
  const git = new GitAdapter({
    runner: () => ({ status: 128, stdout: '', stderr: 'no network' }),
  });
  assert.throws(
    () => git.fetch('/tmp/repo'),
    (err) => err.code === 'GIT_FETCH_FAILED'
  );
});

test('GitAdapter.headCommit surfaces GIT_REVPARSE_FAILED on bad repo', () => {
  const git = new GitAdapter({
    runner: () => ({ status: 128, stdout: '', stderr: 'not a git repo' }),
  });
  assert.throws(
    () => git.headCommit('/tmp/not-repo'),
    (err) => err.code === 'GIT_REVPARSE_FAILED'
  );
});

test('GitAdapter.status surfaces GIT_STATUS_FAILED on bad repo', () => {
  const git = new GitAdapter({
    runner: () => ({ status: 128, stdout: '', stderr: 'not a git repo' }),
  });
  assert.throws(
    () => git.status('/tmp/not-repo'),
    (err) => err.code === 'GIT_STATUS_FAILED'
  );
});

// ---------- validateProject ----------------------------------------------

test('validateProject rejects missing / malformed id', () => {
  assert.throws(() => validateProject({ source: { type: 'local' }, path: 'a' }), ProjectError);
  assert.throws(() => validateProject({ id: '../escape', source: { type: 'local' }, path: 'a' }), ProjectError);
});

test('validateProject requires source.type', () => {
  assert.throws(
    () => validateProject({ id: 'p', source: {}, path: 'a' }),
    (err) => err.code === 'PROJECT_FIELD_INVALID'
  );
});

test('validateProject requires source.url for git sources', () => {
  assert.throws(
    () => validateProject({ id: 'p', source: { type: 'git' }, path: 'a' }),
    (err) => err.code === 'PROJECT_FIELD_REQUIRED'
  );
});

// ---------- ProjectManager.sync ------------------------------------------

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-projects-'));
}

function localProject(id, relPath) {
  return { id, source: { type: 'local' }, path: relPath };
}

function gitProject(id, url, relPath, ref = null) {
  return { id, source: { type: 'git', url, ref }, path: relPath };
}

test('ProjectManager.sync creates local project directories', () => {
  const root = tmpRoot();
  try {
    const pm = new ProjectManager();
    const report = pm.sync([localProject('notes', 'projects/notes')], root);
    assert.equal(report.ok, true);
    assert.equal(report.summary.synced, 1);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.projects[0].status, 'CREATED');
    assert.ok(fs.existsSync(path.join(root, 'projects', 'notes')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager.sync reuses existing local project directories (idempotent)', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'projects', 'notes'), { recursive: true });
    const pm = new ProjectManager();
    const report = pm.sync([localProject('notes', 'projects/notes')], root);
    assert.equal(report.projects[0].status, 'PRESENT');
    assert.equal(report.projects[0].changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager.sync clones a missing git project via a fake git adapter', () => {
  const root = tmpRoot();
  try {
    const calls = [];
    const git = new GitAdapter({
      runner: (args) => {
        calls.push(args);
        if (args[0] === 'clone') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === '-C' && args[2] === 'rev-parse') return { status: 0, stdout: 'abc123\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const pm = new ProjectManager({ git });
    const report = pm.sync([gitProject('app', 'https://example.com/app.git', 'projects/app')], root);
    assert.equal(report.ok, true);
    assert.equal(report.projects[0].status, 'CLONED');
    assert.ok(calls.some(([head]) => head === 'clone'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager.sync fetches into an existing git project', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'projects', 'app'), { recursive: true });
    const calls = [];
    const git = new GitAdapter({
      runner: (args) => {
        calls.push(args);
        if (args[0] === '-C' && args[2] === 'fetch') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === '-C' && args[2] === 'rev-parse') return { status: 0, stdout: 'deadbeef\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const pm = new ProjectManager({ git });
    const report = pm.sync([gitProject('app', 'https://example.com/app.git', 'projects/app')], root);
    assert.equal(report.projects[0].status, 'FETCHED');
    assert.equal(report.projects[0].details.sha, 'deadbeef');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager.sync stops on the first failure unless continueOnError', () => {
  const root = tmpRoot();
  try {
    const git = new GitAdapter({
      runner: (args) => args[0] === 'clone'
        ? { status: 128, stdout: '', stderr: 'no network' }
        : { status: 0, stdout: '', stderr: '' },
    });
    const pm = new ProjectManager({ git });
    const report = pm.sync(
      [gitProject('a', 'https://example.com/a.git', 'a'), gitProject('b', 'https://example.com/b.git', 'b')],
      root
    );
    assert.equal(report.ok, false);
    assert.equal(report.projects[0].status, 'FAILED');
    assert.equal(report.summary.synced, 0);
    assert.equal(report.summary.failed, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager.sync continues past failures when continueOnError is true', () => {
  const root = tmpRoot();
  try {
    const git = new GitAdapter({
      runner: (args) => args[0] === 'clone' && args[1].endsWith('/bad.git')
        ? { status: 128, stdout: '', stderr: 'no network' }
        : { status: 0, stdout: '', stderr: '' },
    });
    const pm = new ProjectManager({ git });
    const report = pm.sync(
      [gitProject('bad', 'https://example.com/bad.git', 'bad'), localProject('notes', 'notes')],
      root,
      { continueOnError: true }
    );
    assert.equal(report.summary.failed, 1);
    assert.equal(report.summary.synced, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager refuses project paths that escape the workspace root', () => {
  const root = tmpRoot();
  try {
    const pm = new ProjectManager();
    // sync() never throws per-project; it returns a failed report and stops.
    const report = pm.sync([localProject('escape', '../outside')], root);
    assert.equal(report.ok, false);
    assert.equal(report.projects[0].status, 'FAILED');
    assert.equal(report.projects[0].error.code, 'PROJECT_PATH_ESCAPE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager accepts absolute paths that resolve inside the workspace root', () => {
  const root = tmpRoot();
  try {
    const absoluteInside = path.join(root, 'sub', 'project');
    const pm = new ProjectManager();
    const report = pm.sync([localProject('inside', absoluteInside)], root);
    assert.equal(report.ok, true);
    assert.equal(report.summary.synced, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager.sync with an empty projects list returns ok with synced=0', () => {
  const root = tmpRoot();
  try {
    const pm = new ProjectManager();
    const report = pm.sync([], root);
    assert.equal(report.ok, true);
    assert.equal(report.summary.total, 0);
    assert.equal(report.summary.synced, 0);
    assert.equal(report.summary.failed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager.verifyOne reports MISSING when the project path does not exist', () => {
  const root = tmpRoot();
  try {
    const pm = new ProjectManager();
    const report = pm.verifyOne(gitProject('p', 'https://example.com/p.git', 'p'), root);
    assert.equal(report.status, 'MISSING');
    assert.equal(report.changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ProjectManager.verifyOne reports DIRTY for a modified working tree', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(path.join(root, 'p'), { recursive: true });
    const git = new GitAdapter({
      runner: (args) => {
        if (args[0] === '-C' && args[2] === 'status') return { status: 0, stdout: ' M README.md\n', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const pm = new ProjectManager({ git });
    const report = pm.verifyOne(gitProject('p', 'https://example.com/p.git', 'p'), root);
    assert.equal(report.status, 'DIRTY');
    assert.deepEqual(report.details.files, [' M README.md']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
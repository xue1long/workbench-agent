// Level 7 Task 3: package ecosystem.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { StateStore } from '../core/store.mjs';
import {
  registerPackage, verifyPackage, markVerified, installPackage, uninstallPackage, availablePackages,
  PACKAGE_KINDS, PackageEcosystemError,
} from '../core/packages-l7.mjs';

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pkg-'));
  const store = StateStore.open('ws', { root: path.join(tmp, 'store') });
  return { tmp, store };
}

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function skillPackage(over = {}) {
  const manifest = {
    id: 'skill-1', kind: 'skill', version: '1.0.0',
    source: { kind: 'local', path: '/tmp/skill-1' },
    permissions: ['fs:read'],
    compatibility: { node: '>=20' },
    uninstall: 'remove .workbench/installed/skill-1',
    rollback: 'remove .workbench/installed/skill-1',
    ...over,
  };
  manifest.checksum = over.checksum ?? sha256(JSON.stringify(manifest, null, 2));
  return manifest;
}

test('registerPackage validates required fields and rejects bad input', () => {
  const env = makeEnv();
  try {
    // An empty object fails kind validation first; the rest of the matrix exercises one invalid field each.
    assert.throws(() => registerPackage({ store: env.store, package: {} }), (err) => err.code === 'PACKAGE_KIND_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ id: '' }) }), (err) => err.code === 'PACKAGE_ID_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ kind: 'unknown' }) }), (err) => err.code === 'PACKAGE_KIND_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ version: '' }) }), (err) => err.code === 'PACKAGE_VERSION_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ source: null }) }), (err) => err.code === 'PACKAGE_SOURCE_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ source: { kind: 'http' } }) }), (err) => err.code === 'PACKAGE_SOURCE_KIND_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ checksum: 'not-hex' }) }), (err) => err.code === 'PACKAGE_CHECKSUM_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ permissions: 'no' }) }), (err) => err.code === 'PACKAGE_PERMISSIONS_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ compatibility: null }) }), (err) => err.code === 'PACKAGE_COMPATIBILITY_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ uninstall: '' }) }), (err) => err.code === 'PACKAGE_UNINSTALL_INVALID');
    assert.throws(() => registerPackage({ store: env.store, package: skillPackage({ rollback: '' }) }), (err) => err.code === 'PACKAGE_ROLLBACK_INVALID');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('PACKAGE_KINDS covers the eight proven-asset kinds', () => {
  assert.deepEqual(PACKAGE_KINDS, ['agent', 'skill', 'mcp', 'workflow', 'knowledge-pack', 'meta-skill', 'evaluator', 'workspace-template']);
});

test('a manifest can be verified only when on-disk content matches the declared checksum', () => {
  const env = makeEnv();
  try {
    const pkg = skillPackage();
    registerPackage({ store: env.store, package: pkg });
    const sandbox = { root: path.join(env.tmp, 'sb') };
    const r = verifyPackage({ package: pkg, sandbox });
    assert.equal(r.ok, true);
    // A package whose declared checksum does NOT match its own canonical bytes
    // fails verification — this exercises the checksum-mismatch path that
    // protects against a tampered or forged manifest.
    const tampered = skillPackage({ id: 'skill-2', checksum: 'deadbeef'.repeat(8) });
    assert.throws(() => verifyPackage({ package: tampered, sandbox }), (err) => err.code === 'PACKAGE_CHECKSUM_MISMATCH');
    registerPackage({ store: env.store, package: tampered });
    // Install short-circuits on PACKAGE_NOT_VERIFIED before it could reach the
    // checksum mismatch — `verifyPackage` alone exercises the mismatch path.
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('a malicious package fixture (verifier exit non-zero) is rejected before install', () => {
  const env = makeEnv();
  try {
    const pkg = skillPackage();
    registerPackage({ store: env.store, package: pkg });
    const sandbox = { root: path.join(env.tmp, 'sb'), runVerifier: () => 1 };
    assert.throws(() => verifyPackage({ package: pkg, sandbox }), (err) => err.code === 'PACKAGE_VERIFIER_FAILED');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('installPackage requires verification first and writes the manifest; uninstall reverses it', () => {
  const env = makeEnv();
  try {
    const pkg = skillPackage();
    registerPackage({ store: env.store, package: pkg });
    const sandbox = { root: path.join(env.tmp, 'sb') };
    assert.throws(() => installPackage({ store: env.store, packageId: pkg.id, version: pkg.version, workspaceRoot: env.tmp, sandbox }), (err) => err.code === 'PACKAGE_NOT_VERIFIED');
    verifyPackage({ package: pkg, sandbox });
    markVerified({ store: env.store, packageId: pkg.id, version: pkg.version });
    const install = installPackage({ store: env.store, packageId: pkg.id, version: pkg.version, workspaceRoot: env.tmp, sandbox });
    assert.match(install.installPath, /skill-1$/);
    assert.ok(fs.existsSync(path.join(install.installPath, 'package.json')));
    uninstallPackage({ store: env.store, packageId: pkg.id, version: pkg.version, workspaceRoot: env.tmp });
    assert.ok(!fs.existsSync(install.installPath));
    assert.equal(env.store.readRows('package_install').length, 2);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('availablePackages returns only verified packages', () => {
  const env = makeEnv();
  try {
    const pkg = skillPackage();
    registerPackage({ store: env.store, package: pkg });
    assert.deepEqual(availablePackages({ store: env.store }), []);
    verifyPackage({ package: pkg, sandbox: { root: path.join(env.tmp, 'sb') } });
    markVerified({ store: env.store, packageId: pkg.id, version: pkg.version });
    const list = availablePackages({ store: env.store });
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'skill');
    assert.equal(list[0].verified, true);
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

test('duplicate id+version is rejected', () => {
  const env = makeEnv();
  try {
    const pkg = skillPackage();
    registerPackage({ store: env.store, package: pkg });
    assert.throws(() => registerPackage({ store: env.store, package: pkg }), (err) => err.code === 'PACKAGE_EXISTS');
  } finally {
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
});

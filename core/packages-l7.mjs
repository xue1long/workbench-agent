// Level 7 Task 3: package ecosystem.
//
// Extends the M-series Package registry with the proven-asset kinds proven
// by L2-L7 (Agent, Skill, MCP, Workflow, Knowledge Pack, Meta-Skill,
// Evaluator, Workspace Template). Every install goes through a sandboxed
// verifier before a package becomes visible to a workspace. Uninstall is
// supported and reproducible from the manifest.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class PackageEcosystemError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PackageEcosystemError';
    this.code = code;
    if (details) this.details = details;
  }
}

export const PACKAGE_KINDS = Object.freeze([
  'agent', 'skill', 'mcp', 'workflow', 'knowledge-pack', 'meta-skill', 'evaluator', 'workspace-template',
]);

const KIND_SET = new Set(PACKAGE_KINDS);
const PACKAGE_TABLE = 'package_l7';

function sha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function requireStore(store) {
  if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
    throw new PackageEcosystemError('PACKAGE_STORE_INVALID', 'package ecosystem requires a StateStore');
  }
}

function validatePackage(pkg) {
  if (!pkg || typeof pkg !== 'object') throw new PackageEcosystemError('PACKAGE_PAYLOAD_INVALID', 'package object is required');
  if (!KIND_SET.has(pkg.kind)) throw new PackageEcosystemError('PACKAGE_KIND_INVALID', `kind must be one of ${PACKAGE_KINDS.join(', ')}`);
  if (typeof pkg.id !== 'string' || !pkg.id.trim()) throw new PackageEcosystemError('PACKAGE_ID_INVALID', 'package id is required');
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) throw new PackageEcosystemError('PACKAGE_VERSION_INVALID', 'package version is required');
  if (typeof pkg.source !== 'object' || pkg.source === null) throw new PackageEcosystemError('PACKAGE_SOURCE_INVALID', 'package source is required (local path or git)');
  if (typeof pkg.source.kind !== 'string' || !['local', 'git'].includes(pkg.source.kind)) {
    throw new PackageEcosystemError('PACKAGE_SOURCE_KIND_INVALID', "package source.kind must be 'local' or 'git'");
  }
  if (typeof pkg.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(pkg.checksum)) {
    throw new PackageEcosystemError('PACKAGE_CHECKSUM_INVALID', 'package.checksum must be a sha256 hex digest');
  }
  if (!Array.isArray(pkg.permissions)) throw new PackageEcosystemError('PACKAGE_PERMISSIONS_INVALID', 'package.permissions must be an array');
  if (typeof pkg.compatibility !== 'object' || pkg.compatibility === null) throw new PackageEcosystemError('PACKAGE_COMPATIBILITY_INVALID', 'package.compatibility is required');
  if (typeof pkg.uninstall !== 'string' || !pkg.uninstall.trim()) throw new PackageEcosystemError('PACKAGE_UNINSTALL_INVALID', 'package.uninstall instructions are required');
  if (typeof pkg.rollback !== 'string' || !pkg.rollback.trim()) throw new PackageEcosystemError('PACKAGE_ROLLBACK_INVALID', 'package.rollback instructions are required');
}

export function registerPackage({ store, package: pkg }) {
  requireStore(store);
  validatePackage(pkg);
  const rows = store.readRows(PACKAGE_TABLE);
  if (rows.some((r) => r.id === pkg.id && r.version === pkg.version)) {
    throw new PackageEcosystemError('PACKAGE_EXISTS', `package ${pkg.id}@${pkg.version} already exists`);
  }
  const verified = Boolean(rows.find((r) => r.id === pkg.id && r.version === pkg.version && r.verified));
  if (verified) {
    throw new PackageEcosystemError('PACKAGE_EXISTS', `package ${pkg.id}@${pkg.version} already exists`);
  }
  const row = { ...pkg, verified: false, registeredAt: new Date().toISOString() };
  store.appendRow(PACKAGE_TABLE, row);
  return row;
}

// Sandboxed verifier: writes the package manifest into a temp worktree, runs
// the verifier command, asserts exit 0 and checksums match.
export function verifyPackage({ package: pkg, sandbox }) {
  if (!pkg || !sandbox) throw new PackageEcosystemError('PACKAGE_VERIFY_INVALID', 'package and sandbox are required');
  const root = sandbox.root ?? sandbox.sandboxPath;
  if (typeof root !== 'string') throw new PackageEcosystemError('PACKAGE_VERIFY_SANDBOX_INVALID', 'sandbox.root is required');
  fs.mkdirSync(root, { recursive: true });
  // Canonicalize: the declared checksum hashes the manifest without the
  // checksum/registry/store fields; mirror that here so verification matches.
  const { checksum: _c, verified: _v, verifiedAt: _va, registeredAt: _ra, _id: _id, _at: _at, ...canonical } = pkg;
  const manifestPath = path.join(root, 'package.json');
  fs.writeFileSync(manifestPath, JSON.stringify(canonical, null, 2), 'utf8');
  const verifierExit = sandbox.runVerifier ? sandbox.runVerifier({ package: pkg, sandboxRoot: root }) : 0;
  if (verifierExit !== 0) {
    throw new PackageEcosystemError('PACKAGE_VERIFIER_FAILED', `verifier exited with code ${verifierExit}`);
  }
  const onDiskChecksum = sha256(fs.readFileSync(manifestPath, 'utf8'));
  if (onDiskChecksum !== pkg.checksum) {
    throw new PackageEcosystemError('PACKAGE_CHECKSUM_MISMATCH', `checksum mismatch: expected ${pkg.checksum}, got ${onDiskChecksum}`);
  }
  return { ok: true, manifestPath, verifiedAt: new Date().toISOString() };
}

export function markVerified({ store, packageId, version }) {
  requireStore(store);
  const rows = store.readRows(PACKAGE_TABLE);
  const latest = rows.filter((r) => r.id === packageId && r.version === version).slice(-1)[0];
  if (!latest) throw new PackageEcosystemError('PACKAGE_NOT_FOUND', `${packageId}@${version} not registered`);
  const updated = { ...latest, verified: true, verifiedAt: new Date().toISOString() };
  store.appendRow(PACKAGE_TABLE, updated);
  return updated;
}

export function installPackage({ store, packageId, version, workspaceRoot, sandbox }) {
  requireStore(store);
  const pkg = store.readRows(PACKAGE_TABLE).filter((r) => r.id === packageId && r.version === version).slice(-1)[0];
  if (!pkg) throw new PackageEcosystemError('PACKAGE_NOT_FOUND', `${packageId}@${version} not registered`);
  if (!pkg.verified) throw new PackageEcosystemError('PACKAGE_NOT_VERIFIED', `${packageId}@${version} must pass sandbox verification before install`);
  // Strip registry-only and store-bookkeeping fields so the sandbox
  // manifest matches the declared checksum deterministically.
  const { checksum: _c, verified: _v, verifiedAt: _va, registeredAt: _ra, _id: _id, _at: _at, ...manifestOnly } = pkg;
  const result = verifyPackage({ package: { ...manifestOnly, checksum: pkg.checksum }, sandbox });
  const target = path.join(workspaceRoot, '.workbench', 'installed', packageId);
  fs.mkdirSync(target, { recursive: true });
  const targetFile = path.join(target, 'package.json');
  fs.copyFileSync(result.manifestPath, targetFile);
  store.appendRow('package_install', { packageId, version, installedAt: new Date().toISOString(), installPath: target });
  return { packageId, version, installPath: target };
}

export function uninstallPackage({ store, packageId, version, workspaceRoot }) {
  requireStore(store);
  const installPath = path.join(workspaceRoot, '.workbench', 'installed', packageId);
  if (!fs.existsSync(installPath)) throw new PackageEcosystemError('PACKAGE_NOT_INSTALLED', `${packageId} is not installed`);
  fs.rmSync(installPath, { recursive: true, force: true });
  // Reverse the verified flag so the package is no longer available until it
  // passes sandbox verification again.
  const rows = store.readRows(PACKAGE_TABLE);
  const latest = rows.filter((r) => r.id === packageId && r.version === version).slice(-1)[0];
  if (latest && latest.verified) {
    store.appendRow(PACKAGE_TABLE, { ...latest, verified: false, verifiedAt: null, uninstalledAt: new Date().toISOString() });
  }
  store.appendRow('package_install', { packageId, version, uninstalledAt: new Date().toISOString() });
  return { packageId, version, uninstalled: true };
}

export function availablePackages({ store, kind = null } = {}) {
  requireStore(store);
  const rows = store.readRows(PACKAGE_TABLE);
  const latest = new Map();
  for (const r of rows) latest.set(`${r.id}@${r.version}`, r);
  const list = [...latest.values()].filter((r) => r.verified);
  return kind ? list.filter((r) => r.kind === kind) : list;
}

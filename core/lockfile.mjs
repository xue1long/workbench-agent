// Lockfile — writes and reads `workspace.lock`.
//
// Per spec §8:
//   * Manifest = what the user wants
//   * Lockfile = what was actually installed
//   * Lockfile is written only from a verified AppliedState
//
// Format (JSON for now — YAML can land in a later milestone):
//   {
//     "version": "1",
//     "workspace": { "id": "...", "manifestVersion": "..." },
//     "generatedAt": "2026-08-23T...",
//     "environment": {
//       "node": { "version": "22.x.x", "source": "..." },
//       ...
//     },
//     "agents": [ ... ],
//     "mcp": [ ... ],
//     "projects": [ ... ]
//   }

import fs from 'node:fs';
import path from 'node:path';

const LOCKFILE_VERSION = '1';

export class LockfileError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LockfileError';
    this.code = options.code ?? 'LOCKFILE_ERROR';
  }
}

/**
 * Serialize an AppliedState + agent/mcp/project snapshots into a lockfile.
 */
export function buildLockfile({ workspaceId, appliedState, agents = [], mcp = [], projects = [], source = 'manifest' } = {}) {
  if (!workspaceId) {
    throw new LockfileError('workspaceId is required', { code: 'LOCKFILE_BAD_INPUT' });
  }
  return {
    version: LOCKFILE_VERSION,
    workspace: { id: workspaceId },
    generatedAt: new Date().toISOString(),
    source,
    environment: Object.fromEntries(
      (appliedState?.steps ?? []).map((s) => [
        s.resource,
        { version: s.version, action: s.action, status: s.status, at: s.at },
      ])
    ),
    agents: agents.map((a) => (typeof a.toJSON === 'function' ? a.toJSON() : a)),
    mcp: mcp.map((m) => (typeof m.toJSON === 'function' ? m.toJSON() : m)),
    projects: projects.map((p) => ({ id: p.id, status: p.status, sha: p.details?.sha, target: p.details?.target })),
  };
}

export function writeLockfile(lockfilePath, lockfile) {
  const absolute = path.resolve(lockfilePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  // Atomic write: serialize to a sibling .tmp file, fsync, then rename.
  // fs.renameSync is atomic on POSIX and best-effort on Windows; either way
  // we never leave a half-written workspace.lock behind on crash.
  const body = JSON.stringify(lockfile, null, 2);
  const tmp = absolute + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, absolute);
  return { written: absolute };
}

export function readLockfile(lockfilePath) {
  const absolute = path.resolve(lockfilePath);
  if (!fs.existsSync(absolute)) {
    throw new LockfileError(`lockfile not found: ${absolute}`, { code: 'LOCKFILE_NOT_FOUND' });
  }
  let raw;
  try {
    raw = fs.readFileSync(absolute, 'utf8');
  } catch (cause) {
    throw new LockfileError(`failed to read lockfile: ${cause.message}`, { code: 'LOCKFILE_READ_ERROR', cause });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new LockfileError(`lockfile is not valid JSON: ${cause.message}`, { code: 'LOCKFILE_PARSE_ERROR', cause });
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== LOCKFILE_VERSION) {
    throw new LockfileError(`lockfile version must be "${LOCKFILE_VERSION}"`, { code: 'LOCKFILE_VERSION_UNSUPPORTED' });
  }
  return parsed;
}
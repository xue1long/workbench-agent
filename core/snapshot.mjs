// Snapshot — captures pre-mutation copies of managed config files.
//
// Per spec §24:
//   * Snapshot managed config, MCP config, agent config, and lockfile before mutation.
//   * First-phase implementation: full file copies under a unique dir.
//   * Second phase (M4/M5): diff-based snapshots so unmanaged bytes aren't
//     accidentally captured. Out of scope here.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class SnapshotError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SnapshotError';
    this.code = options.code ?? 'SNAPSHOT_ERROR';
  }
}

export function createSnapshot(managedPaths, options = {}) {
  if (!Array.isArray(managedPaths)) {
    throw new SnapshotError('managedPaths must be an array', { code: 'SNAPSHOT_BAD_INPUT' });
  }
  const root = options.root ? path.resolve(options.root) : process.cwd();
  const id = options.id ?? `snap-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const snapshotDir = path.join(root, '.workbench', 'snapshots', id);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const captured = [];
  const missing = [];
  for (const managedPath of managedPaths) {
    const absolute = path.isAbsolute(managedPath) ? managedPath : path.resolve(root, managedPath);
    // Refuse to capture files outside `root`.
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new SnapshotError(`managed path "${managedPath}" escapes snapshot root`, {
        code: 'SNAPSHOT_PATH_ESCAPE',
      });
    }
    if (!fs.existsSync(absolute)) {
      missing.push(absolute);
      continue;
    }
    const destination = path.join(snapshotDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(absolute, destination);
    captured.push({ source: absolute, destination });
  }
  return { id, snapshotDir, captured, missing, createdAt: new Date().toISOString() };
}

export function listSnapshots(root = process.cwd()) {
  const dir = path.join(path.resolve(root), '.workbench', 'snapshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((name) => ({ id: name, path: path.join(dir, name) }));
}

export function restoreSnapshot(snapshotId, options = {}) {
  const root = options.root ? path.resolve(options.root) : process.cwd();
  const snapshotDir = path.join(root, '.workbench', 'snapshots', snapshotId);
  if (!fs.existsSync(snapshotDir)) {
    throw new SnapshotError(`snapshot "${snapshotId}" not found`, { code: 'SNAPSHOT_NOT_FOUND' });
  }
  const restored = [];
  const walkedRoots = new Set([snapshotDir]);
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      const to = path.resolve(root, prefix, entry.name);
      // Reject any destination that escapes the workspace root. A
      // malicious or corrupt snapshot must never be able to plant files
      // outside the workspace.
      const relative = path.relative(root, to);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new SnapshotError(`snapshot entry "${to}" escapes snapshot root`, {
          code: 'SNAPSHOT_PATH_ESCAPE',
        });
      }
      if (entry.isDirectory()) {
        // Refuse symlinks pointing outside the snapshot dir (TOCTOU guard).
        const real = fs.realpathSync.native ? fs.realpathSync.native(from) : fs.realpathSync(from);
        if (!walkedRoots.has(real) && !real.startsWith(snapshotDir)) {
          throw new SnapshotError(`snapshot symlink "${from}" points outside snapshot dir`, {
            code: 'SNAPSHOT_SYMLINK_ESCAPE',
          });
        }
        walkedRoots.add(real);
        walk(from, path.join(prefix, entry.name));
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        restored.push({ from, to });
      }
    }
  };
  walk(snapshotDir);
  return { id: snapshotId, restored, restoredAt: new Date().toISOString() };
}
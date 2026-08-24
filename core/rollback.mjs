// Rollback — restore managed files from a previous snapshot.
//
// Per spec §21 / §24:
//   Snapshot → Apply → Failure → Rollback
//
// M4 provides:
//   * `rollbackToSnapshot(snapshotId, options)` — restore files from a
//     named snapshot, recording an audit event.
//   * `listSnapshots()` — convenience passthrough.

import { restoreSnapshot, listSnapshots, SnapshotError } from './snapshot.mjs';
import { AuditLog } from './audit.mjs';

export class RollbackError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RollbackError';
    this.code = options.code ?? 'ROLLBACK_ERROR';
  }
}

export async function rollbackToSnapshot(snapshotId, options = {}) {
  const root = options.root ?? process.cwd();
  const audit = options.audit ?? new AuditLog({ workspaceId: options.workspaceId });
  try {
    const restored = restoreSnapshot(snapshotId, { root });
    audit.rollback({ snapshotId, reason: options.reason ?? 'unspecified' });
    audit.snapshotRestored(restored);
    return { ok: true, snapshotId, restored: restored.restored };
  } catch (err) {
    if (err instanceof SnapshotError) {
      throw new RollbackError(err.message, { code: err.code, cause: err });
    }
    throw err;
  }
}

export function listSnapshotsFor(root = process.cwd()) {
  return listSnapshots(root);
}

export { SnapshotError, restoreSnapshot, listSnapshots };

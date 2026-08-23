// Git adapter: wraps git commands for snapshotting and applying changes.
export function currentCommit(exec) {
  const out = exec(['git', 'rev-parse', 'HEAD']);
  return out.trim();
}

export function workingTreeDirty(exec) {
  const out = exec(['git', 'status', '--porcelain']);
  return out.trim().length > 0;
}

export function applyPatch(exec, patchPath) {
  return exec(['git', 'apply', patchPath]);
}

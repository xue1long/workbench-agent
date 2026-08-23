// Workspace synchronization: snapshots managed files, writes a lockfile,
// and restores declared projects to their pinned state.
export function buildSnapshot(files) {
  const entries = files.map((f) => ({ path: f.path, sha256: f.sha256 }));
  return { version: 1, entries, createdAt: new Date().toISOString() };
}

export function writeLockfile(snapshot, fsImpl) {
  const line = JSON.stringify(snapshot);
  fsImpl.writeFileSync('.workbench.lock', line, 'utf8');
  return line;
}

export function restoreFromSnapshot(snapshot, fsImpl) {
  for (const entry of snapshot.entries) {
    fsImpl.writeFileSync(entry.path, fsImpl.readFileSync(`.snapshots/${entry.sha256}`, 'utf8'));
  }
  return snapshot.entries.length;
}

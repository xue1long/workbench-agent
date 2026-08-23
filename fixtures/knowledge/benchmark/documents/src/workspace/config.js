// Workspace configuration loading: reads workspace.json / workspace.yaml and
// validates the manifest shape before any plan is produced.
export function loadWorkspaceConfig(cwd, fsImpl = fs) {
  for (const name of ['workspace.json', 'workspace.yaml']) {
    const target = `${cwd}/${name}`;
    if (fsImpl.existsSync(target)) return { path: target, raw: fsImpl.readFileSync(target, 'utf8') };
  }
  throw new Error(`no workspace manifest found in ${cwd}`);
}

export function parseWorkspaceConfig(raw) {
  return JSON.parse(raw);
}

import { loadManifest } from './manifest-load.mjs';
import { validateManifest } from './manifest-validate.mjs';
import { planFromManifest } from './plan.mjs';
import { getAdapter } from './adapters.mjs';
import { ObservedState } from './state.mjs';

// Side-effect import: registers concrete adapters with the registry.
import '../adapters/index.js';

export async function getWorkspaceStatus(manifestPath) {
  const manifest = loadManifest(manifestPath);
  validateManifest(manifest);
  const adapters = [getAdapter('node'), getAdapter('python'), getAdapter('uv')];
  const states = [];
  for (const adapter of adapters) states.push(await adapter.detect());
  const observed = new ObservedState(states);
  const plan = planFromManifest(manifest, observed);
  return {
    workspace: { id: manifest.workspace.id, name: manifest.workspace.name ?? manifest.workspace.id },
    health: 'PASS',
    resources: states.map(({ resource, version, status, details }) => ({ resource, version, status, details })),
    plan: {
      workspace: plan.workspace,
      steps: plan.steps,
    },
  };
}

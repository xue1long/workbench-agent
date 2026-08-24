// Pure planning: Manifest + ObservedState -> ExecutionPlan.

import { validateManifest, KNOWN_ENVIRONMENT_RESOURCES } from './manifest-validate.mjs';
import { ObservedState, diffResource } from './state.mjs';

export function planFromManifest(manifest, observed) {
  const { workspaceId, resources } = validateManifest(manifest);
  const orderedResources = [
    ...KNOWN_ENVIRONMENT_RESOURCES.filter((r) => resources.includes(r)),
    ...resources.filter((r) => !KNOWN_ENVIRONMENT_RESOURCES.includes(r)),
  ];
  const steps = [];
  for (const resource of orderedResources) {
    const desiredVersion = manifest.environment[resource].version;
    let currentVersion = null;
    if (observed instanceof ObservedState) {
      const state = observed.get(resource);
      currentVersion = state ? state.version : null;
    }
    steps.push({ resource, ...diffResource(desiredVersion, currentVersion) });
  }
  return { workspace: workspaceId, steps };
}

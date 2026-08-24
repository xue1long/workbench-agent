// Pure manifest loader — reads + parses + shape-checks JSON. Used by
// core/restore.mjs and other core/* modules. The CLI in src/ has its own
// thin wrapper that adds the user-facing error formatting.

import fs from 'node:fs';
import path from 'node:path';
import { ManifestError } from './manifest-validate.mjs';

export function loadManifest(manifestPath) {
  const absolute = path.resolve(manifestPath);
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (cause) {
    if (cause && cause.code === 'ENOENT') {
      throw new ManifestError(`manifest file not found: ${absolute}`, {
        code: 'MANIFEST_NOT_FOUND',
        field: '<path>',
        cause,
      });
    }
    throw cause;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ManifestError(`manifest at ${absolute} is not valid JSON: ${cause.message}`, {
      code: 'MANIFEST_PARSE_ERROR',
      cause,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManifestError(`manifest at ${absolute} must be a JSON object`, {
      code: 'MANIFEST_SHAPE_ERROR',
      field: '<root>',
    });
  }
  return parsed;
}

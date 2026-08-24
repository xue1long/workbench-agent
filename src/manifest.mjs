// Back-compat shim — `ManifestError` lives in core/manifest-validate.mjs.
// M1/M2 callers used to import from here; keep the import path stable.

export { ManifestError, validateManifest, VALID_ID, VALID_VERSION } from '../core/manifest-validate.mjs';

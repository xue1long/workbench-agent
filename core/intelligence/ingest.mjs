// Level 6 Task 2: idempotent, versioning ingestion.
//
// Dedupe by canonical URL / DOI / repository identity + content hash. An
// unchanged re-ingestion is a no-op (no new rows). A changed re-ingestion
// creates a new version while the old extraction rows remain readable.

import { createHash } from 'node:crypto';
import { storeContent, sourceById } from './sources.mjs';

export class IngestError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'IngestError';
    this.code = code;
    if (details) this.details = details;
  }
}

const EXTRACTION_TABLE = 'intelligence_extraction';
const INGESTION_TABLE = 'intelligence_ingestion';

function sha256Text(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function dedupeKey(source) {
  if (source.doi) return `doi:${source.doi}`;
  if (source.repoIdentity) return `repo:${source.repoIdentity}`;
  return `url:${source.canonicalUrl}`;
}

function findExistingIngestion(store, dedupeKeyValue) {
  const rows = store.readRows(INGESTION_TABLE).filter((r) => r.dedupeKey === dedupeKeyValue);
  return rows.length === 0 ? null : rows[rows.length - 1];
}

function findExtractions(store, sourceId) {
  return store.readRows(EXTRACTION_TABLE).filter((r) => r.sourceId === sourceId);
}

export function ingestSource({ store, objectsRoot, source, content, extracted = null }) {
  const existing = sourceById({ store, sourceId: source.id });
  if (!existing) throw new IngestError('INGEST_SOURCE_NOT_REGISTERED', `source ${source.id} must be registered before ingestion`);
  const contentHash = typeof content === 'string' ? sha256Text(content) : null;
  const contentRow = storeContent({ store, objectsRoot, sourceId: source.id, content: content ?? '' });
  const key = dedupeKey(existing);
  const prior = findExistingIngestion(store, key);
  const priorVersion = prior?.version ?? 0;
  let status;
  if (!prior) {
    status = 'created';
  } else if (prior.contentHash === contentHash && prior.version > 0) {
    status = 'unchanged';
  } else {
    status = 'updated';
  }
  const version = status === 'created' ? 1 : status === 'updated' ? priorVersion + 1 : priorVersion;
  const at = new Date().toISOString();
  store.appendRow(INGESTION_TABLE, {
    sourceId: source.id, dedupeKey: key, contentHash, version, status,
    bodyStored: contentRow.bodyStored, ingestedAt: at,
  });
  if (status !== 'unchanged') {
    const row = {
      sourceId: source.id, version, contentHash, extracted: extracted ?? { placeholder: true },
      extractedAt: at,
    };
    store.appendRow(EXTRACTION_TABLE, row);
  }
  return {
    status,
    sourceId: source.id,
    version,
    contentHash,
    bodyStored: contentRow.bodyStored,
    previousVersion: status === 'updated' ? priorVersion : null,
  };
}

export function sourceVersions({ store, sourceId }) {
  const rows = store.readRows(INGESTION_TABLE).filter((r) => r.sourceId === sourceId);
  return rows.map((r) => ({ version: r.version, status: r.status, contentHash: r.contentHash, ingestedAt: r.ingestedAt }));
}

export function extractionAt({ store, sourceId, version }) {
  return findExtractions(store, sourceId).find((r) => r.version === version) ?? null;
}

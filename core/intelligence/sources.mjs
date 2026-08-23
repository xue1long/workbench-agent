// Level 6 Task 1: intelligence source registration with rights metadata.
//
// A source carries immutable identification (id, canonical URL, retrieval
// timestamp), provenance (tier, kind), and rights metadata (license,
// terms, retention class, retrieval permission). Full content is stored
// only when permission is granted AND license/terms are recorded AND the
// retention class permits body storage; otherwise the store keeps metadata
// and the canonical URL only.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class SourceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    if (details) this.details = details;
  }
}

const SOURCE_TABLE = 'intelligence_source';
const CONTENT_TABLE = 'intelligence_source_content';
const KINDS = new Set(['paper', 'docs', 'repo', 'release', 'benchmark']);
const RETENTION = new Set(['keep', 'expire-after-days', 'link-only']);
const PERMISSION = new Set(['granted', 'denied', 'unknown']);

function sha256Text(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function requireStore(store) {
  if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
    throw new SourceError('SOURCE_STORE_INVALID', 'intelligence sources require a StateStore');
  }
}

export function registerSource({ store, source }) {
  requireStore(store);
  if (!source || typeof source !== 'object') throw new SourceError('SOURCE_PAYLOAD_INVALID', 'source is required');
  const { id, kind, canonicalUrl, retrievedAt, tier } = source;
  if (typeof id !== 'string' || !id.trim()) throw new SourceError('SOURCE_ID_INVALID', 'source id is required');
  if (!KINDS.has(kind)) throw new SourceError('SOURCE_KIND_INVALID', `kind must be one of ${[...KINDS].join(', ')}`);
  if (typeof canonicalUrl !== 'string' || !canonicalUrl.trim()) throw new SourceError('SOURCE_URL_INVALID', 'canonicalUrl is required');
  if (typeof retrievedAt !== 'string' || Number.isNaN(Date.parse(retrievedAt))) throw new SourceError('SOURCE_RETRIEVED_AT_INVALID', 'retrievedAt must be an ISO date');
  if (![1, 2, 3, 4].includes(tier)) throw new SourceError('SOURCE_TIER_INVALID', 'tier must be 1, 2, 3 or 4');
  const license = source.license ?? null;
  const terms = source.terms ?? null;
  const retentionClass = source.retentionClass ?? 'link-only';
  const permission = source.permission ?? 'unknown';
  if (!RETENTION.has(retentionClass)) throw new SourceError('SOURCE_RETENTION_INVALID', `retentionClass must be one of ${[...RETENTION].join(', ')}`);
  if (!PERMISSION.has(permission)) throw new SourceError('SOURCE_PERMISSION_INVALID', `permission must be one of ${[...PERMISSION].join(', ')}`);
  const row = {
    id, kind, canonicalUrl, retrievedAt, tier,
    license, terms, retentionClass, permission,
    doi: source.doi ?? null,
    repoIdentity: source.repoIdentity ?? null,
    registeredAt: new Date().toISOString(),
  };
  // canonicalUrl is immutable: refuse if a different URL was already recorded for this id.
  const existing = sourceById({ store, sourceId: id });
  if (existing && existing.canonicalUrl !== canonicalUrl) {
    throw new SourceError('SOURCE_URL_IMMUTABLE', `source ${id} canonicalUrl is immutable; recorded ${existing.canonicalUrl}, new ${canonicalUrl}`);
  }
  store.appendRow(SOURCE_TABLE, row);
  return { ...row };
}

export function storeContent({ store, objectsRoot, sourceId, content }) {
  requireStore(store);
  const src = sourceById({ store, sourceId });
  if (!src) throw new SourceError('SOURCE_NOT_FOUND', `source ${sourceId} not found`);
  const canStoreBody = src.permission === 'granted' && Boolean(src.license) && Boolean(src.terms) && src.retentionClass !== 'link-only';
  const metadata = {
    sourceId,
    bodyStored: false,
    permission: src.permission,
    retentionClass: src.retentionClass,
    reason: canStoreBody ? null : 'rights metadata missing or link-only',
  };
  if (!canStoreBody) {
    store.appendRow(CONTENT_TABLE, metadata);
    return metadata;
  }
  if (typeof content !== 'string') {
    throw new SourceError('SOURCE_CONTENT_INVALID', 'content must be a string when body storage is allowed');
  }
  const contentHash = sha256Text(content);
  const root = objectsRoot ? path.resolve(objectsRoot) : path.resolve(process.cwd(), '.workbench', 'intelligence', 'objects');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, contentHash), content, 'utf8');
  const row = { sourceId, bodyStored: true, contentHash, byteCount: Buffer.byteLength(content, 'utf8'), objectPath: path.join(root, contentHash), storedAt: new Date().toISOString() };
  store.appendRow(CONTENT_TABLE, row);
  return { ...row };
}

export function sourceById({ store, sourceId }) {
  requireStore(store);
  const rows = store.readRows(SOURCE_TABLE).filter((r) => r.id === sourceId);
  return rows.length === 0 ? null : rows[rows.length - 1];
}

export function listSources({ store, tier = null } = {}) {
  requireStore(store);
  const rows = store.readRows(SOURCE_TABLE);
  const latest = new Map();
  for (const row of rows) latest.set(row.id, row);
  const list = [...latest.values()];
  return tier == null ? list : list.filter((r) => r.tier === tier);
}

export const SOURCE_KINDS = [...KINDS];
export const RETENTION_CLASSES = [...RETENTION];
export const PERMISSION_VALUES = [...PERMISSION];

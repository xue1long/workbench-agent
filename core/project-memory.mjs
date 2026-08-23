// Level 3 Task 9: durable project memory.
//
// Project memory stores ONLY reviewed decisions and verifier-backed
// evidence. A raw Agent `EvidenceClaim` (no verifier_version) is rejected —
// the same trust boundary as the orchestrator: agent output is never trusted
// memory. The index is append-only; corrections append superseding rows.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class ProjectMemoryError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProjectMemoryError';
    this.code = code;
    if (details) this.details = details;
  }
}

const MEMORY_TABLE = 'project_memory';
const TRUSTED_EVIDENCE_KINDS = new Set(['test', 'rule', 'scope', 'diff']);
const DECISION_KINDS = new Set(['decision']);

function sha256Text(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class ProjectMemory {
  constructor({ store, objectsRoot = null }) {
    if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
      throw new ProjectMemoryError('PROJECT_MEMORY_STORE_INVALID', 'createProjectMemory requires a StateStore');
    }
    this._store = store;
    this._objectsRoot = objectsRoot
      ? path.resolve(objectsRoot)
      : path.resolve(process.cwd(), '.workbench', 'memory', 'objects');
  }

  _objectPath(hash) {
    return path.join(this._objectsRoot, hash);
  }

  _activeRows() {
    const rows = this._store.readRows(MEMORY_TABLE);
    const byKey = new Map();
    for (const row of rows) {
      const key = `${row.type}:${row.source ?? ''}`;
      const prev = byKey.get(key);
      if (!prev || row._at >= prev._at) byKey.set(key, row);
    }
    const out = [];
    for (const row of byKey.values()) {
      if (row.status !== 'SUPERSEDED' && row.status !== 'DELETED') out.push(row);
    }
    return out;
  }

  _writeRow(row, content) {
    const contentHash = sha256Text(content);
    const objectFile = this._objectPath(contentHash);
    if (!fs.existsSync(objectFile)) {
      fs.mkdirSync(this._objectsRoot, { recursive: true });
      fs.writeFileSync(objectFile, content, 'utf8');
    }
    const active = this._activeRows().find((r) => r.type === row.type && r.source === row.source);
    const full = {
      ...row,
      contentHash,
      byteCount: Buffer.byteLength(content, 'utf8'),
      status: 'ACTIVE',
      supersedes: active ? active._id : null,
    };
    const line = this._store.appendRow(MEMORY_TABLE, full);
    const parsed = JSON.parse(line);
    return { _id: parsed._id, ...full, objectPath: this._objectPath(contentHash) };
  }

  saveDecision({ runId, decision }) {
    if (!decision || typeof decision !== 'object') {
      throw new ProjectMemoryError('PROJECT_MEMORY_DECISION_INVALID', 'decision must be an object');
    }
    if (!DECISION_KINDS.has(decision.kind)) {
      throw new ProjectMemoryError('PROJECT_MEMORY_DECISION_KIND_INVALID', `decision.kind must be 'decision'`);
    }
    if (decision.reviewed !== true) {
      throw new ProjectMemoryError('PROJECT_MEMORY_UNREVIEWED', 'only reviewed decisions may be stored in project memory');
    }
    if (typeof decision.reviewerEvidenceRef !== 'string' || !decision.reviewerEvidenceRef.trim()) {
      throw new ProjectMemoryError('PROJECT_MEMORY_NO_REVIEW_EVIDENCE', 'a reviewed decision must reference its reviewer evidence');
    }
    const content = typeof decision.content === 'string' ? decision.content : JSON.stringify(decision.body ?? decision, null, 2);
    return this._writeRow({
      runId,
      type: 'decision',
      kind: decision.kind,
      scope: decision.scope ?? null,
      source: decision.source ?? decision.id ?? 'decision',
      reviewerEvidenceRef: decision.reviewerEvidenceRef,
      verifierVersion: decision.verifierVersion ?? null,
      evidenceKind: decision.evidenceKind ?? 'review',
      metadata: decision.metadata ?? {},
    }, content);
  }

  saveVerifiedArtifact({ runId, artifact }) {
    if (!artifact || typeof artifact !== 'object') {
      throw new ProjectMemoryError('PROJECT_MEMORY_ARTIFACT_INVALID', 'artifact must be an object');
    }
    if (typeof artifact.verifierVersion !== 'string' || !artifact.verifierVersion.trim()) {
      throw new ProjectMemoryError('PROJECT_MEMORY_UNVERIFIED', 'artifacts without a verifierVersion are untrusted and cannot enter project memory');
    }
    if (!TRUSTED_EVIDENCE_KINDS.has(artifact.evidenceKind)) {
      throw new ProjectMemoryError('PROJECT_MEMORY_EVIDENCE_KIND_INVALID', `evidenceKind must be one of ${[...TRUSTED_EVIDENCE_KINDS].join(', ')}`);
    }
    const content = typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.body ?? artifact, null, 2);
    return this._writeRow({
      runId,
      type: 'artifact',
      kind: artifact.kind ?? 'artifact',
      scope: artifact.scope ?? null,
      source: artifact.source ?? artifact.id ?? 'artifact',
      reviewerEvidenceRef: artifact.reviewerEvidenceRef ?? null,
      verifierVersion: artifact.verifierVersion,
      evidenceKind: artifact.evidenceKind,
      metadata: artifact.metadata ?? {},
    }, content);
  }

  query({ scope = null, kind = null } = {}) {
    let rows = this._activeRows();
    if (scope) {
      const s = scope.replace(/\/+$/, '');
      rows = rows.filter((r) => (r.scope ?? '').replace(/\/+$/, '') === s || (r.scope ?? '').startsWith(`${s}/`));
    }
    if (kind) rows = rows.filter((r) => r.kind === kind || r.type === kind);
    return rows;
  }

  memoryIndex({ scope = null } = {}) {
    const rows = this.query({ scope });
    const index = {};
    for (const row of rows) {
      index[row.source] = {
        type: row.type,
        kind: row.kind,
        scope: row.scope,
        contentHash: row.contentHash,
        verifierVersion: row.verifierVersion,
        evidenceKind: row.evidenceKind,
        reviewed: row.type === 'decision' ? row.reviewerEvidenceRef != null : undefined,
      };
    }
    return index;
  }

  content(row) {
    const file = this._objectPath(row.contentHash);
    if (!fs.existsSync(file)) throw new ProjectMemoryError('PROJECT_MEMORY_OBJECT_MISSING', `memory object missing for ${row.source}`);
    return fs.readFileSync(file, 'utf8');
  }
}

export function createProjectMemory(deps) {
  return new ProjectMemory(deps);
}

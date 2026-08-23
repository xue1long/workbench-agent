// Level 3 Task 6: knowledge ingestion with retention policy.
//
// Repository files (Markdown first, then code by extension allowlist) are
// ingested into a content-addressed object store. The JSONL index records
// sourcePath, contentHash, byteCount, updatedAt, scope, kind and retention —
// never the content itself. The index is append-only: corrections and
// deletions are new rows that supersede earlier ones; object files are
// removed only by purgeUnreferenced() once no active index row references
// them. A retention policy must be declared before ingesting user documents.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export class KnowledgeStoreError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'KnowledgeStoreError';
    this.code = code;
    if (details) this.details = details;
  }
}

const INDEX_TABLE = 'knowledge_index';
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.md', '.mdx', '.json', '.yaml', '.yml', '.txt']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const RETENTION_KINDS = new Set(['keep', 'expire-after-days']);

function sha256Text(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function assertValidScope(scope) {
  if (typeof scope !== 'string' || !scope.trim()) {
    throw new KnowledgeStoreError('KNOWLEDGE_SCOPE_INVALID', 'scope must be a non-empty string');
  }
  if (path.isAbsolute(scope) || scope.includes('..')) {
    throw new KnowledgeStoreError('KNOWLEDGE_SCOPE_INVALID', `scope must be a relative path without traversal, got ${JSON.stringify(scope)}`);
  }
  return scope;
}

export class KnowledgeStore {
  constructor({ store, objectsRoot = null }) {
    if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
      throw new KnowledgeStoreError('KNOWLEDGE_STORE_INVALID', 'createKnowledgeStore requires a StateStore');
    }
    this._store = store;
    this._objectsRoot = objectsRoot
      ? path.resolve(objectsRoot)
      : path.resolve(process.cwd(), '.workbench', 'knowledge', 'objects');
  }

  _activeRows() {
    // Latest row per sourcePath, ignoring rows superseded or deleted.
    const rows = this._store.readRows(INDEX_TABLE);
    const bySource = new Map();
    for (const row of rows) {
      const prev = bySource.get(row.sourcePath);
      if (!prev || row._at >= prev._at) bySource.set(row.sourcePath, row);
    }
    const out = [];
    for (const row of bySource.values()) {
      if (row.status !== 'DELETED') out.push(row);
    }
    return out;
  }

  _objectPath(hash) {
    return path.join(this._objectsRoot, hash);
  }

  ingest({ sourcePath, kind, scope, content, retention = 'keep' }) {
    if (typeof sourcePath !== 'string' || !sourcePath.trim() || path.isAbsolute(sourcePath)) {
      throw new KnowledgeStoreError('KNOWLEDGE_PATH_INVALID', 'sourcePath must be a non-empty relative path');
    }
    if (typeof content !== 'string') {
      throw new KnowledgeStoreError('KNOWLEDGE_CONTENT_INVALID', 'content must be a string');
    }
    const safeScope = assertValidScope(scope);
    if (!RETENTION_KINDS.has(retention)) {
      throw new KnowledgeStoreError('KNOWLEDGE_RETENTION_INVALID', `retention must be one of ${[...RETENTION_KINDS].join(', ')}`);
    }
    const contentHash = sha256Text(content);
    const objectFile = this._objectPath(contentHash);
    if (!fs.existsSync(objectFile)) {
      fs.mkdirSync(this._objectsRoot, { recursive: true });
      fs.writeFileSync(objectFile, content, 'utf8');
    }
    const prev = this._activeRows().find((r) => r.sourcePath === sourcePath);
    const row = {
      sourcePath,
      contentHash,
      byteCount: Buffer.byteLength(content, 'utf8'),
      updatedAt: new Date().toISOString(),
      scope: safeScope,
      kind: kind ?? guessKind(sourcePath),
      retention,
      status: 'ACTIVE',
      supersedes: prev ? prev._id : null,
    };
    const line = this._store.appendRow(INDEX_TABLE, row);
    const parsed = JSON.parse(line);
    return {
      _id: parsed._id,
      sourcePath: row.sourcePath,
      contentHash: row.contentHash,
      byteCount: row.byteCount,
      scope: row.scope,
      kind: row.kind,
      retention: row.retention,
      status: 'ACTIVE',
      objectPath: this._objectPath(row.contentHash),
    };
  }

  ingestDirectory({ dir, scope, kinds = null }) {
    if (typeof dir !== 'string' || !fs.existsSync(dir)) {
      throw new KnowledgeStoreError('KNOWLEDGE_DIR_INVALID', `ingestDirectory requires an existing dir, got ${JSON.stringify(dir)}`);
    }
    const safeScope = assertValidScope(scope);
    const root = path.resolve(dir);
    const kindFilter = kinds ? new Set(kinds) : null;
    const files = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.workbench') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    walk(root);
    // Markdown first, then code — deterministic order for the index.
    files.sort((a, b) => {
      const aMd = MARKDOWN_EXTENSIONS.has(path.extname(a));
      const bMd = MARKDOWN_EXTENSIONS.has(path.extname(b));
      if (aMd !== bMd) return aMd ? -1 : 1;
      return a.localeCompare(b);
    });
    const ingested = [];
    const skipped = [];
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) {
        skipped.push({ path: path.relative(root, file).replace(/\\/g, '/'), reason: 'unsupported extension' });
        continue;
      }
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (_) {
        skipped.push({ path: path.relative(root, file).replace(/\\/g, '/'), reason: 'not readable as utf8 text' });
        continue;
      }
      const sourcePath = path.join(safeScope, path.relative(root, file)).replace(/\\/g, '/');
      const kind = MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'code';
      if (kindFilter && !kindFilter.has(kind)) {
        skipped.push({ path: sourcePath, reason: 'kind filter' });
        continue;
      }
      ingested.push(this.ingest({ sourcePath, kind, scope: safeScope, content }));
    }
    return { ingested, skipped };
  }

  removeIndexRow({ sourcePath }) {
    const active = this._activeRows().find((r) => r.sourcePath === sourcePath);
    if (!active) return { removed: false };
    const row = {
      sourcePath,
      contentHash: active.contentHash,
      byteCount: active.byteCount,
      updatedAt: new Date().toISOString(),
      scope: active.scope,
      kind: active.kind,
      retention: active.retention,
      status: 'DELETED',
      supersedes: active._id,
    };
    this._store.appendRow(INDEX_TABLE, row);
    return { removed: true, sourcePath };
  }

  purgeUnreferenced() {
    const referenced = new Set(this._activeRows().map((r) => r.contentHash));
    const removed = [];
    let retained = 0;
    if (!fs.existsSync(this._objectsRoot)) return { removed, retained };
    for (const entry of fs.readdirSync(this._objectsRoot)) {
      if (!referenced.has(entry)) {
        try {
          fs.unlinkSync(path.join(this._objectsRoot, entry));
          removed.push(entry);
        } catch (_) { /* keep going */ }
      } else {
        retained += 1;
      }
    }
    return { removed, retained };
  }

  list({ scope } = {}) {
    const rows = this._activeRows();
    return scope ? rows.filter((r) => r.scope === scope || r.scope.startsWith(`${scope.replace(/\/$/, '')}/`)) : rows;
  }

  content(row) {
    const file = this._objectPath(row.contentHash);
    if (!fs.existsSync(file)) throw new KnowledgeStoreError('KNOWLEDGE_OBJECT_MISSING', `object file missing for ${row.sourcePath} (${row.contentHash})`);
    return fs.readFileSync(file, 'utf8');
  }
}

function guessKind(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  return MARKDOWN_EXTENSIONS.has(ext) ? 'markdown' : 'code';
}

export function createKnowledgeStore(deps) {
  return new KnowledgeStore(deps);
}

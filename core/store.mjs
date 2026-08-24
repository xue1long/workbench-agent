// State Store — durable, machine-scoped persistent state for the runtime.
//
// Spec §9: "Current State lives in the SQLite state store (machine-scoped)."
// Spec §42: "SQLite State Store" appears in the Level 1 deliverables.
//
// M4 ships the StateStore *interface* backed by JSONL files under
// `.workbench/store/<workspaceId>/<table>.jsonl`. The interface is shaped
// after SQLite (saveObservation / recordExecution / recordVerification /
// recordAudit) so a future SQLite backend can be swapped in without changing
// call sites.
//
// Why JSONL over SQLite right now:
//   * This dev box has no Visual Studio, so better-sqlite3 cannot compile
//     (Node 24 prebuilts do not exist yet on win32-x64).
//   * JSONL is append-only, durable, and zero-dependency. It satisfies
//     the machine-scoped persistence contract for M4.
//
// The on-disk format is one JSON object per line. Each table file has a
// `.meta.json` sidecar that records the schema version so we can migrate
// later. Records that fail to parse on read are skipped (so a partial
// write never blocks recovery).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const STORE_VERSION = '1';
const VALID_TABLE = /^[a-z][a-z0-9_]*$/;

export class StateStoreError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StateStoreError';
    this.code = options.code ?? 'STORE_ERROR';
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * A `StateStore` writes one JSONL file per "table" (workspace, resource,
 * execution, verification, audit). The store API is intentionally small
 * so the SQLite swap is mechanical.
 */
export class StateStore {
  constructor(options = {}) {
    this._root = options.root ? path.resolve(options.root) : path.resolve(process.cwd(), '.workbench', 'store');
    ensureDir(this._root);
    if (options.workspaceId != null) {
      this._assertValidId(options.workspaceId);
      this._workspaceId = options.workspaceId;
      this._dir = path.join(this._root, this._workspaceId);
      ensureDir(this._dir);
      this._writeMeta();
    }
  }
  static open(workspaceId, options = {}) {
    return new StateStore({ ...options, workspaceId });
  }
  _assertValidId(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new StateStoreError(`workspaceId "${id}" is invalid`, { code: 'STORE_BAD_ID' });
    }
  }
  _writeMeta() {
    const meta = { version: STORE_VERSION, openedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(this._dir, '.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }
  _tablePath(table) {
    if (!VALID_TABLE.test(table)) {
      throw new StateStoreError(`table name "${table}" is invalid`, { code: 'STORE_BAD_TABLE' });
    }
    return path.join(this._dir, `${table}.jsonl`);
  }
  _append(table, record) {
    const target = this._tablePath(table);
    const line = JSON.stringify({ ...record, _id: record._id ?? randomUUID(), _at: record._at ?? new Date().toISOString() }) + '\n';
    fs.appendFileSync(target, line, 'utf8');
    return line;
  }
  _readAll(table) {
    const target = this._tablePath(table);
    if (!fs.existsSync(target)) return [];
    const raw = fs.readFileSync(target, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (_) {
        // Skip partial / corrupt lines; never crash recovery.
      }
    }
    return out;
  }

  // ----- generic rows (Level 3 projections) ------------------------------
  // Pipeline artifacts, pipeline stages, knowledge index and project memory
  // all ride the same JSONL projection layer. Rows are append-only.
  appendRow(table, record) {
    return this._append(table, record);
  }
  readRows(table) {
    return this._readAll(table);
  }

  // ----- workspace --------------------------------------------------------
  saveWorkspace({ id, manifestVersion, manifestPath }) {
    this._assertValidId(id);
    return this._append('workspace', { id, manifestVersion, manifestPath });
  }
  listWorkspaces() {
    if (this._workspaceId) return this._readAll('workspace');
    // Aggregate across all workspaces
    if (!fs.existsSync(this._root)) return [];
    const out = [];
    for (const entry of fs.readdirSync(this._root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this._root, entry.name, 'workspace.jsonl');
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (_) {}
      }
    }
    return out;
  }

  // ----- resource / observation -----------------------------------------
  saveObservation({ resource, version = null, status, details = {} }) {
    return this._append('resource', { resource, version, status, details });
  }
  listObservations(resource = null) {
    const all = this._readAll('resource');
    return resource ? all.filter((r) => r.resource === resource) : all;
  }

  // ----- execution -------------------------------------------------------
  recordExecution({ plan, report, mode }) {
    return this._append('execution', {
      planWorkspace: plan?.workspace ?? null,
      planSteps: plan?.steps ?? [],
      summary: report?.summary ?? {},
      dryRun: report?.dryRun ?? null,
      changed: report?.changed ?? null,
      mode,
    });
  }
  listExecutions() { return this._readAll('execution'); }

  // ----- verification ----------------------------------------------------
  recordVerification({ report, mode }) {
    return this._append('verification', { report, mode });
  }
  listVerifications() { return this._readAll('verification'); }

  // ----- audit passthrough (AuditLog calls these) -----------------------
  recordAudit(event) { return this._append('audit', event); }
  /**
   * List audit rows. The no-arg form preserves historical compatibility.
   * Filters are optional and combined with AND semantics; ``runId`` and
   * ``type`` match against the record's top-level fields of the same name.
   */
  listAudit({ runId, type } = {}) {
    const rows = this._readAll('audit');
    return rows.filter((row) => {
      if (runId !== undefined && row.runId !== runId) return false;
      if (type !== undefined) {
        const rowType = row.type ?? row.kind;
        if (rowType !== type) return false;
      }
      return true;
    });
  }
}

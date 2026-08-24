// Level 2 Task 7: DevFlow Runtime adapter.
//
// The adapter wraps the stable ``devflow-runtime --workspace <repo>`` CLI
// (status / run / recover). It refuses to spawn Runtime without an approved
// receipt and parses the bounded JSON output. Invalid EventStore integrity
// or uncertain recovery maps to ``QUARANTINED``; only valid integrity plus
// ``finish`` may pass through to the caller as ``COMPLETED`` (the mapping
// lives in the orchestrator; this adapter returns the parsed result).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { registerAdapter } from '../core/adapters.mjs';

export class DevflowRuntimeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'DevflowRuntimeError';
    this.code = code;
    if (details) this.details = details;
  }
}

function defaultRunner(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), { shell: false, windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    const MAX_BYTES = 16 * 1024 * 1024;
    proc.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BYTES) {
        proc.kill();
        reject(new DevflowRuntimeError('RUNTIME_OUTPUT_TOO_LARGE', `Runtime stdout exceeded ${MAX_BYTES} bytes`));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

// Minimal YAML serializer for the simple shape Runtime accepts:
//   id, version, requirements: [string], acceptances: [{id, verifier_ref, required}],
//   constraints: [string], arch_rules: [...]
// Anything beyond this falls back to JSON to keep the adapter functional.
function intentToYaml(intent) {
  const lines = [];
  lines.push(`id: ${yamlScalar(intent.id ?? 'intent')}`);
  lines.push(`version: ${yamlScalar(intent.version ?? '1.0.0')}`);
  if (Array.isArray(intent.requirements) && intent.requirements.length > 0) {
    lines.push('requirements:');
    for (const r of intent.requirements) lines.push(`  - ${yamlScalar(String(r))}`);
  } else {
    lines.push('requirements: []');
  }
  if (Array.isArray(intent.acceptances) && intent.acceptances.length > 0) {
    lines.push('acceptances:');
    for (const a of intent.acceptances) {
      lines.push(`  - id: ${yamlScalar(a.id ?? 'acc')}`);
      lines.push(`    verifier_ref: ${yamlScalar(a.verifier_ref ?? 'diff')}`);
      lines.push(`    required: ${a.required === false ? 'false' : 'true'}`);
    }
  } else {
    lines.push('acceptances: []');
  }
  if (Array.isArray(intent.constraints)) {
    lines.push('constraints: []');
  }
  return lines.join('\n') + '\n';
}

function yamlScalar(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_.\-/:]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new DevflowRuntimeError('RUNTIME_OUTPUT_EMPTY', 'Runtime emitted empty stdout');
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new DevflowRuntimeError('RUNTIME_OUTPUT_INVALID', `Runtime output is not valid JSON: ${err.message}`);
  }
}

function normalizeApproval(approval) {
  if (!approval || typeof approval !== 'object') {
    throw new DevflowRuntimeError('RUNTIME_NOT_APPROVED', 'approval receipt is required');
  }
  if (approval.approved !== true) {
    throw new DevflowRuntimeError('RUNTIME_NOT_APPROVED', 'approval receipt must be approved === true');
  }
  if (typeof approval.changeSetSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(approval.changeSetSha256)) {
    throw new DevflowRuntimeError('RUNTIME_APPROVAL_DIGEST_MISSING', 'approval.changeSetSha256 must be a sha256 hex digest');
  }
  return approval;
}

function buildRuntimeArgs({ command, workspace, intentPath, actionPath, sessionId, reuseSession }) {
  const args = ['devflow-runtime', '--workspace', workspace, command];
  if (intentPath) args.push('--intent', intentPath);
  if (actionPath) args.push('--action', actionPath);
  // Only forward --session when the caller is explicitly reusing an
  // existing session. The default Action flow lets Runtime start a new
  // session tied to the supplied Intent.
  if (reuseSession && sessionId) args.push('--session', sessionId);
  return args;
}

function buildActionPayload({ intent, changeSet, approval, sessionId }) {
  return {
    id: `act-${randomUUID().slice(0, 8)}`,
    kind: 'file_edit',
    actor: approval.actor ?? 'workbench',
    target_paths: changeSet.changedFiles,
    payload: {
      multi_file: {
        edits: changeSet.edits.map((e) => ({
          path: e.path,
          patch: e.content,
          expected_digest: e.expectedDigest ?? '',
        })),
      },
    },
    intent_version: intent.version,
    policy_version: '1.0.0',
    state_revision: 0,
    idempotency_key: approval.changeSetSha256,
    session_id: sessionId,
    change_set_sha256: changeSet.patchSha256,
  };
}

export class DevflowRuntimeAdapter {
  constructor(options = {}) {
    this._runner = options.runner ?? defaultRunner;
    this._tempRoot = options.tempRoot ?? null;
    this._executable = options.executable ?? 'devflow-runtime';
  }

  async status({ workspace }) {
    if (typeof workspace !== 'string' || !workspace.trim()) {
      throw new DevflowRuntimeError('RUNTIME_WORKSPACE_INVALID', 'workspace is required');
    }
    const args = [this._executable, '--workspace', workspace, 'status'];
    const result = await this._runner(args, { shell: false });
    if (result.exitCode !== 0) {
      throw new DevflowRuntimeError('RUNTIME_STATUS_FAILED', `devflow-runtime status exited ${result.exitCode}: ${result.stderr}`);
    }
    return parseJsonOutput(result.stdout);
  }

  async run({ workspace, intent, changeSet, sessionId, approval, reuseSession = false }) {
    if (typeof workspace !== 'string' || !workspace.trim()) {
      throw new DevflowRuntimeError('RUNTIME_WORKSPACE_INVALID', 'workspace is required');
    }
    if (!changeSet || !Array.isArray(changeSet.edits) || changeSet.edits.length === 0) {
      throw new DevflowRuntimeError('RUNTIME_NO_EDITS', 'changeSet must contain at least one edit');
    }
    const normalizedApproval = normalizeApproval(approval);
    if (normalizedApproval.changeSetSha256 !== changeSet.patchSha256) {
      throw new DevflowRuntimeError('RUNTIME_APPROVAL_DIGEST_MISMATCH', 'approval.changeSetSha256 must equal changeSet.patchSha256');
    }
    const tempRoot = this._tempRoot ?? path.join(workspace, '.workbench', 'runtime-input');
    fs.mkdirSync(tempRoot, { recursive: true });
    const intentPath = path.join(tempRoot, `intent-${randomUUID().slice(0, 8)}.yaml`);
    const actionPath = path.join(tempRoot, `action-${randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(intentPath, intentToYaml(intent ?? { id: 'intent', version: '1.0.0' }), 'utf8');
    const action = buildActionPayload({ intent, changeSet, approval: normalizedApproval, sessionId });
    fs.writeFileSync(actionPath, JSON.stringify(action, null, 2), 'utf8');
    try {
      const args = buildRuntimeArgs({ command: 'run', workspace, intentPath, actionPath, sessionId, reuseSession });
      const result = await this._runner(args, { shell: false });
      if (result.exitCode !== 0) {
        throw new DevflowRuntimeError('RUNTIME_RUN_FAILED', `devflow-runtime run exited ${result.exitCode}: ${result.stderr}`);
      }
      const parsed = parseJsonOutput(result.stdout);
      const integrity = parsed.event_store_integrity ?? parsed.eventStoreIntegrity ?? { valid: false, error: 'missing' };
      const decision = parsed.decision ?? { kind: 'halt', reason: 'no decision in Runtime output' };
      const validIntegrity = integrity?.valid === true;
      const finalStatus = validIntegrity && decision.kind === 'finish' ? 'COMPLETED' : (validIntegrity ? 'AWAITING_APPROVAL' : 'QUARANTINED');
      return {
        sessionId: parsed.session?.id ?? sessionId,
        stateRevision: parsed.state_revision ?? 0,
        actionStatus: parsed.status ?? 'unknown',
        blockingReasons: parsed.blocking_reasons ?? [],
        evidenceIds: parsed.evidence_ids ?? [],
        trustedEvidenceIds: parsed.evidence_ids ?? [],
        decision,
        eventStoreIntegrity: integrity,
        finalStatus,
      };
    } finally {
      try { fs.unlinkSync(intentPath); } catch (_) {}
      try { fs.unlinkSync(actionPath); } catch (_) {}
    }
  }

  async recover({ workspace, sessionId }) {
    if (typeof workspace !== 'string' || !workspace.trim()) {
      throw new DevflowRuntimeError('RUNTIME_WORKSPACE_INVALID', 'workspace is required');
    }
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new DevflowRuntimeError('RUNTIME_SESSION_MISSING', 'sessionId is required for recover');
    }
    const args = [this._executable, '--workspace', workspace, 'recover', '--session', sessionId];
    const result = await this._runner(args, { shell: false });
    if (result.exitCode !== 0) {
      throw new DevflowRuntimeError('RUNTIME_RECOVER_FAILED', `devflow-runtime recover exited ${result.exitCode}: ${result.stderr}`);
    }
    const parsed = parseJsonOutput(result.stdout);
    const integrity = parsed.event_store_integrity ?? parsed.eventStoreIntegrity ?? { valid: false, error: 'missing' };
    return {
      sessionId: parsed.session_id ?? sessionId,
      status: parsed.status ?? 'unknown',
      journalEntries: parsed.journal_entries ?? [],
      stateRevision: parsed.state_revision ?? 0,
      reason: parsed.reason ?? '',
      eventStoreIntegrity: integrity,
      finalStatus: integrity?.valid === true ? 'COMPLETED' : 'QUARANTINED',
    };
  }
}

registerAdapter({ id: 'devflow-runtime', kind: 'tool', factory: (opts = {}) => new DevflowRuntimeAdapter(opts) });

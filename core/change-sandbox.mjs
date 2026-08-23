// Level 2 Task 7: source-change sandbox.
//
// createChangeSandbox prepares a detached ``git worktree`` rooted at a fresh
// directory under the configured tempRoot. collectChangeSet walks the
// sandbox's diff against the base commit, rejects binary / rename /
// deletion / out-of-scope paths and any candidate touching more than five
// files, then materialises each accepted path into an immutable edit record
// carrying the complete new UTF-8 text. Patch content bytes never enter a
// Workbench event; only sha256 hashes, paths, changeType and byte counts do.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class ChangeSandboxError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ChangeSandboxError';
    this.code = code;
    if (details) this.details = details;
  }
}

const MAX_FILES = 5;
const ALLOWED_CHANGE_TYPES = new Set(['create', 'replace']);

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new ChangeSandboxError('CHANGE_SET_GIT_ERROR', `git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function gitRevParse(cwd, ref) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['rev-parse', '--verify', ref], { cwd, shell: false, windowsHide: true });
    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new ChangeSandboxError('CHANGE_SET_GIT_REF', `git ref ${ref} not found in ${cwd}`));
      else resolve(stdout.trim());
    });
  });
}

function safeResolve(root, target) {
  const resolved = path.resolve(root, target);
  const rootResolved = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootResolved)) return null;
  return resolved;
}

export async function createChangeSandbox({ repoRoot, runId, tempRoot, baseCommit = 'HEAD' }) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    throw new ChangeSandboxError('CHANGE_SET_REPO_MISSING', 'repoRoot is required');
  }
  if (typeof runId !== 'string' || !runId.trim()) {
    throw new ChangeSandboxError('CHANGE_SET_RUN_ID_MISSING', 'runId is required');
  }
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    throw new ChangeSandboxError('CHANGE_SET_NOT_GIT', `repoRoot ${repoRoot} is not a Git working copy`);
  }
  const resolvedBase = await gitRevParse(repoRoot, baseCommit);
  const root = tempRoot ? path.resolve(tempRoot) : path.join(repoRoot, '.workbench', 'sandboxes');
  fs.mkdirSync(root, { recursive: true });
  const sandboxPath = path.join(root, `sandbox-${runId}-${randomUUID().slice(0, 8)}`);
  await runGit(repoRoot, ['worktree', 'add', '--detach', sandboxPath, resolvedBase]);
  return {
    repoRoot: path.resolve(repoRoot),
    sandboxPath,
    runId,
    baseCommit: resolvedBase,
    async cleanup() {
      try {
        await runGit(repoRoot, ['worktree', 'remove', '--force', sandboxPath]);
      } catch (_) {
        try { fs.rmSync(sandboxPath, { recursive: true, force: true }); } catch (_) {}
      }
    },
  };
}

function looksBinary(buffer) {
  // Conservative UTF-8 heuristic: null byte or > 25% non-text bytes.
  let suspicious = 0;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) suspicious += 1;
  }
  return buffer.length > 0 && suspicious / sample.length > 0.25;
}

export async function collectChangeSet(sandbox, options = {}) {
  if (!sandbox || typeof sandbox !== 'object' || !sandbox.sandboxPath) {
    throw new ChangeSandboxError('CHANGE_SET_SANDBOX_INVALID', 'sandbox must be a sandbox object');
  }
  const baseCommit = options.baseCommit ?? sandbox.baseCommit;
  if (!baseCommit) {
    throw new ChangeSandboxError('CHANGE_SET_BASE_MISSING', 'baseCommit is required');
  }
  // Index untracked and modified files inside the sandbox so the
  // candidate diff captures the full picture; this is the worker's
  // responsibility, not the orchestrator's.
  await runGit(sandbox.sandboxPath, ['add', '-A']);
  const statusProc = await runGit(sandbox.sandboxPath, ['diff', '--cached', '--name-status', baseCommit]);
  const lines = statusProc.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      runId: sandbox.runId,
      baseCommit,
      patchPath: null,
      patchSha256: createHash('sha256').update('').digest('hex'),
      changedFiles: [],
      edits: [],
      sandboxPath: sandbox.sandboxPath,
    };
  }
  if (lines.length > MAX_FILES) {
    throw new ChangeSandboxError('CHANGE_SET_FILE_LIMIT', `candidate touches ${lines.length} files; the first live slice accepts at most ${MAX_FILES}`, { limit: MAX_FILES });
  }
  const edits = [];
  const changedFiles = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const status = parts[0];
    const rawPath = parts[parts.length - 1];
    if (!rawPath) {
      throw new ChangeSandboxError('CHANGE_SET_INVALID', `unparseable diff line: ${line}`);
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      throw new ChangeSandboxError('CHANGE_SET_RENAME_FORBIDDEN', `rename/copy is not supported in Level 2 (${status})`);
    }
    if (status.startsWith('D')) {
      throw new ChangeSandboxError('CHANGE_SET_DELETE_FORBIDDEN', `deletion is not supported in Level 2 (${rawPath})`);
    }
    if (status.startsWith('B')) {
      throw new ChangeSandboxError('CHANGE_SET_BINARY_FORBIDDEN', `binary change is not supported in Level 2 (${rawPath})`);
    }
    const absPath = safeResolve(sandbox.sandboxPath, rawPath);
    if (!absPath) {
      throw new ChangeSandboxError('CHANGE_SET_PATH_ESCAPE', `path ${rawPath} escapes the sandbox`);
    }
    let contentBuffer;
    let changeType;
    try {
      contentBuffer = fs.readFileSync(absPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // status starts with A — treat as create with empty content
        contentBuffer = Buffer.alloc(0);
        changeType = 'create';
      } else {
        throw new ChangeSandboxError('CHANGE_SET_READ_FAILED', `cannot read ${absPath}: ${err.message}`);
      }
    }
    if (looksBinary(contentBuffer)) {
      throw new ChangeSandboxError('CHANGE_SET_BINARY_FORBIDDEN', `${rawPath} contains non-UTF-8 bytes`);
    }
    if (!changeType) {
      changeType = status.startsWith('A') ? 'create' : 'replace';
    }
    if (!ALLOWED_CHANGE_TYPES.has(changeType)) {
      throw new ChangeSandboxError('CHANGE_SET_CHANGE_TYPE_INVALID', `${rawPath}: unsupported changeType ${changeType}`);
    }
    const content = contentBuffer.toString('utf8');
    const sha = createHash('sha256').update(content).digest('hex');
    edits.push({
      path: rawPath,
      content,
      expectedDigest: '',
      sha256: sha,
      bytes: contentBuffer.length,
      changeType,
    });
    changedFiles.push(rawPath);
  }
  // Stable sort by path so hashes and patches are deterministic.
  edits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  changedFiles.sort();
  const patchJson = JSON.stringify(edits);
  const patchSha256 = createHash('sha256').update(patchJson).digest('hex');
  let patchPath = null;
  try {
    const patchDir = path.join(sandbox.sandboxPath, '.workbench-sandbox');
    fs.mkdirSync(patchDir, { recursive: true });
    patchPath = path.join(patchDir, 'change-set.patch');
    fs.writeFileSync(patchPath, patchJson, 'utf8');
  } catch (_) {
    patchPath = null;
  }
  return {
    runId: sandbox.runId,
    baseCommit,
    patchPath,
    patchSha256,
    changedFiles,
    edits,
    sandboxPath: sandbox.sandboxPath,
  };
}

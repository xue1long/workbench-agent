// Level 2 Task 8 / Task 9: provider-neutral process invoker shared by the
// Agent and Planner adapters. The invoker spawns the configured executable
// with literal argv (``shell: false``), binds the prompt via a temporary
// file, and returns a digest-only ``AgentResult``. Raw stdout/stderr bytes
// are never persisted; only sha256 hashes and byte counts survive the run.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export class ProcessAgentError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProcessAgentError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function digestText(text) {
  const buf = Buffer.from(text ?? '', 'utf8');
  return { sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

const ALLOWED_PLACEHOLDERS = new Set(['{promptFile}', '{outputFile}', '{cwd}']);

function resolvePlaceholders(argv, substitutions) {
  if (!Array.isArray(argv)) {
    throw new ProcessAgentError('AGENT_INVOCATION_INVALID', 'invocation.args must be an array of strings');
  }
  const out = [];
  for (const entry of argv) {
    if (typeof entry !== 'string') {
      throw new ProcessAgentError('AGENT_INVOCATION_INVALID', 'invocation.args entries must be strings');
    }
    if (entry === '{promptFile}') out.push(substitutions.promptFile);
    else if (entry === '{outputFile}') out.push(substitutions.outputFile);
    else if (entry === '{cwd}') out.push(substitutions.cwd);
    else out.push(entry);
  }
  return out;
}

function ensureWithinSandbox(sandboxPath, target) {
  if (!sandboxPath) return;
  const resolvedSandbox = path.resolve(sandboxPath);
  const resolvedTarget = path.resolve(target);
  const root = resolvedSandbox + path.sep;
  if (!resolvedTarget.startsWith(root) && resolvedTarget !== resolvedSandbox) return false;
  return true;
}

/**
 * Spawn a configured provider process and capture a digest-only result.
 * The arguments are literal argv entries; the prompt is delivered via a
 * temporary file referenced through the ``{promptFile}`` placeholder (or
 * stdin when neither placeholder nor output file is used).
 */
export async function runProcess({ executable, args, timeoutMs, cwd, env, prompt, outputFile, sandboxPath, stdinText, signal }) {
  if (typeof executable !== 'string' || !executable.trim()) {
    throw new ProcessAgentError('AGENT_INVOCATION_INVALID', 'invocation.executable must be a non-empty string');
  }
  if (!Array.isArray(args)) {
    throw new ProcessAgentError('AGENT_INVOCATION_INVALID', 'invocation.args must be an array');
  }
  if (cwd && !ensureWithinSandbox(sandboxPath, cwd)) {
    throw new ProcessAgentError('AGENT_CWD_OUTSIDE_SANDBOX', `cwd ${cwd} is outside sandbox ${sandboxPath}`);
  }
  const tmpRoot = sandboxPath ? path.join(sandboxPath, '.workbench-tmp') : path.join(os.tmpdir(), 'workbench-agent');
  fs.mkdirSync(tmpRoot, { recursive: true });
  let promptFile = null;
  if (typeof prompt === 'string') {
    promptFile = path.join(tmpRoot, `prompt-${randomUUID().slice(0, 8)}.txt`);
    fs.writeFileSync(promptFile, prompt, 'utf8');
  }
  const argv = resolvePlaceholders(args, { promptFile: promptFile ?? '', outputFile: outputFile ?? '', cwd: cwd ?? '' });
  return new Promise((resolve) => {
    const abortController = new AbortController();
    const proc = spawn(executable, argv, { shell: false, windowsHide: true, cwd, env: { ...(env ?? process.env) }, signal: abortController.signal });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    const MAX_BYTES = 8 * 1024 * 1024;
    proc.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BYTES) {
        abortController.abort();
        return;
      }
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    if (typeof stdinText === 'string' && stdinText.length > 0) {
      proc.stdin.write(stdinText);
    }
    proc.stdin.end();
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => abortController.abort(), timeoutMs)
      : null;
    const startedAt = Date.now();
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        success: false,
        exitCode: -1,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdoutDigest: digestText(stdout),
        stderrDigest: digestText(stderr),
        message: err.message,
        error: err.message,
      });
    });
    proc.on('close', (code, sig) => {
      if (timer) clearTimeout(timer);
      if (promptFile) {
        try { fs.unlinkSync(promptFile); } catch (_) {}
      }
      const durationMs = Date.now() - startedAt;
      const stdoutDigest = digestText(stdout);
      const stderrDigest = digestText(stderr);
      const success = code === 0 && !abortController.signal.aborted;
      const message = success
        ? ''
        : abortController.signal.aborted
          ? `timed out after ${timeoutMs}ms`
          : `exit ${code}${sig ? ` (signal ${sig})` : ''}`;
      resolve({
        success,
        exitCode: code,
        signal: sig,
        durationMs,
        stdoutDigest,
        stderrDigest,
        message,
      });
    });
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
  });
}

export class ProcessAgentInvoker {
  constructor(options = {}) {
    this._runner = options.runner ?? runProcess;
  }

  async invoke(agent, node, context) {
    if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string') {
      throw new ProcessAgentError('AGENT_INVALID', 'agent must be an object with id');
    }
    const invocation = agent.invocation;
    if (!invocation || typeof invocation !== 'object') {
      throw new ProcessAgentError('AGENT_INVOCATION_INVALID', `agent ${agent.id} has no invocation`);
    }
    if (invocation.shell === true) {
      throw new ProcessAgentError('AGENT_SHELL_FORBIDDEN', 'shell:true is forbidden; use literal argv');
    }
    const sandboxPath = context?.sandboxPath ?? process.cwd();
    const requestedCwd = context?.cwd ?? sandboxPath;
    const prompt = typeof context?.prompt === 'string' ? context.prompt : '';
    const startedAt = Date.now();
    const result = await this._runner({
      executable: invocation.executable,
      args: invocation.args ?? [],
      timeoutMs: invocation.timeoutMs ?? 60000,
      cwd: requestedCwd,
      env: invocation.env,
      prompt,
      sandboxPath,
      signal: context?.signal,
    });
    const durationMs = result.durationMs ?? (Date.now() - startedAt);
    return {
      success: result.success,
      exitCode: result.exitCode ?? null,
      signal: result.signal ?? null,
      durationMs,
      stdoutDigest: result.stdoutDigest ?? digestText(''),
      stderrDigest: result.stderrDigest ?? digestText(''),
      changedFiles: context?.changedFiles ?? [],
      evidenceClaims: [],
      cost: 0,
      usage: {},
      message: result.message ?? '',
    };
  }
}

export { ALLOWED_PLACEHOLDERS };

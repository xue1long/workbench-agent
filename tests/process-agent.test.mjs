// Level 2 Task 8: provider-neutral process agent invoker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ProcessAgentInvoker, ProcessAgentError } from '../adapters/process-agent.mjs';

function makeAgent(overrides = {}) {
  return {
    id: 'fixture',
    invocation: {
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      timeoutMs: 5000,
    },
    ...overrides,
  };
}

test('ProcessAgentInvoker spawns with shell:false and returns digest-only outputs', async () => {
  const invoker = new ProcessAgentInvoker({});
  const result = await invoker.invoke(makeAgent(), { id: 'n1', goal: 'noop' }, { sandboxPath: os.tmpdir(), prompt: 'noop' });
  assert.equal(result.success, true);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdoutDigest.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.message, '');
  assert.equal(result.stdoutDigest.bytes, 2);
});

test('ProcessAgentInvoker refuses a cwd outside the change sandbox', async () => {
  const invoker = new ProcessAgentInvoker({});
  await assert.rejects(
    () => invoker.invoke(makeAgent(), { id: 'n1', goal: 'noop' }, { sandboxPath: os.tmpdir(), cwd: path.resolve('..') }),
    (err) => err.code === 'AGENT_CWD_OUTSIDE_SANDBOX',
  );
});

test('ProcessAgentInvoker enforces timeout and returns a non-success result', async () => {
  const invoker = new ProcessAgentInvoker({});
  const agent = {
    id: 'slow',
    invocation: {
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 5000)'],
      timeoutMs: 100,
    },
  };
  const result = await invoker.invoke(agent, { id: 'n1', goal: 'noop' }, { sandboxPath: os.tmpdir(), prompt: 'noop' });
  assert.equal(result.success, false);
  assert.notEqual(result.exitCode, 0);
});

test('ProcessAgentInvoker rejects non-shell:false invocation overrides', async () => {
  const invoker = new ProcessAgentInvoker({});
  await assert.rejects(
    () => invoker.invoke({ id: 'bad', invocation: { executable: process.execPath, args: ['-e', '0'], shell: true } }, { id: 'n1', goal: 'noop' }, { sandboxPath: os.tmpdir() }),
    (err) => err instanceof ProcessAgentError && err.code === 'AGENT_SHELL_FORBIDDEN',
  );
});

test('ProcessAgentInvoker writes prompt via a temporary file rather than argv interpolation', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pa-prompt-'));
  try {
    const invoker = new ProcessAgentInvoker({});
    const script = `
      const fs = require('fs');
      const path = process.argv[1];
      const prompt = fs.readFileSync(path, 'utf8');
      process.stdout.write(prompt.length + ':' + prompt);
    `;
    const argsPath = path.join(tmp, 'args.txt');
    fs.writeFileSync(argsPath, 'sensitive-token-1234', 'utf8');
    const agent = {
      id: 'echo-prompt',
      invocation: {
        executable: process.execPath,
        args: ['-e', script, '{promptFile}'],
        timeoutMs: 5000,
      },
    };
    const result = await invoker.invoke(agent, { id: 'n1', goal: 'echo' }, { sandboxPath: tmp, prompt: 'sensitive-token-1234' });
    assert.equal(result.success, true);
    assert.match(result.stdoutDigest.sha256, /^[a-f0-9]{64}$/);
    // raw prompt never appears in any persisted artefact.
    assert.equal(result.evidenceClaims.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ProcessAgentInvoker rejects an executable that is not a string', async () => {
  const invoker = new ProcessAgentInvoker({});
  await assert.rejects(
    () => invoker.invoke({ id: 'bad', invocation: { executable: 42, args: [] } }, { id: 'n1', goal: 'noop' }, { sandboxPath: os.tmpdir() }),
    (err) => err.code === 'AGENT_INVOCATION_INVALID',
  );
});

test('ProcessAgentInvoker returns a structured AgentResult on non-zero exit', async () => {
  const invoker = new ProcessAgentInvoker({});
  const agent = {
    id: 'fail',
    invocation: {
      executable: process.execPath,
      args: ['-e', 'process.exit(2)'],
      timeoutMs: 5000,
    },
  };
  const result = await invoker.invoke(agent, { id: 'n1', goal: 'noop' }, { sandboxPath: os.tmpdir(), prompt: 'noop' });
  assert.equal(result.success, false);
  assert.equal(result.exitCode, 2);
});

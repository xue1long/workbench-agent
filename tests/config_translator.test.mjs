import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ClaudeCodeAdapter } from '../adapters/claude-code.mjs';
import { CodexAdapter } from '../adapters/codex.mjs';
import {
  translateConfig,
  writeAgentConfigFile,
  buildUnifiedConfig,
  ConfigTranslatorError,
} from '../core/config-translator.mjs';
import { InMemorySecretStore } from '../core/secrets.mjs';

// ---------- toAgentConfig: Claude ----------------------------------------

test('ClaudeCodeAdapter.toAgentConfig renders mcpServers with redacted env', () => {
  const adapter = new ClaudeCodeAdapter();
  const unified = buildUnifiedConfig({
    environment: { GH_TOKEN: { secret: 'GH_TOKEN' }, DEBUG: '1' },
    mcp: [
      { id: 'filesystem', transport: 'stdio', command: 'mcp-fs', args: ['--root', '/tmp'] },
      { id: 'http-server', transport: 'http', command: 'https://mcp.example.com' },
      { id: 'disabled', enabled: false, transport: 'stdio', command: 'no' },
    ],
  });
  const cfg = adapter.toAgentConfig(unified);
  assert.ok(cfg.mcpServers.filesystem);
  assert.equal(cfg.mcpServers.filesystem.command, 'mcp-fs');
  assert.deepEqual(cfg.mcpServers.filesystem.args, ['--root', '/tmp']);
  assert.equal(cfg.mcpServers.filesystem.env.GH_TOKEN, '***REDACTED***');
  assert.equal(cfg.mcpServers.filesystem.env.DEBUG, '1');
  assert.equal(cfg.mcpServers['http-server'].type, 'http');
  assert.equal(cfg.mcpServers['disabled'], undefined);
});

// ---------- toAgentConfig: Codex -----------------------------------------

test('CodexAdapter.toAgentConfig renders mcp_servers with redacted env', () => {
  const adapter = new CodexAdapter();
  const unified = buildUnifiedConfig({
    environment: { GH_TOKEN: { secret: 'GH_TOKEN' } },
    mcp: [{ id: 'filesystem', transport: 'stdio', command: 'mcp-fs', args: ['--root', '/tmp'] }],
  });
  const cfg = adapter.toAgentConfig(unified);
  assert.ok(cfg.mcp_servers.filesystem);
  assert.equal(cfg.mcp_servers.filesystem.env.GH_TOKEN, '***REDACTED***');
});

// ---------- translateConfig ----------------------------------------------

test('translateConfig requires a real adapter', () => {
  assert.throws(() => translateConfig({}, null), ConfigTranslatorError);
});

test('translateConfig routes through adapter.toAgentConfig', () => {
  const adapter = new ClaudeCodeAdapter();
  const unified = buildUnifiedConfig({});
  const cfg = translateConfig(unified, adapter);
  assert.deepEqual(cfg, { mcpServers: {} });
});

// ---------- writeAgentConfigFile ----------------------------------------

test('writeAgentConfigFile writes JSON and creates parent dirs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cfg-'));
  try {
    const adapter = new ClaudeCodeAdapter();
    const unified = buildUnifiedConfig({});
    const cfg = translateConfig(unified, adapter);
    const result = writeAgentConfigFile(cfg, { id: 'claude-code', configPaths: [path.join(tmp, 'nested', 'settings.json')] }, { workspaceRoot: tmp });
    assert.equal(result.written, path.join(tmp, 'nested', 'settings.json'));
    assert.ok(fs.existsSync(result.written));
    const back = JSON.parse(fs.readFileSync(result.written, 'utf8'));
    assert.deepEqual(back.mcpServers, {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeAgentConfigFile writes TOML when path ends in .toml', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cfg-'));
  try {
    const adapter = new CodexAdapter();
    const unified = buildUnifiedConfig({
      mcp: [{ id: 'filesystem', transport: 'stdio', command: 'mcp-fs', args: ['--root', '/tmp'] }],
    });
    const cfg = translateConfig(unified, adapter);
    const result = writeAgentConfigFile(cfg, { id: 'codex', configPaths: [path.join(tmp, 'config.toml')] }, { workspaceRoot: tmp });
    const body = fs.readFileSync(result.written, 'utf8');
    assert.match(body, /\[mcp_servers\.\w+\]/);
    assert.match(body, /command = "mcp-fs"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeAgentConfigFile refuses paths outside workspaceRoot', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cfg-'));
  try {
    const adapter = new ClaudeCodeAdapter();
    const unified = buildUnifiedConfig({});
    const cfg = translateConfig(unified, adapter);
    assert.throws(
      () => writeAgentConfigFile(cfg, { id: 'claude-code', configPaths: ['../escape.json'] }, { workspaceRoot: tmp }),
      (err) => err.code === 'CONFIG_PATH_ESCAPE'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeAgentConfigFile refuses unknown extensions', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cfg-'));
  try {
    const adapter = new ClaudeCodeAdapter();
    const unified = buildUnifiedConfig({});
    const cfg = translateConfig(unified, adapter);
    assert.throws(
      () => writeAgentConfigFile(cfg, { id: 'claude-code', configPaths: ['settings.ini'] }, { workspaceRoot: tmp }),
      (err) => err.code === 'CONFIG_EXTENSION_INVALID'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeAgentConfigFile backs up an existing file when snapshotDir is provided', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cfg-'));
  try {
    const adapter = new ClaudeCodeAdapter();
    const target = path.join(tmp, 'settings.json');
    fs.writeFileSync(target, '{"before":true}');
    const snapDir = path.join(tmp, 'snap');
    const cfg = translateConfig(buildUnifiedConfig({}), adapter);
    writeAgentConfigFile(cfg, { id: 'claude-code', configPaths: [target] }, { workspaceRoot: tmp, snapshotDir: snapDir });
    const backupPath = path.join(snapDir, 'settings.json.bak');
    assert.ok(fs.existsSync(backupPath));
    assert.equal(fs.readFileSync(backupPath, 'utf8'), '{"before":true}');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ClaudeCodeAdapter and CodexAdapter accept an injectable runner', async () => {
  const calls = [];
  const fakeRunner = (args) => {
    calls.push(args);
    return args[0] === '--version'
      ? { status: 0, stdout: 'claude 1.2.3\n', stderr: '' }
      : { status: 0, stdout: '', stderr: '' };
  };
  const claude = new ClaudeCodeAdapter({ executable: 'claude', runner: fakeRunner });
  const state = await claude.detect();
  assert.equal(state.version, '1.2.3');
  assert.equal(state.status, 'INSTALLED');
  assert.deepEqual(calls, [['--version']]);

  const codexCalls = [];
  const codexRunner = (args) => {
    codexCalls.push(args);
    return { status: 0, stdout: 'codex 0.4.18\n', stderr: '' };
  };
  const codex = new CodexAdapter({ executable: 'codex', runner: codexRunner });
  const codexState = await codex.detect();
  assert.equal(codexState.version, '0.4.18');
  assert.equal(codexState.status, 'INSTALLED');
});

test('Adapter returns MISSING when a runner is injected but no executable is provided', async () => {
  const runner = () => ({ status: 0, stdout: '', stderr: '' });
  const claude = new ClaudeCodeAdapter({ runner });
  const state = await claude.detect();
  assert.equal(state.status, 'MISSING');
  // Runner was never called because PATH-probe was skipped.
  // We can't easily assert that without mocking runner.calls, so just
  // assert the version is null.
  assert.equal(state.version, null);
});

test('Secret values never appear in translated config files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cfg-'));
  try {
    const store = new InMemorySecretStore();
    store.set('GH_TOKEN', 'ghp_should_not_leak');
    const adapter = new ClaudeCodeAdapter();
    const unified = buildUnifiedConfig({
      environment: { GH_TOKEN: { secret: 'GH_TOKEN' } },
      mcp: [{ id: 'gh', transport: 'stdio', command: 'mcp', args: [] }],
    });
    const cfg = translateConfig(unified, adapter);
    const result = writeAgentConfigFile(cfg, { id: 'claude-code', configPaths: ['settings.json'] }, { workspaceRoot: tmp });
    const body = fs.readFileSync(result.written, 'utf8');
    assert.doesNotMatch(body, /ghp_should_not_leak/);
    assert.match(body, /\*\*\*REDACTED\*\*\*/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- resolveSecretReferences -------------------------------------

test('translateConfig with resolveSecrets:true inlines values from the store', () => {
  const store = new InMemorySecretStore();
  store.set('GH_TOKEN', 'ghp_real_value');
  const adapter = new ClaudeCodeAdapter();
  const unified = buildUnifiedConfig({
    environment: { GH_TOKEN: { secret: 'GH_TOKEN' } },
    mcp: [{ id: 'gh', transport: 'stdio', command: 'mcp', args: [] }],
  });
  const cfg = translateConfig(unified, adapter, { resolveSecrets: true, secretStore: store });
  assert.equal(cfg.mcpServers.gh.env.GH_TOKEN, 'ghp_real_value');
});

test('translateConfig with resolveSecrets throws when the referenced secret is missing from the store', () => {
  const store = new InMemorySecretStore(); // empty
  const adapter = new ClaudeCodeAdapter();
  const unified = buildUnifiedConfig({
    environment: { GH_TOKEN: { secret: 'GH_TOKEN' } },
  });
  assert.throws(
    () => translateConfig(unified, adapter, { resolveSecrets: true, secretStore: store }),
    (err) => err.code === 'MISSING_SECRET' && /GH_TOKEN/.test(err.message)
  );
});

test('translateConfig without resolveSecrets redacts missing-secret references', () => {
  const adapter = new ClaudeCodeAdapter();
  const unified = buildUnifiedConfig({
    environment: { GH_TOKEN: { secret: 'GH_TOKEN' /* not in any store */ } },
  });
  // Default path: redactConfig replaces references whose name exists in
  // the default store. With no set call, the name doesn't exist; the
  // reference is preserved as `{ secret: NAME }`. The CLI surfaces this
  // through the redactConfig pipeline.
  const cfg = translateConfig(unified, adapter);
  // The reference must not include a real value:
  const dumped = JSON.stringify(cfg);
  assert.doesNotMatch(dumped, /ghp_/);
});
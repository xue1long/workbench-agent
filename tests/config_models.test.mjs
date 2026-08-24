import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemorySecretStore,
  SecretError,
  normalizeSecretReference,
} from '../core/secrets.mjs';
import {
  AgentDefinition,
  AgentRegistry,
  AgentError,
  validateAgentDefinition,
} from '../core/agents.mjs';
import {
  McpDefinition,
  McpRegistry,
  McpError,
  validateMcpDefinition,
} from '../core/mcp.mjs';
import {
  PackageDefinition,
  PackageRegistry,
  PackageError,
  validatePackageDefinition,
} from '../core/packages.mjs';

// ---------- secrets -------------------------------------------------------

test('InMemorySecretStore stores, retrieves, deletes, and reports existence', () => {
  const s = new InMemorySecretStore();
  assert.equal(s.get('TOKEN'), null);
  assert.equal(s.exists('TOKEN'), false);
  s.set('TOKEN', 'ghp_secret');
  assert.equal(s.get('TOKEN'), 'ghp_secret');
  assert.equal(s.exists('TOKEN'), true);
  assert.equal(s.delete('TOKEN'), true);
  assert.equal(s.exists('TOKEN'), false);
});

test('InMemorySecretStore rejects malformed secret names', () => {
  const s = new InMemorySecretStore();
  assert.throws(() => s.set('lowercase', 'x'), SecretError);
  assert.throws(() => s.set('HAS-DASH', 'x'), SecretError);
  assert.throws(() => s.set('1STARTS_WITH_DIGIT', 'x'), SecretError);
  assert.throws(() => s.set(42, 'x'), SecretError);
});

test('InMemorySecretStore.redactConfig replaces secret references with redacted strings', () => {
  const s = new InMemorySecretStore();
  s.set('GH_TOKEN', 'ghp_real_value');
  const cfg = {
    mcpServers: {
      github: { command: 'gh', environment: { GH_TOKEN: { secret: 'GH_TOKEN' } } },
    },
    plain: 'value',
    nested: { token: { secret: 'GH_TOKEN' }, list: [{ secret: 'GH_TOKEN' }, 'literal'] },
  };
  const out = s.redactConfig(cfg);
  assert.equal(out.mcpServers.github.environment.GH_TOKEN, '***REDACTED***');
  assert.equal(out.plain, 'value');
  assert.equal(out.nested.token, '***REDACTED***');
  assert.equal(out.nested.list[0], '***REDACTED***');
  assert.equal(out.nested.list[1], 'literal');
});

test('redactConfig never reveals secret values via JSON.stringify', () => {
  const s = new InMemorySecretStore();
  s.set('API_KEY', 'super-secret-do-not-leak');
  const cfg = { env: { API_KEY: { secret: 'API_KEY' } } };
  const out = s.redactConfig(cfg);
  const dumped = JSON.stringify(out);
  assert.doesNotMatch(dumped, /super-secret-do-not-leak/);
  assert.match(dumped, /\*\*\*REDACTED\*\*\*/);
});

test('redactConfig is cycle-safe (self-referential config terminates)', () => {
  const s = new InMemorySecretStore();
  const cfg = { mcpServers: {} };
  cfg.mcpServers.self = cfg;
  // Must not infinite-loop. Timeout isn't enforced; if it returns, success.
  const out = s.redactConfig(cfg);
  assert.equal(out.mcpServers.self, '***CYCLE***');
});

test('redactConfig preserves references whose name is not in the store', () => {
  const s = new InMemorySecretStore();
  const out = s.redactConfig({ env: { TOKEN: { secret: 'TOKEN' } } });
  // Not redacted (no value to leak), reference preserved so the call site
  // can surface a missing-secret error.
  assert.deepEqual(out.env.TOKEN, { secret: 'TOKEN' });
});

test('normalizeSecretReference accepts both bare string and { secret } shapes', () => {
  assert.deepEqual(normalizeSecretReference('FOO'), { secret: 'FOO' });
  assert.deepEqual(normalizeSecretReference({ secret: 'FOO' }), { secret: 'FOO' });
  assert.throws(() => normalizeSecretReference(null), SecretError);
  assert.throws(() => normalizeSecretReference({ token: 'x' }), SecretError);
});

// ---------- agents --------------------------------------------------------

test('AgentDefinition rejects missing/invalid id', () => {
  assert.throws(() => new AgentDefinition({ id: '' }), AgentError);
  assert.throws(() => new AgentDefinition({ id: '../etc' }), AgentError);
});

test('AgentDefinition rejects non-array capabilities', () => {
  assert.throws(() => new AgentDefinition({ id: 'x', capabilities: 'nope' }), AgentError);
});

test('AgentRegistry ships claude-code and codex as built-ins', () => {
  const r = new AgentRegistry();
  assert.ok(r.has('claude-code'));
  assert.ok(r.has('codex'));
  assert.ok(r.isKnown('claude-code'));
  assert.ok(r.isKnown('codex'));
  assert.equal(r.isKnown('mystery-agent'), false);
});

test('AgentRegistry.applyManifest merges declared entries into built-ins', () => {
  const r = new AgentRegistry();
  r.applyManifest([{ id: 'claude-code', provider: 'anthropic-test' }, { id: 'custom', provider: 'x' }]);
  assert.equal(r.get('claude-code').provider, 'anthropic-test');
  assert.ok(r.has('custom'));
});

test('AgentRegistry.applyManifest rejects malformed input', () => {
  const r = new AgentRegistry();
  assert.throws(() => r.applyManifest({ id: 'x' }), AgentError);
});

test('AgentDefinition.toResourceState produces a valid ResourceState', () => {
  const def = new AgentDefinition({ id: 'claude-code', version: '1.2.3', status: 'INSTALLED' });
  const rs = def.toResourceState();
  assert.equal(rs.resource, 'claude-code');
  assert.equal(rs.version, '1.2.3');
  assert.equal(rs.status, 'INSTALLED');
});

// ---------- mcp ------------------------------------------------------------

test('McpDefinition rejects unknown transport', () => {
  assert.throws(() => new McpDefinition({ id: 'x', transport: 'weird' }), McpError);
});

test('McpDefinition requires command for stdio transport', () => {
  assert.throws(() => new McpDefinition({ id: 'x', transport: 'stdio' }), McpError);
});

test('McpRegistry stores, lists, and applies manifest', () => {
  const r = new McpRegistry();
  r.applyManifest([{ id: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@mcp/filesystem'] }]);
  assert.ok(r.has('filesystem'));
  assert.equal(r.get('filesystem').command, 'npx');
  assert.deepEqual(r.get('filesystem').args, ['-y', '@mcp/filesystem']);
});

test('McpRegistry.delete returns true for existing entries and false for missing', () => {
  const r = new McpRegistry();
  r.applyManifest([{ id: 'fs', transport: 'stdio', command: 'mcp' }]);
  assert.equal(r.delete('fs'), true);
  assert.equal(r.has('fs'), false);
  assert.equal(r.delete('fs'), false, 'delete is idempotent on missing ids');
});

test('McpRegistry.list() returns an empty array for an empty registry', () => {
  assert.deepEqual(new McpRegistry().list(), []);
});

test('InMemorySecretStore.entries() yields names only, never values', () => {
  const s = new InMemorySecretStore();
  s.set('GH_TOKEN', 'ghp_real_value');
  const names = [...s.entries()];
  assert.deepEqual(names, ['GH_TOKEN']);
  assert.equal(typeof names[0], 'string');
});

test('PackageRegistry.applyManifest rejects non-array input', () => {
  assert.throws(() => new PackageRegistry().applyManifest({ id: 'x' }), PackageError);
});

test('PackageDefinition.toJSON returns the canonical shape', () => {
  const p = new PackageDefinition({ id: 's', type: 'skill', version: '1.0.0' });
  assert.deepEqual(p.toJSON(), {
    id: 's',
    type: 'skill',
    version: '1.0.0',
    source: null,
    dependencies: [],
    permissions: {},
    compatible_agents: [],
  });
});

test('McpDefinition.toJSON round-trips a definition', () => {
  const m = new McpDefinition({ id: 'http-server', transport: 'http' });
  const json = m.toJSON();
  assert.deepEqual(json, { id: 'http-server', enabled: true, transport: 'http', command: null, args: [], environment: {} });
});

// ---------- packages ------------------------------------------------------

test('PackageDefinition rejects unknown types', () => {
  assert.throws(() => new PackageDefinition({ id: 'x', type: 'unknown' }), PackageError);
});

test('PackageRegistry stores and lists packages', () => {
  const r = new PackageRegistry();
  r.applyManifest([
    { id: 'pkg-skill-a', type: 'skill', version: '1.0.0' },
    { id: 'pkg-mcp-a', type: 'mcp', version: '1.0.0' },
  ]);
  assert.equal(r.list().length, 2);
  assert.ok(r.has('pkg-skill-a'));
});

// ---------- secret-value never appears in any artifact --------------------

test('Secret values never leak through Agent/MCP/Package JSON output', () => {
  const s = new InMemorySecretStore();
  s.set('GH_TOKEN', 'ghp_should_not_leak');
  const agent = new AgentDefinition({ id: 'claude-code', version: '1.0' });
  const mcp = new McpDefinition({ id: 'gh', transport: 'stdio', command: 'mcp', environment: { GH_TOKEN: { secret: 'GH_TOKEN' } } });
  const pkg = new PackageDefinition({ id: 'p', type: 'skill' });

  const dump = JSON.stringify({
    agent: agent.toJSON(),
    mcp: s.redactConfig(mcp.toJSON()),
    pkg: pkg.toJSON(),
  });
  assert.doesNotMatch(dump, /ghp_should_not_leak/);
});

// Agent model — definitions and runtime state for Claude Code, Codex, etc.
//
// Per spec §14:
//   AgentDefinition { id, name, provider, version, executable, configPaths,
//                     capabilities, status }
//
// Per spec §15 — Core keeps a Unified Configuration; per-agent configs are
// produced by the Config Translator (core/config-translator.mjs), not by
// any agent-specific code in core/.
//
// Per spec §35 Rule 1 — capability routing is Level 2 only. This module
// only persists the metadata; no selection or dispatch happens here.

import { ResourceState } from './state.mjs';

export class AgentError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = options.code ?? 'AGENT_ERROR';
    this.agentId = options.agentId ?? null;
  }
}

const VALID_ID = /^[A-Za-z0-9._-]+$/;
const VALID_RISK = new Set(['low', 'medium', 'high']);

export function validateAgentDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new AgentError('agent must be an object', { code: 'AGENT_SHAPE_ERROR' });
  }
  if (typeof def.id !== 'string' || !VALID_ID.test(def.id)) {
    throw new AgentError(`agent.id "${def.id}" is missing or has illegal characters`, {
      code: 'AGENT_FIELD_INVALID',
      agentId: def.id,
    });
  }
  if (def.provider != null && typeof def.provider !== 'string') {
    throw new AgentError('agent.provider must be a string', { code: 'AGENT_FIELD_INVALID', agentId: def.id });
  }
  if (def.capabilities != null && !Array.isArray(def.capabilities)) {
    throw new AgentError('agent.capabilities must be an array of strings', { code: 'AGENT_FIELD_INVALID', agentId: def.id });
  }
  if (def.tools != null && (!Array.isArray(def.tools) || def.tools.some((t) => typeof t !== 'string'))) {
    throw new AgentError('agent.tools must be an array of strings', { code: 'AGENT_FIELD_INVALID', agentId: def.id });
  }
  if (def.maxRisk != null && !VALID_RISK.has(def.maxRisk)) {
    throw new AgentError('agent.maxRisk must be low | medium | high', { code: 'AGENT_FIELD_INVALID', agentId: def.id });
  }
  if (def.maxContextTokens != null && (typeof def.maxContextTokens !== 'number' || def.maxContextTokens < 1)) {
    throw new AgentError('agent.maxContextTokens must be a positive number', { code: 'AGENT_FIELD_INVALID', agentId: def.id });
  }
  if (def.invocation != null && (typeof def.invocation !== 'object' || Array.isArray(def.invocation))) {
    throw new AgentError('agent.invocation must be an object', { code: 'AGENT_FIELD_INVALID', agentId: def.id });
  }
  return def;
}

export class AgentDefinition {
  constructor({
    id,
    name = null,
    provider = null,
    version = null,
    executable = null,
    configPaths = [],
    capabilities = [],
    status = 'UNKNOWN',
    tools = [],
    maxRisk = 'medium',
    maxContextTokens = 32000,
    invocation = null,
    costPerTaskUsd = null,
  } = {}) {
    validateAgentDefinition({ id, name, provider, executable, capabilities, tools, maxRisk, maxContextTokens, invocation });
    this.id = id;
    this.name = name ?? id;
    this.provider = provider;
    this.version = version;
    this.executable = executable;
    this.configPaths = Array.isArray(configPaths) ? [...configPaths] : [];
    this.capabilities = Array.isArray(capabilities) ? [...capabilities] : [];
    this.tools = Array.isArray(tools) ? [...tools] : [];
    this.maxRisk = VALID_RISK.has(maxRisk) ? maxRisk : 'medium';
    this.maxContextTokens = typeof maxContextTokens === 'number' && maxContextTokens > 0 ? maxContextTokens : 32000;
    this.invocation = invocation && typeof invocation === 'object' ? { ...invocation } : null;
    this.costPerTaskUsd = typeof costPerTaskUsd === 'number' ? costPerTaskUsd : null;
    this.status = status; // UNKNOWN | MISSING | INSTALLED | OUTDATED | ERROR | DISABLED
  }
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      version: this.version,
      executable: this.executable,
      configPaths: [...this.configPaths],
      capabilities: [...this.capabilities],
      tools: [...this.tools],
      maxRisk: this.maxRisk,
      maxContextTokens: this.maxContextTokens,
      invocation: this.invocation,
      costPerTaskUsd: this.costPerTaskUsd,
      status: this.status,
    };
  }
  /**
   * Convert to a `ResourceState` for the diff/plan engine. Used by the
   * Apply Runtime so it can route agent steps through the same apply
   * engine as environment steps.
   */
  toResourceState() {
    return new ResourceState({
      resource: this.id,
      version: this.version ?? null,
      status: this.status,
      details: { provider: this.provider, capabilities: this.capabilities },
    });
  }
}

/**
 * Registry of agent definitions. M3 ships Claude Code and Codex.
 */
export class AgentRegistry {
  constructor() {
    this._agents = new Map();
    this._builtins();
  }
  _builtins() {
    // Built-in defaults — concrete versions/configs are populated by
    // detect() at runtime. The Level 2 router relies on tools / maxRisk /
    // maxContextTokens for hard filtering and weighted scoring.
    this._agents.set('claude-code', new AgentDefinition({
      id: 'claude-code',
      provider: 'anthropic',
      executable: 'claude',
      configPaths: ['~/.claude/settings.json', '~/.claude.json'],
      capabilities: ['coding', 'debugging', 'repository_analysis'],
      tools: ['git', 'node', 'python'],
      maxRisk: 'high',
      maxContextTokens: 200000,
    }));
    this._agents.set('codex', new AgentDefinition({
      id: 'codex',
      provider: 'openai',
      executable: 'codex',
      configPaths: ['~/.codex/config.toml', '~/.codex/auth.json'],
      capabilities: ['coding', 'debugging'],
      tools: ['git', 'node'],
      maxRisk: 'medium',
      maxContextTokens: 128000,
    }));
  }
  register(agent) {
    validateAgentDefinition(agent);
    this._agents.set(agent.id, agent instanceof AgentDefinition ? agent : new AgentDefinition(agent));
  }
  get(id) { return this._agents.get(id) ?? null; }
  has(id) { return this._agents.has(id); }
  list() { return [...this._agents.values()]; }
  entries() { return [...this._agents.entries()]; }
  /**
   * Apply manifest-declared agents onto the registry. Asymmetric semantics
   * vs. McpRegistry/PackageRegistry: existing entries (builtins) are
   * *merged* — provider/executable/configPaths are patched, but status
   * is preserved. The Mcp/Package equivalents insert-or-replace.
   * Documented here so callers don't rely on hidden replacement behavior.
   */
  applyManifest(declaredAgents) {
    if (declaredAgents == null) return;
    if (!Array.isArray(declaredAgents)) {
      throw new AgentError('manifest.agents must be an array', { code: 'AGENT_BAD_MANIFEST' });
    }
    for (const decl of declaredAgents) {
      validateAgentDefinition(decl);
      const existing = this._agents.get(decl.id);
      if (existing) {
        const merged = new AgentDefinition({
          id: existing.id,
          name: decl.name ?? existing.name,
          provider: decl.provider ?? existing.provider,
          version: decl.version ?? existing.version,
          executable: decl.executable ?? existing.executable,
          configPaths: decl.configPaths ?? existing.configPaths,
          capabilities: decl.capabilities ?? existing.capabilities,
          tools: decl.tools ?? existing.tools,
          maxRisk: decl.maxRisk ?? existing.maxRisk,
          maxContextTokens: decl.maxContextTokens ?? existing.maxContextTokens,
          invocation: decl.invocation ?? existing.invocation,
          costPerTaskUsd: decl.costPerTaskUsd ?? existing.costPerTaskUsd,
          status: existing.status,
        });
        this._agents.set(merged.id, merged);
      } else {
        this.register(decl);
      }
    }
  }
  /**
   * Read-only lookup of whether `id` is one of the built-in / registered
   * agents. Derived from `_agents` so adding a new builtin only requires
   * one edit (in `_builtins`).
   */
  isKnown(id) { return this._agents.has(id); }
}

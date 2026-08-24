// MCP model — definitions and config translation glue.
//
// Per spec §16:
//   { id, enabled, transport: 'stdio'|'http', command, args, environment }
//   Workbench keeps one unified definition. The translator converts to
//   per-agent configs (Claude Code uses `mcpServers`, Codex uses a
//   different shape, etc.). MCP secrets are referenced, not inlined.

export class McpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'McpError';
    this.code = options.code ?? 'MCP_ERROR';
    this.mcpId = options.mcpId ?? null;
  }
}

const VALID_ID = /^[A-Za-z0-9._-]+$/;
const VALID_TRANSPORTS = new Set(['stdio', 'http']);

export function validateMcpDefinition(def) {
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw new McpError('mcp definition must be an object', { code: 'MCP_SHAPE_ERROR' });
  }
  if (typeof def.id !== 'string' || !VALID_ID.test(def.id)) {
    throw new McpError(`mcp.id "${def.id}" is missing or has illegal characters`, {
      code: 'MCP_FIELD_INVALID',
      mcpId: def.id,
    });
  }
  if (def.transport !== undefined && !VALID_TRANSPORTS.has(def.transport)) {
    throw new McpError(`mcp "${def.id}" transport must be stdio or http`, {
      code: 'MCP_FIELD_INVALID',
      mcpId: def.id,
    });
  }
  if (def.transport === 'stdio' && (def.command == null || typeof def.command !== 'string')) {
    throw new McpError(`mcp "${def.id}" command is required for stdio transport`, {
      code: 'MCP_FIELD_REQUIRED',
      mcpId: def.id,
    });
  }
  if (def.args != null && !Array.isArray(def.args)) {
    throw new McpError(`mcp "${def.id}" args must be an array`, {
      code: 'MCP_FIELD_INVALID',
      mcpId: def.id,
    });
  }
  if (def.environment != null && (typeof def.environment !== 'object' || Array.isArray(def.environment))) {
    throw new McpError(`mcp "${def.id}" environment must be an object`, {
      code: 'MCP_FIELD_INVALID',
      mcpId: def.id,
    });
  }
}

export class McpDefinition {
  constructor({ id, enabled = true, transport = 'stdio', command = null, args = [], environment = {} } = {}) {
    validateMcpDefinition({ id, transport, command, args, environment });
    this.id = id;
    this.enabled = enabled !== false;
    this.transport = transport;
    this.command = command;
    this.args = Array.isArray(args) ? [...args] : [];
    this.environment = environment && typeof environment === 'object' ? { ...environment } : {};
  }
  toJSON() {
    return {
      id: this.id,
      enabled: this.enabled,
      transport: this.transport,
      command: this.command,
      args: [...this.args],
      environment: { ...this.environment },
    };
  }
}

/**
 * Registry for MCP definitions. M3 reads/writes a single unified config.
 */
export class McpRegistry {
  constructor() {
    this._mcps = new Map();
  }
  register(mcp) {
    if (!(mcp instanceof McpDefinition)) mcp = new McpDefinition(mcp);
    this._mcps.set(mcp.id, mcp);
  }
  get(id) { return this._mcps.get(id) ?? null; }
  has(id) { return this._mcps.has(id); }
  delete(id) { return this._mcps.delete(id); }
  list() { return [...this._mcps.values()]; }
  applyManifest(declared) {
    if (declared == null) return;
    if (!Array.isArray(declared)) {
      throw new McpError('manifest.mcp must be an array', { code: 'MCP_BAD_MANIFEST' });
    }
    for (const def of declared) {
      validateMcpDefinition(def);
      this.register(def);
    }
  }
}

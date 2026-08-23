// Level 2 Task 6: Capability definitions and lookup helpers.
//
// Capabilities are immutable plain objects; there is no separate registry
// service or database. Built-in capabilities are derived from the existing
// AgentRegistry's mapping plus the Level 2 orchestration requirements.

export const BUILTIN_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'coding',
    category: 'development',
    description: 'general code authoring',
    requiredTools: [],
    requiredContext: { minTokens: 1000, maxTokens: 32000 },
  }),
  Object.freeze({
    id: 'backend_development',
    category: 'development',
    description: 'server-side code authoring',
    requiredTools: ['git'],
    requiredContext: { minTokens: 1000, maxTokens: 32000 },
  }),
  Object.freeze({
    id: 'frontend_development',
    category: 'development',
    description: 'browser-side code authoring',
    requiredTools: ['git'],
    requiredContext: { minTokens: 1000, maxTokens: 32000 },
  }),
  Object.freeze({
    id: 'testing',
    category: 'quality',
    description: 'test authoring and execution',
    requiredTools: ['git'],
    requiredContext: { minTokens: 1000, maxTokens: 32000 },
  }),
  Object.freeze({
    id: 'review',
    category: 'quality',
    description: 'code review and approval',
    requiredTools: ['git'],
    requiredContext: { minTokens: 1000, maxTokens: 32000 },
  }),
  Object.freeze({
    id: 'debugging',
    category: 'maintenance',
    description: 'diagnosis and bug fixes',
    requiredTools: ['git'],
    requiredContext: { minTokens: 1000, maxTokens: 32000 },
  }),
  Object.freeze({
    id: 'architecture',
    category: 'design',
    description: 'system design and architecture',
    requiredTools: ['git'],
    requiredContext: { minTokens: 2000, maxTokens: 64000 },
  }),
]);

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

export class CapabilityError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function createCapability(input) {
  if (!input || typeof input !== 'object') {
    throw new CapabilityError('CAP_INPUT_INVALID', 'capability input must be an object');
  }
  const { id, category, description, requiredTools = [], requiredContext = null } = input;
  if (typeof id !== 'string' || !id.trim()) {
    throw new CapabilityError('CAP_ID_INVALID', 'capability id must be a non-empty string');
  }
  if (typeof category !== 'string' || !category.trim()) {
    throw new CapabilityError('CAP_CATEGORY_INVALID', `capability ${id} category must be a non-empty string`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new CapabilityError('CAP_DESCRIPTION_INVALID', `capability ${id} description must be a non-empty string`);
  }
  if (!Array.isArray(requiredTools) || requiredTools.some((t) => typeof t !== 'string')) {
    throw new CapabilityError('CAP_TOOLS_INVALID', `capability ${id} requiredTools must be a string[]`);
  }
  if (requiredContext !== null && typeof requiredContext !== 'object') {
    throw new CapabilityError('CAP_CONTEXT_INVALID', `capability ${id} requiredContext must be an object or null`);
  }
  return Object.freeze({
    id,
    category,
    description,
    requiredTools: Object.freeze([...requiredTools]),
    requiredContext: requiredContext ? Object.freeze({ ...requiredContext }) : null,
  });
}

export function listCapabilities(definitions) {
  if (!Array.isArray(definitions)) {
    throw new CapabilityError('CAP_LIST_INVALID', 'definitions must be an array');
  }
  const seen = new Set();
  const out = [];
  for (const def of definitions) {
    if (!def || typeof def !== 'object' || typeof def.id !== 'string') {
      throw new CapabilityError('CAP_DEFINITION_INVALID', 'each definition must be an object with id');
    }
    if (seen.has(def.id)) {
      throw new CapabilityError('CAP_DUPLICATE', `duplicate capability id ${def.id}`);
    }
    seen.add(def.id);
    out.push(createCapability(def));
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze(out);
}

export function agentsForCapability(capabilityId, agents) {
  if (typeof capabilityId !== 'string' || !capabilityId.trim()) {
    throw new CapabilityError('CAP_QUERY_INVALID', 'capabilityId must be a non-empty string');
  }
  if (!Array.isArray(agents)) {
    throw new CapabilityError('AGENT_LIST_INVALID', 'agents must be an array');
  }
  const matches = agents
    .filter((a) => Array.isArray(a?.capabilities) && a.capabilities.includes(capabilityId))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze([...matches]);
}

export const DEFAULT_ROUTER_WEIGHTS = Object.freeze({
  capability: 0.4,
  historicalSuccess: 0.2,
  availability: 0.15,
  cost: 0.1,
  latency: 0.05,
  toolCompatibility: 0.1,
});

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function riskAllowed(agent, requiredRisk) {
  if (!requiredRisk) return true;
  const agentRisk = RISK_ORDER[agent.maxRisk ?? 'medium'] ?? 1;
  const requiredLevel = RISK_ORDER[requiredRisk] ?? 1;
  return agentRisk >= requiredLevel;
}

function contextAllowed(agent, estimatedContextTokens) {
  if (typeof estimatedContextTokens !== 'number') return true;
  const cap = agent.maxContextTokens ?? 0;
  return cap > 0 && estimatedContextTokens <= cap;
}

function budgetAllowed(agent, budget) {
  if (!budget || typeof budget !== 'object') return true;
  if (typeof budget.maxCostUsd === 'number' && typeof agent.costPerTaskUsd === 'number') {
    if (agent.costPerTaskUsd > budget.maxCostUsd) return false;
  }
  return true;
}

export function rankAgents(requirement, agents, options = {}) {
  if (!requirement || typeof requirement !== 'object') {
    throw new CapabilityError('REQ_INVALID', 'requirement must be an object');
  }
  if (!Array.isArray(agents)) {
    throw new CapabilityError('AGENT_LIST_INVALID', 'agents must be an array');
  }
  const weights = { ...DEFAULT_ROUTER_WEIGHTS, ...(options.weights ?? {}) };
  const metrics = options.metrics ?? {};
  const reasons = [];
  const availability = options.availability ?? {};
  const matched = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string') {
      throw new CapabilityError('AGENT_INVALID', 'each agent must be an object with id');
    }
    const agentReasons = [];
    if (agent.status === 'DISABLED') {
      continue;
    }
    const agentMetrics = metrics[agent.id] ?? {};
    const agentAvailability = availability[agent.id];
    if (agentAvailability !== undefined && agentAvailability <= 0) {
      continue;
    }
    if (requirement.capabilityRequired && (!Array.isArray(agent.capabilities) || !agent.capabilities.includes(requirement.capabilityRequired))) {
      continue;
    }
    if (Array.isArray(requirement.requiredTools) && requirement.requiredTools.length > 0) {
      const agentTools = new Set(agent.tools ?? []);
      const missing = requirement.requiredTools.filter((t) => !agentTools.has(t));
      if (missing.length > 0) {
        continue;
      }
      agentReasons.push(`tools:${requirement.requiredTools.join('+')}`);
    }
    if (!riskAllowed(agent, requirement.risk)) {
      continue;
    }
    if (!contextAllowed(agent, requirement.estimatedContextTokens)) {
      continue;
    }
    if (!budgetAllowed(agent, requirement.budget)) {
      continue;
    }
    const capMatch = requirement.capabilityRequired ? 1 : 0;
    const toolMatch = requirement.requiredTools?.length > 0 ? 1 : 0;
    const hist = clamp01(agentMetrics.historicalSuccess ?? 0.5);
    const avail = clamp01(agentAvailability ?? agentMetrics.availability ?? 0);
    const costScore = clamp01(1 - (agentMetrics.cost ?? 0.5));
    const latencyScore = clamp01(1 - (agentMetrics.latency ?? 0.5));
    const score =
      weights.capability * capMatch +
      weights.historicalSuccess * hist +
      weights.availability * avail +
      weights.cost * costScore +
      weights.latency * latencyScore +
      weights.toolCompatibility * toolMatch;
    agentReasons.push(`capability:${requirement.capabilityRequired ?? 'any'}`);
    if (hist !== 0.5) agentReasons.push(`historical:${hist.toFixed(2)}`);
    else agentReasons.push('historical:default');
    if (avail !== 0.5) agentReasons.push(`availability:${avail.toFixed(2)}`);
    else agentReasons.push('availability:default');
    matched.push({
      agent: { ...agent },
      score,
      reasons: agentReasons,
    });
  }
  matched.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.agent.id < b.agent.id ? -1 : a.agent.id > b.agent.id ? 1 : 0;
  });
  return Object.freeze(matched);
}

export function selectAgent(requirement, agents, options = {}) {
  const ranked = rankAgents(requirement, agents, options);
  if (ranked.length === 0) {
    throw new CapabilityError('AGENT_NONE_ELIGIBLE', 'no eligible agent for requirement', {
      capabilityRequired: requirement.capabilityRequired,
    });
  }
  return ranked[0];
}

export function deriveRouterMetrics(events, agentIds) {
  if (!Array.isArray(events)) {
    throw new CapabilityError('METRICS_EVENTS_INVALID', 'events must be an array');
  }
  if (!Array.isArray(agentIds)) {
    throw new CapabilityError('METRICS_AGENT_IDS_INVALID', 'agentIds must be an array');
  }
  const buckets = new Map();
  for (const id of agentIds) {
    buckets.set(id, { success: 0, failure: 0, cost: [], latency: [] });
  }
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const agentId = event.agentId;
    if (typeof agentId !== 'string' || !buckets.has(agentId)) continue;
    const bucket = buckets.get(agentId);
    if (event.type === 'NODE_EXECUTION_SUCCEEDED') {
      bucket.success += 1;
      if (typeof event.durationMs === 'number') bucket.latency.push(event.durationMs);
    }
    if (event.type === 'TASK_FAILED' || event.type === 'TASK_HALTED') {
      bucket.failure += 1;
    }
    if (typeof event.cost === 'number') bucket.cost.push(event.cost);
  }
  const out = {};
  for (const [id, bucket] of buckets) {
    const total = bucket.success + bucket.failure;
    const historicalSuccess = total > 0 ? bucket.success / total : 0.5;
    const avgLatency = bucket.latency.length === 0 ? 0.5 : bucket.latency.reduce((a, b) => a + b, 0) / bucket.latency.length / 1000;
    const avgCost = bucket.cost.length === 0 ? 0.5 : bucket.cost.reduce((a, b) => a + b, 0) / bucket.cost.length;
    out[id] = Object.freeze({
      historicalSuccess,
      availability: 0.5,
      cost: avgCost,
      latency: avgLatency,
    });
  }
  return Object.freeze(out);
}

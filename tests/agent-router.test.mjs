// Level 2 Task 6: deterministic capability-aware Agent routing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityError,
  DEFAULT_ROUTER_WEIGHTS,
  deriveRouterMetrics,
  rankAgents,
  selectAgent,
} from '../core/agent-router.mjs';
import { AgentRegistry } from '../core/agents.mjs';

function registryAgents() {
  return new AgentRegistry().list();
}

test('selectAgent explains a deterministic capability match', () => {
  const selected = selectAgent(
    {
      capabilityRequired: 'debugging',
      requiredTools: [],
      risk: 'low',
      budget: null,
      estimatedContextTokens: 8000,
    },
    registryAgents(),
    { availability: { 'claude-code': 1, codex: 1 } },
  );
  assert.equal(selected.agent.id, 'claude-code');
  assert.ok(selected.reasons.some((reason) => reason.includes('debugging')));
});

test('rankAgents removes unavailable agents', () => {
  const ranked = rankAgents(
    { capabilityRequired: 'coding', requiredTools: [], risk: 'low', budget: null, estimatedContextTokens: 1000 },
    registryAgents(),
    { availability: { 'claude-code': 0, codex: 1 } },
  );
  assert.deepEqual(ranked.map((r) => r.agent.id), ['codex']);
});

test('rankAgents removes agents missing required tools', () => {
  const ranked = rankAgents(
    { capabilityRequired: 'coding', requiredTools: ['python'], risk: 'low', budget: null, estimatedContextTokens: 1000 },
    registryAgents(),
    { availability: { 'claude-code': 1, codex: 1 } },
  );
  // codex lacks 'python'; claude-code has it
  assert.deepEqual(ranked.map((r) => r.agent.id), ['claude-code']);
});

test('rankAgents removes agents that cannot host the required risk level', () => {
  const ranked = rankAgents(
    { capabilityRequired: 'coding', requiredTools: [], risk: 'high', budget: null, estimatedContextTokens: 1000 },
    registryAgents(),
    { availability: { 'claude-code': 1, codex: 1 } },
  );
  // codex is maxRisk=medium, claude-code is high -> only claude-code remains
  assert.deepEqual(ranked.map((r) => r.agent.id), ['claude-code']);
});

test('rankAgents removes agents that cannot host the estimated context tokens', () => {
  const ranked = rankAgents(
    { capabilityRequired: 'coding', requiredTools: [], risk: 'low', budget: null, estimatedContextTokens: 500000 },
    registryAgents(),
    { availability: { 'claude-code': 1, codex: 1 } },
  );
  // Both agents cap below 500k tokens.
  assert.deepEqual(ranked.map((r) => r.agent.id), []);
});

test('rankAgents removes agents that exceed the per-task cost budget', () => {
  const agents = [
    { id: 'cheap', capabilities: ['coding'], costPerTaskUsd: 0.5, tools: [], maxRisk: 'low', maxContextTokens: 32000 },
    { id: 'expensive', capabilities: ['coding'], costPerTaskUsd: 5, tools: [], maxRisk: 'low', maxContextTokens: 32000 },
  ];
  const ranked = rankAgents(
    { capabilityRequired: 'coding', requiredTools: [], risk: 'low', budget: { maxCostUsd: 1 }, estimatedContextTokens: 1000 },
    agents,
    { availability: { cheap: 1, expensive: 1 } },
  );
  assert.deepEqual(ranked.map((r) => r.agent.id), ['cheap']);
});

test('rankAgents breaks ties by agent id', () => {
  const a = { id: 'alpha', capabilities: ['coding'], tools: [], maxRisk: 'low', maxContextTokens: 8000 };
  const b = { id: 'beta', capabilities: ['coding'], tools: [], maxRisk: 'low', maxContextTokens: 8000 };
  const ranked = rankAgents(
    { capabilityRequired: 'coding', requiredTools: [], risk: 'low', budget: null, estimatedContextTokens: 1000 },
    [a, b],
  );
  assert.deepEqual(ranked.map((r) => r.agent.id), ['alpha', 'beta']);
});

test('rankAgents does not mutate the input agents array', () => {
  const agents = [
    { id: 'a', capabilities: ['coding'], tools: [], maxRisk: 'low', maxContextTokens: 8000 },
  ];
  const snapshot = JSON.stringify(agents);
  rankAgents(
    { capabilityRequired: 'coding', requiredTools: [], risk: 'low', budget: null, estimatedContextTokens: 1000 },
    agents,
  );
  assert.equal(JSON.stringify(agents), snapshot);
});

test('selectAgent throws AGENT_NONE_ELIGIBLE when no agent qualifies', () => {
  assert.throws(
    () =>
      selectAgent(
        { capabilityRequired: 'coding', requiredTools: ['python3-only'], risk: 'low', budget: null, estimatedContextTokens: 1000 },
        registryAgents(),
        { availability: { 'claude-code': 1, codex: 1 } },
      ),
    (err) => err.code === 'AGENT_NONE_ELIGIBLE',
  );
});

test('deriveRouterMetrics returns neutral defaults for agents with no compatible events', () => {
  const out = deriveRouterMetrics([], ['claude-code']);
  assert.equal(out['claude-code'].historicalSuccess, 0.5);
  assert.equal(out['claude-code'].availability, 0.5);
});

test('deriveRouterMetrics computes success rate and median latency from matching events', () => {
  const events = [
    { type: 'NODE_EXECUTION_SUCCEEDED', agentId: 'claude-code', durationMs: 100 },
    { type: 'NODE_EXECUTION_SUCCEEDED', agentId: 'claude-code', durationMs: 200 },
    { type: 'TASK_FAILED', agentId: 'claude-code' },
    { type: 'NODE_EXECUTION_SUCCEEDED', agentId: 'codex', durationMs: 50 },
  ];
  const out = deriveRouterMetrics(events, ['claude-code', 'codex']);
  assert.equal(out['claude-code'].historicalSuccess, 2 / 3);
  assert.equal(out['claude-code'].latency, 0.15);
  assert.equal(out['codex'].historicalSuccess, 1);
});

test('DEFAULT_ROUTER_WEIGHTS sums to 1.0', () => {
  const total = Object.values(DEFAULT_ROUTER_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(total * 100) / 100, 1.0);
});

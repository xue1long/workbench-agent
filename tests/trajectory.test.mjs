// Level 4 Task 1: versioned trajectory projection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRun, queryTrajectory, trajectorySummary, TrajectoryError, assertFailureClass } from '../core/trajectory.mjs';

function pipelineReport(overrides = {}) {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    pipelineId: 'standard-development',
    templateVersion: '1.0.0',
    executionStatus: 'EXECUTION_SUCCEEDED',
    finalStatus: 'COMPLETED',
    cost: 12.5,
    startedAt: '2026-08-23T10:00:00.000Z',
    finishedAt: '2026-08-23T10:00:05.000Z',
    routing: { implementation: { agentId: 'fixture' } },
    artifacts: [{ contentHash: 'a'.repeat(64) }],
    evidenceClaims: [{ kind: 'test' }, { kind: 'diff' }],
    trustedEvidenceIds: ['ev-1'],
    ...overrides,
  };
}

function orchestratorReport(overrides = {}) {
  return {
    runId: 'run-2',
    taskId: 'task-2',
    executionStatus: 'FAILED',
    finalStatus: 'FAILED',
    actionStatus: 'stage_failed',
    nodes: { a: { status: 'SUCCEEDED' }, b: { status: 'FAILED' }, c: { status: 'BLOCKED' } },
    ...overrides,
  };
}

test('recordRun normalizes a pipeline report into a versioned row', () => {
  const row = recordRun({ run: pipelineReport() });
  assert.equal(row.runId, 'run-1');
  assert.equal(row.workflowId, 'standard-development');
  assert.equal(row.templateVersion, '1.0.0');
  assert.equal(row.finalStatus, 'COMPLETED');
  assert.equal(row.failureClass, 'none');
  assert.deepEqual(row.agentIds, ['fixture']);
  assert.equal(row.cost, 12.5);
  assert.equal(row.latencyMs, 5000);
  assert.deepEqual(row.artifactHashes, ['a'.repeat(64)]);
  assert.deepEqual(row.evidenceRefs, ['diff', 'test', 'trusted:ev-1']);
  assert.equal(row.projectionVersion, '1.0.0');
  assert.ok(Object.isFrozen(row));
});

test('failure classes are derived deterministically', () => {
  assert.equal(recordRun({ run: orchestratorReport() }).failureClass, 'failed-dependency');
  assert.equal(recordRun({ run: orchestratorReport({ nodes: { a: { status: 'FAILED' } } }) }).failureClass, 'stage-failed');
  assert.equal(recordRun({ run: pipelineReport({ finalStatus: 'QUARANTINED' }) }).failureClass, 'quarantined');
  assert.equal(recordRun({ run: pipelineReport({ finalStatus: 'AWAITING_APPROVAL' }) }).failureClass, 'approval');
  assert.equal(recordRun({ run: pipelineReport({ actionStatus: 'no_candidates', executionStatus: 'EXECUTION_SUCCEEDED', finalStatus: 'FAILED' }) }).failureClass, 'no-candidate');
});

test('budget/deadline decisions map to their classes', () => {
  assert.equal(recordRun({ run: pipelineReport({ decision: { kind: 'halt', reason: 'task budget exhausted' } }) }).failureClass, 'budget');
  assert.equal(recordRun({ run: pipelineReport({ decision: { kind: 'halt', reason: 'deadline passed' } }) }).failureClass, 'deadline');
});

test('recordRun rejects runs without runId', () => {
  assert.throws(() => recordRun({ run: {} }), (err) => err instanceof TrajectoryError && err.code === 'TRAJECTORY_RUN_INVALID');
});

test('queryTrajectory filters by agent, workflow, status, failureClass, cost and latency', () => {
  const rows = [
    recordRun({ run: pipelineReport({ runId: 'r1', cost: 5, latencyMs: 1000, routing: { a: { agentId: 'alice' } }, finalStatus: 'COMPLETED' }) }),
    recordRun({ run: pipelineReport({ runId: 'r2', cost: 50, latencyMs: 9000, routing: { a: { agentId: 'bob' } }, finalStatus: 'AWAITING_APPROVAL', templateVersion: '1.0.0' }) }),
    recordRun({ run: orchestratorReport({ runId: 'r3', nodes: { x: { status: 'FAILED' } } }) }),
  ];
  assert.deepEqual(queryTrajectory({ rows, agent: 'alice' }).map((r) => r.runId), ['r1']);
  assert.deepEqual(queryTrajectory({ rows, status: 'AWAITING_APPROVAL' }).map((r) => r.runId), ['r2']);
  assert.deepEqual(queryTrajectory({ rows, failureClass: 'stage-failed' }).map((r) => r.runId), ['r3']);
  assert.deepEqual(queryTrajectory({ rows, minCost: 10, maxCost: 100 }).map((r) => r.runId), ['r2']);
  assert.deepEqual(queryTrajectory({ rows, maxLatencyMs: 5000 }).map((r) => r.runId), ['r1']);
  assert.deepEqual(queryTrajectory({ rows, workflow: 'task', status: 'FAILED' }).map((r) => r.runId), ['r3']);
  assert.throws(() => queryTrajectory({ rows: 'x' }), (err) => err.code === 'TRAJECTORY_ROWS_INVALID');
});

test('trajectorySummary answers success rate, cost, latency and failure distribution', () => {
  const rows = [
    recordRun({ run: pipelineReport({ runId: 'a', cost: 10, finalStatus: 'COMPLETED', routing: { x: { agentId: 'alice' } }, startedAt: '2026-08-23T10:00:00.000Z', finishedAt: '2026-08-23T10:00:01.000Z' }) }),
    recordRun({ run: pipelineReport({ runId: 'b', cost: 30, finalStatus: 'COMPLETED', routing: { x: { agentId: 'bob' } }, startedAt: '2026-08-23T10:00:00.000Z', finishedAt: '2026-08-23T10:00:03.000Z' }) }),
    recordRun({ run: orchestratorReport({ runId: 'c', nodes: { x: { status: 'FAILED' } } }) }),
  ];
  const s = trajectorySummary(rows);
  assert.equal(s.total, 3);
  assert.equal(s.successRate, 0.667);
  assert.equal(s.avgCostUsd, 20);
  assert.equal(s.avgLatencyMs, 2000);
  assert.deepEqual(s.failureDistribution, { 'stage-failed': 1 });
  assert.deepEqual(s.byAgent, { alice: 1, bob: 1 });
  assert.deepEqual(s.byWorkflow, { 'standard-development': 2, task: 1 });
});

test('assertFailureClass rejects unknown classes', () => {
  assert.throws(() => assertFailureClass('magic'), (err) => err.code === 'TRAJECTORY_FAILURE_CLASS_INVALID');
  assert.doesNotThrow(() => assertFailureClass('quarantined'));
});

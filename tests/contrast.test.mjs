// Level 5 Task 2: contrastive trajectory comparison within a task class.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestWorstTrajectories, contrast, contrastSummary, ContrastError } from '../core/contrast.mjs';

function row(runId, workflowId, overrides = {}) {
  return {
    runId, workflowId, templateVersion: '1.0.0', finalStatus: 'COMPLETED',
    agentIds: ['alice'], cost: 5, latencyMs: 1000, evidenceRefs: ['test'],
    ...overrides,
  };
}

const score = (r) => (r.finalStatus === 'COMPLETED' ? 1 : 0) - (r.latencyMs ?? 0) / 10000;

test('best/worst are selected only within the given task class', () => {
  const rows = [
    row('a', 'standard-development', { latencyMs: 100 }),
    row('b', 'standard-development', { latencyMs: 9000, finalStatus: 'FAILED' }),
    row('c', 'task', { latencyMs: 50 }), // different class — must be ignored
  ];
  const bw = bestWorstTrajectories({ rows, taskClass: 'standard-development:1.0.0', scoreFn: score });
  assert.equal(bw.best.runId, 'a');
  assert.equal(bw.worst.runId, 'b');
  assert.ok(bw.bestScore >= bw.worstScore);
});

test('selection is deterministic and ties break by runId', () => {
  const rows = [
    row('b-tie', 'x', { latencyMs: 100 }),
    row('a-tie', 'x', { latencyMs: 100 }),
  ];
  const a = bestWorstTrajectories({ rows, taskClass: 'x:1.0.0', scoreFn: score });
  const b = bestWorstTrajectories({ rows, taskClass: 'x:1.0.0', scoreFn: score });
  assert.deepEqual(a, b);
  assert.equal(a.best.runId, 'a-tie', 'tie broken by runId asc');
});

test('a class with fewer than two rows is rejected', () => {
  assert.throws(
    () => bestWorstTrajectories({ rows: [row('only', 'x')], taskClass: 'x:1.0.0', scoreFn: score }),
    (err) => err instanceof ContrastError && err.code === 'CONTRAST_CLASS_TOO_SMALL',
  );
  assert.throws(() => bestWorstTrajectories({ rows: 'x', taskClass: 'x:1.0.0', scoreFn: score }), (err) => err.code === 'CONTRAST_ROWS_INVALID');
  assert.throws(() => bestWorstTrajectories({ rows: [], taskClass: 'x:1.0.0' }), (err) => err.code === 'CONTRAST_SCOREFN_INVALID');
});

test('contrast extracts structured differences', () => {
  const best = row('a', 'x', {
    agentIds: ['alice'], templateVersion: '2.0.0', estimatedContextTokens: 8000,
    requiredTools: ['git'], attemptsPerNode: [1, 1], latencyMs: 800, cost: 4,
  });
  const worst = row('b', 'x', {
    agentIds: ['bob'], templateVersion: '1.0.0', estimatedContextTokens: 4000,
    requiredTools: ['git', 'npm'], attemptsPerNode: [1, 3], latencyMs: 9000, cost: 12,
    failureClass: 'stage-failed',
  });
  const diffs = contrast({ best, worst });
  const fields = diffs.map((d) => d.field);
  assert.ok(fields.includes('agentChoice'));
  assert.ok(fields.includes('workflowVersion'));
  assert.ok(fields.includes('contextSize'));
  assert.ok(fields.includes('tools'));
  assert.ok(fields.includes('retries'));
  assert.ok(fields.includes('failureClass'));
  assert.ok(fields.includes('latencyMs'));
  assert.ok(fields.includes('cost'));
});

test('contrastSummary renders readable bullets', () => {
  const diffs = [
    { field: 'agentChoice', best: ['alice'], worst: ['bob'], note: 'best uses alice' },
    { field: 'latencyMs', best: 800, worst: 9000, delta: -8200 },
  ];
  const lines = contrastSummary(diffs);
  assert.ok(lines[0].includes('agent choice'));
  assert.ok(lines[1].includes('latency'));
});

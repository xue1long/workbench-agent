// Level 3 Task 1: immutable pipeline template contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { definePipeline, compilePipeline, PipelineError, pipelineTemplateVersion } from '../core/pipeline.mjs';

function sampleTemplate() {
  return definePipeline({
    id: 'standard-development',
    version: '1.0.0',
    inputs: ['requirement'],
    stages: [
      {
        id: 'analysis', name: 'Analysis',
        inputs: ['requirement'], outputs: ['analysis'],
        acceptance: [{ id: 'analysis-done', kind: 'scope', required: true }],
        owner: 'analysis',
        evidence: [{ id: 'analysis-evidence', kind: 'artifact' }],
      },
      {
        id: 'plan', name: 'Plan',
        inputs: ['analysis'], outputs: ['plan'],
        acceptance: [{ id: 'plan-done', kind: 'scope', required: true }],
        owner: 'planning',
        evidence: [],
      },
      {
        id: 'implementation', name: 'Implementation',
        inputs: ['plan'], outputs: ['implementation-artifact'],
        acceptance: [{ id: 'impl-tests', kind: 'test', required: true }],
        owner: 'implementation',
        evidence: [{ id: 'impl-ev', kind: 'test' }],
        scope: 'src/',
      },
      {
        id: 'review', name: 'Review',
        inputs: ['implementation-artifact'], outputs: ['review'],
        acceptance: [{ id: 'review-done', kind: 'architecture', required: true }],
        owner: 'reviewer',
        evidence: [{ id: 'review-ev', kind: 'review' }],
      },
    ],
  });
}

test('definePipeline returns a frozen template with id, version and stages', () => {
  const t = sampleTemplate();
  assert.equal(t.id, 'standard-development');
  assert.equal(t.version, '1.0.0');
  assert.deepEqual(t.stages.map((s) => s.id), ['analysis', 'plan', 'implementation', 'review']);
  assert.ok(Object.isFrozen(t));
  assert.ok(Object.isFrozen(t.stages));
  assert.ok(Object.isFrozen(t.stages[0]));
});

test('template is deeply frozen: mutation throws in strict mode', () => {
  const t = sampleTemplate();
  assert.throws(() => { t.stages[0].id = 'mutated'; }, TypeError);
  assert.throws(() => { t.stages.push({ id: 'x' }); }, TypeError);
  assert.throws(() => { t.id = 'mutated'; }, TypeError);
});

test('template without id is rejected', () => {
  assert.throws(
    () => definePipeline({ version: '1.0.0', stages: [] }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_ID_INVALID',
  );
});

test('template without version is rejected', () => {
  assert.throws(
    () => definePipeline({ id: 'x', stages: [] }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_VERSION_INVALID',
  );
});

test('template with no stages is rejected', () => {
  assert.throws(
    () => definePipeline({ id: 'x', version: '1.0.0', stages: [] }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_NO_STAGES',
  );
});

test('duplicate stage ids are rejected', () => {
  const base = sampleTemplate();
  const stages = [
    ...base.stages,
    { id: 'analysis', name: 'Again', inputs: [], outputs: ['x'], acceptance: [{ id: 'a', kind: 'scope', required: true }], owner: 'o', evidence: [] },
  ];
  assert.throws(
    () => definePipeline({ id: 'x', version: '1.0.0', inputs: ['requirement'], stages }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_DUPLICATE_STAGE',
  );
});

test('stage without owner is rejected', () => {
  const t = sampleTemplate();
  const stages = t.stages.map((s) => ({ ...s }));
  delete stages[1].owner;
  assert.throws(
    () => definePipeline({ id: 'x', version: '1.0.0', inputs: ['requirement'], stages }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_STAGE_NO_OWNER',
  );
});

test('stage with empty acceptance is rejected', () => {
  const t = sampleTemplate();
  const stages = t.stages.map((s) => ({ ...s }));
  stages[2].acceptance = [];
  assert.throws(
    () => definePipeline({ id: 'x', version: '1.0.0', inputs: ['requirement'], stages }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_STAGE_NO_ACCEPTANCE',
  );
});

test('acceptance with unknown verifier kind is rejected', () => {
  const t = sampleTemplate();
  const stages = t.stages.map((s) => ({ ...s }));
  stages[0].acceptance = [{ id: 'a', kind: 'magic', required: true }];
  assert.throws(
    () => definePipeline({ id: 'x', version: '1.0.0', inputs: ['requirement'], stages }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_STAGE_VERIFIER_INVALID',
  );
});

test('acceptance missing required boolean is rejected', () => {
  const t = sampleTemplate();
  const stages = t.stages.map((s) => ({ ...s }));
  stages[0].acceptance = [{ id: 'a', kind: 'scope' }];
  assert.throws(
    () => definePipeline({ id: 'x', version: '1.0.0', inputs: ['requirement'], stages }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_STAGE_ACCEPTANCE_INVALID',
  );
});

test('input referencing an unknown artifact is rejected', () => {
  const t = sampleTemplate();
  const stages = t.stages.map((s) => ({ ...s }));
  stages[2].inputs = ['does-not-exist'];
  assert.throws(
    () => definePipeline({ id: 'x', version: '1.0.0', stages }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_UNKNOWN_INPUT',
  );
});

test('input referencing a later stage output is rejected', () => {
  const t = sampleTemplate();
  const stages = t.stages.map((s) => ({ ...s }));
  stages[0].inputs = ['implementation-artifact']; // produced by a later stage
  assert.throws(
    () => definePipeline({ id: 'x', version: '1.0.0', stages }),
    (err) => err instanceof PipelineError && err.code === 'PIPELINE_UNKNOWN_INPUT',
  );
});

test('compilePipeline builds a valid TaskGraph with derived dependencies', () => {
  const t = sampleTemplate();
  const graph = compilePipeline(t, { id: 'task-1', goal: 'Add OAuth login' });
  assert.deepEqual(graph.nodeIds, ['analysis', 'plan', 'implementation', 'review']);
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  assert.deepEqual(byId.analysis.dependencies, []);
  assert.deepEqual(byId.plan.dependencies, ['analysis']);
  assert.deepEqual(byId.implementation.dependencies, ['plan']);
  assert.deepEqual(byId.review.dependencies, ['implementation']);
  assert.equal(byId.review.kind, 'review');
  assert.equal(byId.implementation.kind, 'work');
  assert.equal(byId.implementation.capabilityRequired, 'implementation');
  assert.deepEqual(byId.implementation.acceptanceCriteria, [
    { id: 'impl-tests', verifierRef: 'test', required: true },
  ]);
});

test('compilePipeline derives a deterministic node goal', () => {
  const graph = compilePipeline(sampleTemplate(), { id: 'task-1', goal: 'Add OAuth login' });
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  assert.equal(byId.analysis.goal, 'Analysis: Add OAuth login');
  assert.equal(byId.review.goal, 'Review: Add OAuth login');
});

test('compilePipeline validates the task through createTask', () => {
  assert.throws(
    () => compilePipeline(sampleTemplate(), { goal: 'missing id' }),
    (err) => err && err.code === 'TASK_ID_INVALID',
  );
});

test('structurally identical templates produce identical node definitionHashes', () => {
  const a = compilePipeline(sampleTemplate(), { id: 'task-1', goal: 'Add OAuth login' });
  const b = compilePipeline(sampleTemplate(), { id: 'task-1', goal: 'Add OAuth login' });
  const byIdA = Object.fromEntries(a.nodes.map((n) => [n.id, n.definitionHash]));
  const byIdB = Object.fromEntries(b.nodes.map((n) => [n.id, n.definitionHash]));
  assert.deepEqual(byIdA, byIdB);
  assert.equal(a.graphHash, b.graphHash);
});

test('pipelineTemplateVersion returns the version string', () => {
  assert.equal(pipelineTemplateVersion(sampleTemplate()), '1.0.0');
});

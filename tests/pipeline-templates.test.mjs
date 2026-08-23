// Level 3 Task 2: standard development pipeline template.
import test from 'node:test';
import assert from 'node:assert/strict';
import { standardDevelopmentPipeline, pipelineTemplates } from '../core/pipeline-templates.mjs';
import { compilePipeline, pipelineTemplateVersion } from '../core/pipeline.mjs';

test('standard template has the six expected stages in order', () => {
  const t = standardDevelopmentPipeline();
  assert.equal(t.id, 'standard-development');
  assert.equal(pipelineTemplateVersion(t), '1.0.0');
  assert.deepEqual(t.stages.map((s) => s.id), ['requirement', 'analysis', 'plan', 'implementation', 'test', 'review']);
  assert.deepEqual(t.stages.map((s) => s.name), ['Requirement', 'Analysis', 'Plan', 'Implementation', 'Test', 'Review']);
});

test('template is immutable', () => {
  const t = standardDevelopmentPipeline();
  assert.throws(() => { t.stages[0].id = 'mutated'; }, TypeError);
  assert.throws(() => { t.version = '9.0.0'; }, TypeError);
});

test('every stage declares inputs, outputs, acceptance, owner and evidence', () => {
  const t = standardDevelopmentPipeline();
  for (const stage of t.stages) {
    assert.ok(Array.isArray(stage.inputs), `stage ${stage.id} inputs`);
    assert.ok(stage.outputs.length >= 1, `stage ${stage.id} outputs`);
    assert.ok(stage.acceptance.length >= 1, `stage ${stage.id} acceptance`);
    assert.equal(typeof stage.owner, 'string', `stage ${stage.id} owner`);
    assert.ok(Array.isArray(stage.evidence), `stage ${stage.id} evidence`);
  }
});

test('each stage references only template inputs or earlier stage outputs', () => {
  const t = standardDevelopmentPipeline();
  const produced = new Set(['requirement']);
  for (const stage of t.stages) {
    for (const input of stage.inputs) {
      assert.ok(produced.has(input), `stage ${stage.id} input ${input} must be produced earlier`);
    }
    for (const out of stage.outputs) produced.add(out);
  }
});

test('acceptance kinds are valid Level 2 verifier refs', () => {
  const t = standardDevelopmentPipeline();
  const valid = new Set(['diff', 'scope', 'test', 'budget', 'dependency', 'architecture', 'audit']);
  for (const stage of t.stages) {
    for (const acc of stage.acceptance) {
      assert.ok(valid.has(acc.kind), `stage ${stage.id} acceptance ${acc.id} kind ${acc.kind}`);
    }
  }
});

test('compiled graph has six chained nodes ending in a review node', () => {
  const graph = compilePipeline(standardDevelopmentPipeline(), { id: 'task-9', goal: 'Add OAuth login' });
  assert.deepEqual(graph.nodeIds, ['requirement', 'analysis', 'plan', 'implementation', 'test', 'review']);
  const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n]));
  assert.deepEqual(byId.requirement.dependencies, []);
  assert.deepEqual(byId.analysis.dependencies, ['requirement']);
  assert.deepEqual(byId.plan.dependencies, ['analysis']);
  assert.deepEqual(byId.implementation.dependencies, ['plan']);
  assert.deepEqual(byId.test.dependencies, ['implementation']);
  assert.deepEqual(byId.review.dependencies, ['test']);
  assert.equal(byId.review.kind, 'review');
  assert.equal(byId.implementation.kind, 'work');
  assert.deepEqual(byId.test.acceptanceCriteria, [{ id: 'tests-pass', verifierRef: 'test', required: true }]);
});

test('pipelineTemplates.list and get are deterministic', () => {
  assert.deepEqual(pipelineTemplates.list(), [
    { id: 'standard-development', version: '1.0.0', stageIds: ['requirement', 'analysis', 'plan', 'implementation', 'test', 'review'] },
  ]);
  assert.equal(pipelineTemplates.get('standard-development'), standardDevelopmentPipeline());
  assert.equal(pipelineTemplates.get('nope'), null);
});

test('same template instance is returned (cached) and compile hashes are stable', () => {
  assert.equal(standardDevelopmentPipeline(), standardDevelopmentPipeline());
  const a = compilePipeline(standardDevelopmentPipeline(), { id: 't', goal: 'g' });
  const b = compilePipeline(standardDevelopmentPipeline(), { id: 't', goal: 'g' });
  assert.equal(a.graphHash, b.graphHash);
});

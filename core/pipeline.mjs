// Level 3 Task 1: immutable pipeline template contract.
//
// A pipeline template is a versioned, deeply frozen description of stages.
// compilePipeline turns the template into an ordinary Level 2 TaskGraph so
// every Level 2 trust boundary (routing, sandbox, Runtime Action Gateway,
// trusted Evidence, finish Decision) applies unchanged. Stage metadata
// (outputs, evidence, scope) is NOT carried on the compiled node — Level 2
// node validation drops extra fields — so pipeline-runner looks it up from
// the template by stage id (node.id === stage.id).

import { createHash } from 'node:crypto';
import { createTask, createTaskGraph, canonicalJson } from './task-graph.mjs';

export class PipelineError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    if (details) this.details = details;
  }
}

// Acceptance verifier kinds reuse the Level 2 verifier set so compiled
// acceptanceCriteria pass createTaskGraph unchanged.
const VERIFIER_KINDS = new Set(['diff', 'scope', 'test', 'budget', 'dependency', 'architecture', 'audit']);
const EVIDENCE_KINDS = new Set(['artifact', 'test', 'scope', 'diff', 'review', 'audit', 'architecture']);
const REVIEW_STAGE_IDS = new Set(['review']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

function assertNonEmptyString(value, code, message) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PipelineError(code, message);
  }
}

function validateStage(stage, index, availableInputs, templateInputs) {
  if (!stage || typeof stage !== 'object') {
    throw new PipelineError('PIPELINE_STAGE_INVALID', `stage at index ${index} must be an object`);
  }
  const { id, name, inputs = [], outputs = [], acceptance = [], owner, evidence = [], scope = null, knowledge = null } = stage;
  assertNonEmptyString(id, 'PIPELINE_STAGE_ID_INVALID', `stage at index ${index} must have a non-empty id`);
  assertNonEmptyString(name, 'PIPELINE_STAGE_NAME_INVALID', `stage ${id} must have a non-empty name`);
  if (!Array.isArray(inputs)) {
    throw new PipelineError('PIPELINE_STAGE_INPUTS_INVALID', `stage ${id} inputs must be an array`);
  }
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new PipelineError('PIPELINE_STAGE_NO_OUTPUTS', `stage ${id} must declare at least one output artifact`);
  }
  for (const out of outputs) {
    assertNonEmptyString(out, 'PIPELINE_STAGE_OUTPUT_INVALID', `stage ${id} has an invalid output artifact name`);
  }
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    throw new PipelineError('PIPELINE_STAGE_NO_ACCEPTANCE', `stage ${id} must declare at least one acceptance criterion`);
  }
  const seenAcceptance = new Set();
  for (const acc of acceptance) {
    if (!acc || typeof acc !== 'object') {
      throw new PipelineError('PIPELINE_STAGE_ACCEPTANCE_INVALID', `stage ${id} has a non-object acceptance criterion`);
    }
    if (typeof acc.id !== 'string' || !acc.id.trim() || seenAcceptance.has(acc.id)) {
      throw new PipelineError('PIPELINE_STAGE_ACCEPTANCE_INVALID', `stage ${id} acceptance ids must be unique non-empty strings`);
    }
    seenAcceptance.add(acc.id);
    if (!VERIFIER_KINDS.has(acc.kind)) {
      throw new PipelineError('PIPELINE_STAGE_VERIFIER_INVALID', `stage ${id} acceptance ${acc.id} uses unknown verifier kind ${JSON.stringify(acc.kind)}`, {
        accepted: [...VERIFIER_KINDS],
      });
    }
    if (typeof acc.required !== 'boolean') {
      throw new PipelineError('PIPELINE_STAGE_ACCEPTANCE_INVALID', `stage ${id} acceptance ${acc.id} must declare required as boolean`);
    }
  }
  assertNonEmptyString(owner, 'PIPELINE_STAGE_NO_OWNER', `stage ${id} must declare an owner`);
  if (!Array.isArray(evidence)) {
    throw new PipelineError('PIPELINE_STAGE_EVIDENCE_INVALID', `stage ${id} evidence must be an array`);
  }
  for (const ev of evidence) {
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || !ev.id.trim()) {
      throw new PipelineError('PIPELINE_STAGE_EVIDENCE_INVALID', `stage ${id} evidence entries must have an id`);
    }
    if (!EVIDENCE_KINDS.has(ev.kind)) {
      throw new PipelineError('PIPELINE_STAGE_EVIDENCE_INVALID', `stage ${id} evidence ${ev.id} uses unknown evidence kind ${JSON.stringify(ev.kind)}`, {
        accepted: [...EVIDENCE_KINDS],
      });
    }
  }
  if (scope !== null && (typeof scope !== 'string' || !scope.trim())) {
    throw new PipelineError('PIPELINE_STAGE_SCOPE_INVALID', `stage ${id} scope must be a non-empty string or null`);
  }
  let validatedKnowledge = null;
  if (knowledge != null) {
    if (!knowledge || typeof knowledge !== 'object' || typeof knowledge.query !== 'string' || !knowledge.query.trim()) {
      throw new PipelineError('PIPELINE_STAGE_KNOWLEDGE_INVALID', `stage ${id} knowledge must declare a non-empty query`);
    }
    if (typeof knowledge.scope !== 'string' || !knowledge.scope.trim()) {
      throw new PipelineError('PIPELINE_STAGE_KNOWLEDGE_INVALID', `stage ${id} knowledge must declare a scope`);
    }
    if (knowledge.budgetChars != null && (typeof knowledge.budgetChars !== 'number' || knowledge.budgetChars < 0 || Number.isNaN(knowledge.budgetChars))) {
      throw new PipelineError('PIPELINE_STAGE_KNOWLEDGE_INVALID', `stage ${id} knowledge.budgetChars must be a non-negative number`);
    }
    validatedKnowledge = {
      query: knowledge.query,
      scope: knowledge.scope,
      budgetChars: knowledge.budgetChars ?? 8000,
    };
  }
  for (const input of inputs) {
    if (typeof input !== 'string' || !input.trim()) {
      throw new PipelineError('PIPELINE_STAGE_INPUT_INVALID', `stage ${id} has an invalid input reference`);
    }
    if (!templateInputs.has(input) && !availableInputs.has(input)) {
      throw new PipelineError('PIPELINE_UNKNOWN_INPUT', `stage ${id} inputs reference unknown artifact ${JSON.stringify(input)}`);
    }
  }
  return {
    id,
    name,
    inputs: [...inputs],
    outputs: [...outputs],
    acceptance: acceptance.map((a) => ({ id: a.id, kind: a.kind, required: a.required })),
    owner,
    evidence: evidence.map((e) => ({ id: e.id, kind: e.kind })),
    scope,
    knowledge: validatedKnowledge,
  };
}

export function definePipeline({ id, version, inputs = [], stages = [] }) {
  assertNonEmptyString(id, 'PIPELINE_ID_INVALID', 'pipeline id must be a non-empty string');
  assertNonEmptyString(version, 'PIPELINE_VERSION_INVALID', 'pipeline version must be a non-empty string');
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new PipelineError('PIPELINE_NO_STAGES', 'pipeline must declare at least one stage');
  }
  if (!Array.isArray(inputs)) {
    throw new PipelineError('PIPELINE_INPUTS_INVALID', 'pipeline inputs must be an array');
  }
  const templateInputs = new Set(inputs);
  const seenStageIds = new Set();
  const seenOutputs = new Set();
  const validatedStages = [];
  const availableInputs = new Set();
  for (const stage of stages) {
    const validated = validateStage(stage, validatedStages.length, availableInputs, templateInputs);
    if (seenStageIds.has(validated.id)) {
      throw new PipelineError('PIPELINE_DUPLICATE_STAGE', `duplicate stage id ${validated.id}`);
    }
    seenStageIds.add(validated.id);
    for (const out of validated.outputs) {
      if (seenOutputs.has(out)) {
        throw new PipelineError('PIPELINE_DUPLICATE_OUTPUT', `artifact ${out} is produced by more than one stage`);
      }
      seenOutputs.add(out);
      availableInputs.add(out);
    }
    validatedStages.push(validated);
  }
  return deepFreeze({
    id,
    version,
    inputs: [...inputs],
    stages: validatedStages,
    templateHash: sha256Hex({ id, version, inputs: [...inputs], stages: validatedStages }),
  });
}

function sha256Hex(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function pipelineTemplateVersion(template) {
  return template.version;
}

export function compilePipeline(template, taskInput) {
  if (!template || typeof template !== 'object' || !Array.isArray(template.stages)) {
    throw new PipelineError('PIPELINE_TEMPLATE_INVALID', 'compilePipeline requires a validated pipeline template');
  }
  const task = createTask(taskInput);
  // artifact -> stageId that produces it
  const producer = new Map();
  for (const stage of template.stages) {
    for (const out of stage.outputs) producer.set(out, stage.id);
  }
  const nodes = template.stages.map((stage) => {
    const dependencies = [];
    for (const input of stage.inputs) {
      const dep = producer.get(input);
      if (dep) dependencies.push(dep);
      // template-level inputs are external; they contribute no node dependency
    }
    dependencies.sort();
    const isReview = REVIEW_STAGE_IDS.has(stage.id);
    return {
      id: stage.id,
      goal: `${stage.name}: ${task.goal}`,
      dependencies,
      capabilityRequired: stage.owner,
      kind: isReview ? 'review' : 'work',
      maxAttempts: isReview ? 1 : 3,
      maxReviewRounds: isReview ? 0 : 1,
      acceptanceCriteria: stage.acceptance.map((a) => ({ id: a.id, verifierRef: a.kind, required: a.required })),
    };
  });
  return createTaskGraph({ task, nodes });
}

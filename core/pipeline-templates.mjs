// Level 3 Task 2: the standard development pipeline template.
//
// Requirement → Analysis → Plan → Implementation → Test → Review.
// Every stage declares inputs, output artifacts, acceptance criteria, owner,
// evidence and (where relevant) a knowledge scope. The template is created
// through definePipeline, so it is immutable, versioned and validated.

import { definePipeline } from './pipeline.mjs';

const STANDARD_DEVELOPMENT_ID = 'standard-development';
const STANDARD_DEVELOPMENT_VERSION = '1.0.0';

let cached = null;

export function standardDevelopmentPipeline() {
  if (cached) return cached;
  cached = definePipeline({
    id: STANDARD_DEVELOPMENT_ID,
    version: STANDARD_DEVELOPMENT_VERSION,
    inputs: ['requirement'],
    stages: [
      {
        id: 'requirement',
        name: 'Requirement',
        inputs: ['requirement'],
        outputs: ['requirement-notes'],
        acceptance: [{ id: 'requirement-clarity', kind: 'scope', required: true }],
        owner: 'requirement',
        evidence: [{ id: 'requirement-evidence', kind: 'artifact' }],
        scope: 'docs/',
      },
      {
        id: 'analysis',
        name: 'Analysis',
        inputs: ['requirement-notes'],
        outputs: ['analysis'],
        acceptance: [{ id: 'analysis-complete', kind: 'architecture', required: true }],
        owner: 'analysis',
        evidence: [{ id: 'analysis-evidence', kind: 'artifact' }],
        scope: 'docs/',
      },
      {
        id: 'plan',
        name: 'Plan',
        inputs: ['analysis'],
        outputs: ['plan'],
        acceptance: [{ id: 'plan-actionable', kind: 'scope', required: true }],
        owner: 'planning',
        evidence: [{ id: 'plan-evidence', kind: 'artifact' }],
        scope: null,
      },
      {
        id: 'implementation',
        name: 'Implementation',
        inputs: ['plan'],
        outputs: ['implementation-artifact'],
        acceptance: [{ id: 'implementation-scope', kind: 'scope', required: true }],
        owner: 'implementation',
        evidence: [{ id: 'implementation-evidence', kind: 'diff' }],
        scope: 'src/',
      },
      {
        id: 'test',
        name: 'Test',
        inputs: ['implementation-artifact'],
        outputs: ['test-report'],
        acceptance: [{ id: 'tests-pass', kind: 'test', required: true }],
        owner: 'testing',
        evidence: [{ id: 'test-evidence', kind: 'test' }],
        scope: 'tests/',
      },
      {
        id: 'review',
        name: 'Review',
        inputs: ['test-report'],
        outputs: ['review-decision'],
        acceptance: [{ id: 'review-approved', kind: 'audit', required: true }],
        owner: 'reviewer',
        evidence: [{ id: 'review-evidence', kind: 'review' }],
        scope: null,
      },
    ],
  });
  return cached;
}

export const pipelineTemplates = Object.freeze({
  list() {
    return [{ id: STANDARD_DEVELOPMENT_ID, version: STANDARD_DEVELOPMENT_VERSION, stageIds: standardDevelopmentPipeline().stages.map((s) => s.id) }];
  },
  get(id) {
    if (id === STANDARD_DEVELOPMENT_ID) return standardDevelopmentPipeline();
    return null;
  },
});

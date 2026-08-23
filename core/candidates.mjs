// Level 5 Task 3: structured candidate rules with an append-only lifecycle.
//
// A candidate is a versioned structured rule (routing / workflow /
// meta-skill) with scope, rationale, evidence links, expected effect and a
// rollback target. Its lifecycle is append-only: proposed → evaluated →
// approved → promoted, with reject at several points and rolled-back after
// promotion. Only `promoted` candidates may be applied by applyCandidateRule.
// Raw Agent claims are never candidates — every proposal carries evidence
// links from the trajectory/evaluation projections.

export class CandidateError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CandidateError';
    this.code = code;
    if (details) this.details = details;
  }
}

const CANDIDATE_TABLE = 'candidate';
const HISTORY_TABLE = 'candidate_history';
const RULE_KINDS = new Set(['routing', 'workflow', 'meta-skill']);
const STATUSES = new Set(['proposed', 'evaluated', 'approved', 'promoted', 'rejected', 'rolled-back']);
const TRANSITIONS = new Map([
  ['proposed', new Set(['evaluated', 'rejected'])],
  ['evaluated', new Set(['approved', 'rejected'])],
  ['approved', new Set(['promoted', 'rejected'])],
  ['promoted', new Set(['rolled-back'])],
]);

function requireStore(store) {
  if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
    throw new CandidateError('CANDIDATE_STORE_INVALID', 'candidate operations require a StateStore');
  }
}

function validateRule(rule) {
  if (!rule || typeof rule !== 'object' || !RULE_KINDS.has(rule.kind)) {
    throw new CandidateError('CANDIDATE_RULE_INVALID', `rule.kind must be one of ${[...RULE_KINDS].join(', ')}`);
  }
  const params = rule.params ?? {};
  if (typeof params !== 'object') {
    throw new CandidateError('CANDIDATE_RULE_INVALID', 'rule.params must be an object');
  }
  return { kind: rule.kind, params };
}

function latestCandidate(store, candidateId) {
  const rows = store.readRows(CANDIDATE_TABLE).filter((r) => r.id === candidateId);
  if (rows.length === 0) return null;
  return rows[rows.length - 1];
}

export function proposeCandidate({ id, version, scope, rationale, evidenceLinks, expectedEffect, rollbackTarget, rule, store, actor = 'system' }) {
  requireStore(store);
  if (typeof id !== 'string' || !id.trim()) throw new CandidateError('CANDIDATE_ID_INVALID', 'candidate id is required');
  if (typeof version !== 'string' || !version.trim()) throw new CandidateError('CANDIDATE_VERSION_INVALID', 'candidate version is required');
  if (typeof scope !== 'string' || !scope.trim()) throw new CandidateError('CANDIDATE_SCOPE_INVALID', 'candidate scope is required');
  if (typeof rationale !== 'string' || !rationale.trim()) throw new CandidateError('CANDIDATE_RATIONALE_INVALID', 'candidate rationale is required');
  if (!Array.isArray(evidenceLinks) || evidenceLinks.length === 0) {
    throw new CandidateError('CANDIDATE_EVIDENCE_INVALID', 'candidate must link at least one evidence record');
  }
  if (typeof expectedEffect !== 'string' || !expectedEffect.trim()) throw new CandidateError('CANDIDATE_EFFECT_INVALID', 'candidate expectedEffect is required');
  if (typeof rollbackTarget !== 'string' || !rollbackTarget.trim()) throw new CandidateError('CANDIDATE_ROLLBACK_INVALID', 'candidate rollbackTarget is required');
  const validatedRule = validateRule(rule);
  const existing = latestCandidate(store, id);
  if (existing && existing.version === version) {
    throw new CandidateError('CANDIDATE_EXISTS', `candidate ${id}@${version} already exists`);
  }
  const at = new Date().toISOString();
  const candidateRow = {
    id, version, scope, rationale, evidenceLinks, expectedEffect, rollbackTarget,
    rule: validatedRule, status: 'proposed', createdBy: actor, createdAt: at,
  };
  const line = store.appendRow(CANDIDATE_TABLE, candidateRow);
  const parsed = JSON.parse(line);
  store.appendRow(HISTORY_TABLE, { candidateId: id, from: null, to: 'proposed', evidenceRef: null, actor, at });
  return { _id: parsed._id, ...candidateRow };
}

export function transitionCandidate({ store, candidateId, to, evidenceRef = null, actor = null }) {
  requireStore(store);
  const current = latestCandidate(store, candidateId);
  if (!current) throw new CandidateError('CANDIDATE_NOT_FOUND', `candidate ${candidateId} not found`);
  if (!STATUSES.has(to)) throw new CandidateError('CANDIDATE_STATUS_INVALID', `unknown status ${to}`);
  const allowed = TRANSITIONS.get(current.status) ?? new Set();
  if (!allowed.has(to)) {
    throw new CandidateError('CANDIDATE_TRANSITION_INVALID', `cannot move candidate ${candidateId} from ${current.status} to ${to}`);
  }
  const at = new Date().toISOString();
  const row = { ...current, status: to, updatedAt: at, updatedBy: actor };
  const line = store.appendRow(CANDIDATE_TABLE, row);
  const parsed = JSON.parse(line);
  store.appendRow(HISTORY_TABLE, { candidateId, from: current.status, to, evidenceRef, actor, at });
  return { _id: parsed._id, id: candidateId, version: current.version, status: to, at };
}

export function candidateHistory({ store, candidateId }) {
  requireStore(store);
  return store.readRows(HISTORY_TABLE).filter((r) => r.candidateId === candidateId);
}

export function activeCandidates({ store }) {
  requireStore(store);
  const rows = store.readRows(CANDIDATE_TABLE);
  const latest = new Map();
  for (const row of rows) latest.set(row.id, row);
  return [...latest.values()].filter((r) => ['proposed', 'evaluated', 'approved', 'promoted'].includes(r.status));
}

export function applyCandidateRule(candidate, context = {}) {
  if (!candidate || typeof candidate !== 'object') {
    throw new CandidateError('CANDIDATE_APPLY_INVALID', 'applyCandidateRule requires a candidate');
  }
  if (candidate.status !== 'promoted') {
    return { applied: false, reason: `candidate ${candidate.id} is ${candidate.status ?? 'unknown'}; only promoted candidates apply` };
  }
  const rule = candidate.rule ?? {};
  switch (rule.kind) {
    case 'routing':
      return { applied: true, result: { routing: { weightOverrides: rule.params.agentWeightOverrides ?? {} } } };
    case 'workflow':
      return { applied: true, result: { workflow: { templateVersion: rule.params.templateVersion ?? null } } };
    case 'meta-skill':
      return { applied: true, result: { metaSkill: { skillId: rule.params.skillId ?? null, config: rule.params.config ?? {} } } };
    default:
      return { applied: false, reason: `unsupported rule kind ${rule.kind}` };
  }
}

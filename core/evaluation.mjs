// Level 4 Task 2: the evaluate(run, evaluator) boundary.
//
// Every evaluator declares id, version, kind and a deterministic function.
// Raw evidence rows and derived score rows live in separate store tables so
// scores can never silently detach from the evidence that produced them.
// evaluate() is deterministic for a given (run, evaluator, evidence): the
// only varying field is evaluatedAt, which can be pinned via`now` for tests.

export class EvaluationError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EvaluationError';
    this.code = code;
    if (details) this.details = details;
  }
}

export const EVALUATOR_KINDS = Object.freeze(['rule', 'test', 'static-analysis', 'human-feedback', 'llm-judge']);
const KIND_SET = new Set(EVALUATOR_KINDS);

const RAW_TABLE = 'evaluation_raw';
const SCORE_TABLE = 'evaluation_score';

export function defineEvaluator({ id, version, kind, fn }) {
  if (typeof id !== 'string' || !id.trim()) {
    throw new EvaluationError('EVALUATOR_ID_INVALID', 'evaluator id must be a non-empty string');
  }
  if (typeof version !== 'string' || !version.trim()) {
    throw new EvaluationError('EVALUATOR_VERSION_INVALID', 'evaluator version must be a non-empty string');
  }
  if (!KIND_SET.has(kind)) {
    throw new EvaluationError('EVALUATOR_KIND_INVALID', `evaluator kind must be one of ${EVALUATOR_KINDS.join(', ')}`, { accepted: [...KIND_SET] });
  }
  if (typeof fn !== 'function') {
    throw new EvaluationError('EVALUATOR_FN_INVALID', 'evaluator fn must be a function');
  }
  return Object.freeze({ id, version, kind, fn });
}

function requireStore(store) {
  if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
    throw new EvaluationError('EVALUATION_STORE_INVALID', 'evaluate requires a StateStore when persistence is enabled');
  }
}

export async function evaluate({ run, evaluator, store = null, evidence = null, now = null, strictVersion = false }) {
  if (!run || typeof run !== 'object' || typeof run.runId !== 'string' || !run.runId) {
    throw new EvaluationError('EVALUATION_RUN_INVALID', 'run must carry a non-empty runId');
  }
  if (!evaluator || typeof evaluator !== 'object' || typeof evaluator.fn !== 'function') {
    throw new EvaluationError('EVALUATION_EVALUATOR_INVALID', 'evaluate requires a defined evaluator');
  }
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  if (store) {
    requireStore(store);
    if (strictVersion) {
      const prior = store.readRows(SCORE_TABLE).filter((r) => r.runId === run.runId && r.evaluatorId === evaluator.id);
      if (prior.length > 0 && prior[prior.length - 1].evaluatorVersion !== evaluator.version) {
        throw new EvaluationError('EVALUATION_VERSION_MISMATCH', `run ${run.runId} was already evaluated by ${evaluator.id}@${prior[prior.length - 1].evaluatorVersion}, not @${evaluator.version}`);
      }
    }
  }
  const outcome = await evaluator.fn({ run, evidence: evidenceList });
  if (!outcome || typeof outcome !== 'object' || typeof outcome.scores !== 'object' || outcome.scores === null) {
    throw new EvaluationError('EVALUATION_RESULT_INVALID', `evaluator ${evaluator.id} must return an object with a scores object`);
  }
  const deterministic = outcome.deterministic !== false;
  const evaluatedAt = now ?? new Date().toISOString();
  const rawEvidence = evidenceList.map((ev) => ({
    kind: ev?.kind ?? 'raw',
    contentHash: ev?.contentHash ?? null,
    byteCount: ev?.byteCount ?? null,
    payloadRef: ev?.sourcePath ?? ev?.ref ?? null,
  }));
  const result = Object.freeze({
    runId: run.runId,
    evaluator: Object.freeze({ id: evaluator.id, version: evaluator.version, kind: evaluator.kind }),
    scores: Object.freeze({ ...outcome.scores }),
    overall: outcome.overall ?? null,
    deterministic,
    llmJudge: outcome.llmJudge ?? null,
    extra: outcome.extra ?? null,
    rawEvidence: Object.freeze(rawEvidence),
    evaluatedAt,
  });
  if (store) {
    for (const ev of evidenceList) {
      store.appendRow(RAW_TABLE, {
        runId: run.runId,
        evaluatorId: evaluator.id,
        evaluatorVersion: evaluator.version,
        evidenceKind: ev?.kind ?? 'raw',
        contentHash: ev?.contentHash ?? null,
        byteCount: ev?.byteCount ?? null,
        payloadRef: ev?.sourcePath ?? ev?.ref ?? null,
      });
    }
    store.appendRow(SCORE_TABLE, {
      runId: run.runId,
      evaluatorId: evaluator.id,
      evaluatorVersion: evaluator.version,
      evaluatorKind: evaluator.kind,
      scores: outcome.scores,
      overall: outcome.overall ?? null,
      deterministic,
      llmJudge: outcome.llmJudge ?? null,
      evaluatedAt,
    });
  }
  return result;
}

export function latestScores(store, { runId, evaluatorId = null }) {
  requireStore(store);
  const rows = store.readRows(SCORE_TABLE).filter((r) => r.runId === runId && (!evaluatorId || r.evaluatorId === evaluatorId));
  return rows.map((r) => ({
    evaluatorId: r.evaluatorId,
    evaluatorVersion: r.evaluatorVersion,
    evaluatorKind: r.evaluatorKind,
    scores: r.scores,
    overall: r.overall,
    deterministic: r.deterministic,
    llmJudge: r.llmJudge,
    evaluatedAt: r.evaluatedAt,
  }));
}

export function rawEvidenceRows(store, { runId, evaluatorId = null }) {
  requireStore(store);
  return store.readRows(RAW_TABLE).filter((r) => r.runId === runId && (!evaluatorId || r.evaluatorId === evaluatorId));
}

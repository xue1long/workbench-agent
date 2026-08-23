// Level 5 Task 1: reflection signal ranking.
//
// Reflection candidates are ranked by four deterministic signals:
// difficulty, uncertainty, business value, and repeated failure. Topics are
// bucketed by versioned task class so comparisons never cross classes. Raw
// Agent output never becomes a candidate — only trajectory rows with
// evaluation evidence participate.

export class ReflectionError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ReflectionError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function taskClassOf(row) {
  const workflow = row.workflowId ?? 'task';
  const kind = row.kind ?? row.templateVersion ?? 'v1';
  return `${workflow}:${kind}`;
}

function clamp01(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function difficultyOf(row) {
  if (typeof row.difficulty === 'number') return clamp01(row.difficulty);
  if (typeof row.cost === 'number' && typeof row.latencyMs === 'number') {
    // Cost and latency percentiles are computed later; here we use a local
    // deterministic proxy: cost * 0.2 + min(latencyMs/10000, 1) * 0.8.
    return clamp01((clamp01(row.cost / 20) * 0.2) + (clamp01(row.latencyMs / 10000) * 0.8));
  }
  return 0.3;
}

function uncertaintyOf(row) {
  if (typeof row.uncertainty === 'number') return clamp01(row.uncertainty);
  const retries = Array.isArray(row.attemptsPerNode) ? Math.max(...row.attemptsPerNode.map(Number), 0) : 0;
  const noEvidence = !Array.isArray(row.evidenceRefs) || row.evidenceRefs.length === 0;
  return clamp01((retries > 1 ? 0.5 : 0) + (noEvidence ? 0.3 : 0));
}

export function rankReflectionCandidates({ rows, weights = null, businessValues = {} }) {
  if (!Array.isArray(rows)) {
    throw new ReflectionError('REFLECTION_ROWS_INVALID', 'rows must be an array');
  }
  const w = { difficulty: 1, uncertainty: 1, businessValue: 1, repeatedFailure: 2, ...(weights ?? {}) };
  const buckets = new Map();
  for (const row of rows) {
    if (!row || typeof row.runId !== 'string') continue;
    const cls = taskClassOf(row);
    const bucket = buckets.get(cls) ?? { cls, total: 0, failures: 0, difficultySum: 0, uncertaintySum: 0, rows: [] };
    bucket.total += 1;
    bucket.difficultySum += difficultyOf(row);
    bucket.uncertaintySum += uncertaintyOf(row);
    if (row.finalStatus !== 'COMPLETED' && row.finalStatus !== 'EXECUTION_SUCCEEDED') bucket.failures += 1;
    bucket.rows.push(row);
    buckets.set(cls, bucket);
  }
  const topics = [];
  for (const bucket of buckets.values()) {
    const difficulty = bucket.total === 0 ? 0 : bucket.difficultySum / bucket.total;
    const uncertainty = bucket.total === 0 ? 0 : bucket.uncertaintySum / bucket.total;
    const businessValue = clamp01(businessValues[bucket.cls] ?? 0.5);
    const failureRate = bucket.total === 0 ? 0 : bucket.failures / bucket.total;
    const repeatedFailure = clamp01(failureRate);
    const score =
      w.difficulty * difficulty +
      w.uncertainty * uncertainty +
      w.businessValue * businessValue +
      w.repeatedFailure * repeatedFailure;
    topics.push({
      taskClass: bucket.cls,
      total: bucket.total,
      failures: bucket.failures,
      failureRate: Math.round(failureRate * 1000) / 1000,
      signals: {
        difficulty: Math.round(difficulty * 1000) / 1000,
        uncertainty: Math.round(uncertainty * 1000) / 1000,
        businessValue: Math.round(businessValue * 1000) / 1000,
        repeatedFailure: Math.round(repeatedFailure * 1000) / 1000,
      },
      score: Math.round(score * 1000) / 1000,
      reasons: [
        `difficulty ${Math.round(difficulty * 1000) / 1000}`,
        `uncertainty ${Math.round(uncertainty * 1000) / 1000}`,
        `business value ${Math.round(businessValue * 1000) / 1000}`,
        `${bucket.failures}/${bucket.total} failures`,
      ],
    });
  }
  topics.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.taskClass < b.taskClass ? -1 : a.taskClass > b.taskClass ? 1 : 0;
  });
  return Object.freeze(topics);
}

export function candidateTopicsSummary(topics, topN = 5) {
  return topics.slice(0, topN).map((t) => ({
    taskClass: t.taskClass,
    score: t.score,
    reasons: t.reasons,
  }));
}

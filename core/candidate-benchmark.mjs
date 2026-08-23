// Level 5 Task 4: offline candidate benchmark against the frozen baseline.
//
// Paired evaluation: every task case in the candidate's scope runs in both
// the baseline and candidate versions; per-case deltas are bootstrap
// re-sampled (deterministic, seeded mulberry32) into a 95% confidence
// interval. The promotion rule from the Level 2-7 plan is enforced verbatim:
// promote only when the candidate improves the primary success metric by at
// least 5 percentage points AND the 95% CI for the paired improvement
// excludes zero AND no security/correctness regression occurs AND cost and
// latency stay within the pre-registered budget.

export class CandidateBenchmarkError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'CandidateBenchmarkError';
    this.code = code;
    if (details) this.details = details;
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

export async function runCandidateBenchmark({
  baseline, candidate, evaluateCase, budget = { maxCostUsd: null, maxLatencyMs: null },
  seed = 42, bootstrapSamples = 1000, minImprovement = 0.05,
}) {
  if (!candidate || typeof candidate.scope !== 'string' || typeof candidate.id !== 'string') {
    throw new CandidateBenchmarkError('BENCH_CANDIDATE_INVALID', 'candidate must carry id and scope');
  }
  if (typeof evaluateCase !== 'function') {
    throw new CandidateBenchmarkError('BENCH_EVALUATECASE_INVALID', 'evaluateCase must be a function');
  }
  const cases = baseline.cases ?? [];
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new CandidateBenchmarkError('BENCH_BASELINE_INVALID', 'baseline must carry a cases array');
  }
  const paired = [];
  for (const taskCase of cases) {
    const base = await evaluateCase(taskCase, 'baseline');
    const cand = await evaluateCase(taskCase, 'candidate');
    if (!base || !cand) {
      throw new CandidateBenchmarkError('BENCH_EVALUATION_INVALID', `case ${taskCase.id} produced no evaluation`);
    }
    paired.push({
      caseId: taskCase.id,
      baseline: base,
      candidate: cand,
      delta: (cand.success ? 1 : 0) - (base.success ? 1 : 0),
    });
  }
  const n = paired.length;
  const baseRate = paired.filter((p) => p.baseline.success).length / n;
  const candRate = paired.filter((p) => p.candidate.success).length / n;
  const improvement = Math.round((candRate - baseRate) * 1000) / 1000;

  const rand = mulberry32(seed);
  const bootMeans = [];
  for (let s = 0; s < bootstrapSamples; s += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      sum += paired[Math.floor(rand() * n)].delta;
    }
    bootMeans.push(sum / n);
  }
  bootMeans.sort((a, b) => a - b);
  const ciLow = Math.round(percentile(bootMeans, 0.025) * 1000) / 1000;
  const ciHigh = Math.round(percentile(bootMeans, 0.975) * 1000) / 1000;
  const ciExcludesZero = ciLow > 0 || ciHigh < 0;

  const regression = paired.filter((p) => {
    const baseSafe = p.baseline.securityPass !== false && p.baseline.correctnessPass !== false;
    const candSafe = p.candidate.securityPass !== false && p.candidate.correctnessPass !== false;
    return baseSafe && !candSafe;
  }).map((p) => p.caseId);

  const avgCost = paired.reduce((acc, p) => acc + (p.candidate.cost ?? 0), 0) / n;
  const avgLatency = paired.reduce((acc, p) => acc + (p.candidate.latencyMs ?? 0), 0) / n;
  const budgetOk = (budget.maxCostUsd == null || avgCost <= budget.maxCostUsd) && (budget.maxLatencyMs == null || avgLatency <= budget.maxLatencyMs);

  return {
    candidateId: candidate.id,
    caseCount: n,
    baselineSuccessRate: Math.round(baseRate * 1000) / 1000,
    candidateSuccessRate: candRate,
    improvement,
    ci95: { low: ciLow, high: ciHigh, excludesZero: ciExcludesZero },
    securityRegression: regression,
    candidateCost: Math.round(avgCost * 1000) / 1000,
    candidateLatencyMs: Math.round(avgLatency * 1000) / 1000,
    budget,
    budgetOk,
    seed,
    bootstrapSamples,
  };
}

export function promotionDecision(result) {
  const reasons = [];
  let decision = 'promote';
  if (result.improvement < 0.05) {
    decision = 'reject';
    reasons.push(`improvement ${result.improvement} < 0.05 (5pp)`);
  }
  if (!result.ci95.excludesZero) {
    decision = 'reject';
    reasons.push(`95% CI [${result.ci95.low}, ${result.ci95.high}] includes zero`);
  }
  if (result.securityRegression.length > 0) {
    decision = 'reject';
    reasons.push(`security/correctness regression on ${result.securityRegression.join(',')}`);
  }
  if (!result.budgetOk) {
    decision = 'reject';
    reasons.push(`budget breach: cost ${result.candidateCost}, latency ${result.candidateLatencyMs}ms`);
  }
  if (decision === 'promote') reasons.push('meets the pre-registered promotion rule');
  return { decision, reasons };
}

export function recordBenchmark({ store, candidateId, result, decision }) {
  if (!store || typeof store.appendRow !== 'function') {
    throw new CandidateBenchmarkError('BENCH_STORE_INVALID', 'recordBenchmark requires a StateStore');
  }
  const line = store.appendRow('candidate_benchmark', {
    candidateId,
    caseCount: result.caseCount,
    improvement: result.improvement,
    ci95: result.ci95,
    securityRegression: result.securityRegression,
    budgetOk: result.budgetOk,
    decision: decision.decision,
    reasons: decision.reasons,
    recordedAt: new Date().toISOString(),
  });
  return JSON.parse(line);
}

// Level 6 Task 4: tier ranking and Candidate Patterns.
//
// Tier 1/2 sources may produce experiment-eligible Candidate Patterns;
// Tier 3/4 sources are discovery-only and cannot. Every pattern carries
// provenance that traces back to the exact source record it came from.

export class PatternError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PatternError';
    this.code = code;
    if (details) this.details = details;
  }
}

const TIER_ORDER = [1, 2, 3, 4];

function tierRank(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx < 0 ? TIER_ORDER.length : idx;
}

export function rankSources(normalizedRecords) {
  if (!Array.isArray(normalizedRecords)) {
    throw new PatternError('PATTERN_INPUT_INVALID', 'normalizedRecords must be an array');
  }
  return [...normalizedRecords].sort((a, b) => {
    const r = tierRank(a.tier) - tierRank(b.tier);
    if (r !== 0) return r;
    if (a.normalizedAt && b.normalizedAt) return a.normalizedAt < b.normalizedAt ? 1 : -1;
    return 0;
  });
}

function nextPatternId() {
  return `pat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateCandidatePattern({ normalized, minTier = 2 } = {}) {
  if (!normalized || typeof normalized !== 'object') {
    throw new PatternError('PATTERN_INPUT_INVALID', 'normalized record is required');
  }
  const experimentEligible = tierRank(normalized.tier) <= tierRank(minTier);
  if (!experimentEligible) {
    return {
      id: nextPatternId(),
      title: `Discovery: ${normalized.problem || normalized.method || normalized.sourceId}`.slice(0, 120),
      sourceRefs: [{ sourceId: normalized.sourceId, version: normalized.version }],
      applicability: normalized.applicableCapability ?? 'unknown',
      expectedBenefit: null,
      risk: 'secondary source only; not eligible for experiments without Tier 1/2 corroboration',
      implementationIdea: normalized.method || null,
      evidenceTier: normalized.tier,
      experimentEligible: false,
    };
  }
  return {
    id: nextPatternId(),
    title: `Candidate: ${normalized.problem || normalized.sourceId}`.slice(0, 120),
    sourceRefs: [{ sourceId: normalized.sourceId, version: normalized.version }],
    applicability: normalized.applicableCapability ?? 'unknown',
    expectedBenefit: normalized.evidence || null,
    risk: normalized.limitations || null,
    implementationIdea: normalized.method || null,
    evidenceTier: normalized.tier,
    experimentEligible: true,
  };
}

export function tracePattern(pattern, store) {
  if (!pattern || !store || typeof store.readRows !== 'function') {
    throw new PatternError('PATTERN_TRACE_INVALID', 'pattern and store are required');
  }
  const sources = [];
  for (const ref of pattern.sourceRefs ?? []) {
    const sourceRows = store.readRows('intelligence_source').filter((r) => r.id === ref.sourceId);
    const ingestionRows = store.readRows('intelligence_ingestion').filter((r) => r.sourceId === ref.sourceId && r.version === ref.version);
    const extractionRows = store.readRows('intelligence_extraction').filter((r) => r.sourceId === ref.sourceId && r.version === ref.version);
    sources.push({
      sourceId: ref.sourceId,
      version: ref.version,
      source: sourceRows[sourceRows.length - 1] ?? null,
      ingestion: ingestionRows[ingestionRows.length - 1] ?? null,
      extraction: extractionRows[extractionRows.length - 1] ?? null,
    });
  }
  return { sources };
}

export function candidatePatterns({ normalizedRecords, minTier = 2 } = {}) {
  const ranked = rankSources(normalizedRecords ?? []);
  return ranked.map((r) => generateCandidatePattern({ normalized: r, minTier }));
}

// Level 6 Task 3: structured normalization.
//
// Each ingested extraction becomes a normalized record: problem, method,
// evidence, limitations, applicable capability, provenance. A caller may
// supply an explicit extractor; the default uses deterministic heading +
// keyword heuristics so the suite does not depend on any LLM.

export class NormalizeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'NormalizeError';
    this.code = code;
    if (details) this.details = details;
  }
}

const DEFAULT_LIMITATIONS = ['information based on a single source', 'generalizability not yet measured'];
const KEYWORD_TO_CAPABILITY = [
  [/routing/i, 'orchestrator_routing'],
  [/router|planner/i, 'planning'],
  [/evaluat|metric/i, 'evaluation'],
  [/retriev|search|ground/i, 'knowledge_retrieval'],
  [/canary|deploy/i, 'controlled_rollout'],
  [/prompt|instruct/i, 'prompting'],
];

function applyExtractor(content, extractor) {
  if (typeof extractor === 'function') {
    const result = extractor({ content });
    return {
      problem: result?.problem ?? '',
      method: result?.method ?? '',
      evidence: result?.evidence ?? '',
      limitations: result?.limitations ?? '',
      applicableCapability: result?.applicableCapability ?? null,
    };
  }
  if (typeof content !== 'string' || content.length === 0) {
    return { problem: '', method: '', evidence: '', limitations: '', applicableCapability: null };
  }
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#/.test(l))?.replace(/^#+\s*/, '') ?? '';
  const problem = lines.find((l) => /^(problem|abstract)/i.test(l))?.replace(/^[^:]*:\s*/, '') ?? heading;
  const method = lines.find((l) => /^(method|approach)/i.test(l))?.replace(/^[^:]*:\s*/, '') ?? '';
  const evidence = lines.find((l) => /^(evidence|result)/i.test(l))?.replace(/^[^:]*:\s*/, '') ?? '';
  const limitations = lines.find((l) => /^(limit|caveat|threat)/i.test(l))?.replace(/^[^:]*:\s*/, '') ?? '';
  const capability = KEYWORD_TO_CAPABILITY.find(([re]) => re.test(content))?.[1] ?? null;
  return { problem, method, evidence, limitations, applicableCapability: capability };
}

export function normalizeSource({ source, content, version, extractor = null, now = null }) {
  if (!source || typeof source !== 'object') throw new NormalizeError('NORMALIZE_SOURCE_INVALID', 'source is required');
  const result = applyExtractor(content, extractor);
  return {
    sourceId: source.id,
    version: version ?? null,
    tier: source.tier,
    problem: result.problem,
    method: result.method,
    evidence: result.evidence,
    limitations: result.limitations || DEFAULT_LIMITATIONS.join('; '),
    applicableCapability: result.applicableCapability,
    provenance: {
      canonicalUrl: source.canonicalUrl,
      retrievedAt: source.retrievedAt,
      doi: source.doi ?? null,
      repoIdentity: source.repoIdentity ?? null,
      kind: source.kind,
    },
    normalizedAt: now ?? new Date().toISOString(),
  };
}

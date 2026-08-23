// Level 4 Task 6: redacted benchmark exchange.
//
// exportBenchmarkRun() serializes a benchmark run (trajectory rows + derived
// score rows) into a portable, REDACTED payload: prompt/context/content/
// stdout/stderr fields are stripped so only hashes, paths, scores and
// metadata travel. importBenchmarkRun() refuses payloads that still carry
// content fields and unknown format versions.

export class BenchmarkExchangeError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BenchmarkExchangeError';
    this.code = code;
    if (details) this.details = details;
  }
}

const FORMAT = 'workbench-benchmark-1';
const SENSITIVE_KEYS = new Set(['content', 'prompt', 'context', 'stdout', 'stderr', 'raw']);

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key)) {
        out[key] = null; // presence signals "was redacted"
        continue;
      }
      out[key] = redact(val);
    }
    return out;
  }
  return value;
}

function assertRedacted(value, path) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertRedacted(value[i], `${path}[${i}]`);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key) && val != null) {
        throw new BenchmarkExchangeError('BENCHMARK_EXCHANGE_NOT_REDACTED', `${path}.${key} still carries content`);
      }
      assertRedacted(val, `${path}.${key}`);
    }
  }
}

export function exportBenchmarkRun({ rows, scoreRows = [], includeRaw = false, exportedAt = null }) {
  if (!Array.isArray(rows)) {
    throw new BenchmarkExchangeError('BENCHMARK_EXCHANGE_ROWS_INVALID', 'rows must be an array');
  }
  const redactedRows = rows.map(redact);
  const redactedScores = includeRaw ? scoreRows.map(redact) : scoreRows.map((s) => ({
    runId: s.runId,
    evaluatorId: s.evaluatorId,
    evaluatorVersion: s.evaluatorVersion,
    evaluatorKind: s.evaluatorKind,
    scores: redact(s.scores),
    overall: s.overall,
    deterministic: s.deterministic,
  }));
  return {
    format: FORMAT,
    exportedAt: exportedAt ?? new Date().toISOString(),
    redacted: true,
    runCount: rows.length,
    scoreCount: redactedScores.length,
    rows: redactedRows,
    scores: redactedScores,
  };
}

export function importBenchmarkRun(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new BenchmarkExchangeError('BENCHMARK_EXCHANGE_PAYLOAD_INVALID', 'payload must be an object');
  }
  if (payload.format !== FORMAT) {
    throw new BenchmarkExchangeError('BENCHMARK_EXCHANGE_FORMAT_UNKNOWN', `unsupported benchmark format ${JSON.stringify(payload.format)}`);
  }
  if (payload.redacted !== true) {
    throw new BenchmarkExchangeError('BENCHMARK_EXCHANGE_NOT_REDACTED', 'only redacted benchmark payloads may be imported');
  }
  if (!Array.isArray(payload.rows)) {
    throw new BenchmarkExchangeError('BENCHMARK_EXCHANGE_ROWS_INVALID', 'payload must carry a rows array');
  }
  assertRedacted(payload.rows, 'rows');
  assertRedacted(payload.scores ?? [], 'scores');
  return {
    rows: payload.rows,
    scoreRows: payload.scores ?? [],
    validation: { format: payload.format, runCount: payload.runCount, scoreCount: payload.scores?.length ?? 0 },
  };
}

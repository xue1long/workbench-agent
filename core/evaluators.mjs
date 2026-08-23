// Level 4 Task 3: evaluator implementations behind the evaluate boundary.
//
// rule, test, static-analysis and human-feedback are deterministic.
// llm-judge is optional and NEVER sets `overall`: its output lives in the
// `llmJudge` field, and combineEvaluations() derives the final overall from
// deterministic results only, so a judge "pass" can never override a failed
// test or security check.

import { defineEvaluator } from './evaluation.mjs';

export function ruleEvaluator({ id = 'rule', version = '1.0.0', rules }) {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new Error('ruleEvaluator requires a non-empty rules array');
  }
  return defineEvaluator({
    id,
    version,
    kind: 'rule',
    fn: async ({ run }) => {
      const scores = {};
      let ok = true;
      for (const rule of rules) {
        const actual = rule.field === 'cost' ? run.cost : rule.field === 'latencyMs' ? run.latencyMs : rule.field === 'finalStatus' ? run.finalStatus : run.executionStatus;
        let pass = false;
        switch (rule.op) {
          case 'eq': pass = actual === rule.value; break;
          case 'lte': pass = typeof actual === 'number' && actual <= rule.value; break;
          case 'gte': pass = typeof actual === 'number' && actual >= rule.value; break;
          default: pass = false;
        }
        scores[rule.id] = pass ? 1 : 0;
        if (!pass) ok = false;
      }
      return { scores, overall: ok ? 'pass' : 'fail', deterministic: true };
    },
  });
}

export function testEvaluator({ id = 'test', version = '1.0.0' } = {}) {
  return defineEvaluator({
    id,
    version,
    kind: 'test',
    fn: async ({ evidence }) => {
      const tests = evidence.filter((e) => e?.kind === 'test');
      const required = tests.length;
      const passed = tests.filter((e) => e.passed === true).length;
      const overall = required > 0 && passed === required ? 'pass' : 'fail';
      return {
        scores: { passed, required, passRate: required === 0 ? 0 : passed / required },
        overall,
        deterministic: true,
      };
    },
  });
}

export function staticAnalysisEvaluator({ id = 'static-analysis', version = '1.0.0', maxBytes = 100000 } = {}) {
  return defineEvaluator({
    id,
    version,
    kind: 'static-analysis',
    fn: async ({ evidence }) => {
      const contents = evidence.filter((e) => typeof e?.content === 'string').map((e) => e.content);
      let todos = 0;
      let fixmes = 0;
      let trailingWhitespace = 0;
      let oversized = 0;
      for (const content of contents) {
        todos += (content.match(/\bTODO\b/gi) ?? []).length;
        fixmes += (content.match(/\bFIXME\b/gi) ?? []).length;
        for (const line of content.split('\n')) {
          if (/[ \t]+$/.test(line)) trailingWhitespace += 1;
        }
        if (Buffer.byteLength(content, 'utf8') > maxBytes) oversized += 1;
      }
      const violations = todos + fixmes + trailingWhitespace + oversized;
      return {
        scores: { todos, fixmes, trailingWhitespace, oversized, violations },
        overall: violations === 0 ? 'pass' : 'fail',
        deterministic: true,
      };
    },
  });
}

export function humanFeedbackEvaluator({ id = 'human-feedback', version = '1.0.0', minScore = 1 } = {}) {
  return defineEvaluator({
    id,
    version,
    kind: 'human-feedback',
    fn: async ({ evidence }) => {
      const feedback = evidence.filter((e) => e?.kind === 'human-feedback');
      if (feedback.length === 0) {
        return { scores: { provided: 0 }, overall: null, deterministic: true };
      }
      const merged = {};
      const actors = new Set();
      for (const item of feedback) {
        if (item.actor) actors.add(item.actor);
        for (const [key, value] of Object.entries(item.scores ?? {})) merged[key] = value;
      }
      const entries = Object.values(merged);
      const allAbove = entries.length > 0 && entries.every((v) => typeof v === 'number' && v >= minScore);
      return {
        scores: { provided: entries.length, ...merged },
        overall: allAbove ? 'pass' : 'fail',
        deterministic: true,
        extra: { actors: [...actors].sort() },
      };
    },
  });
}

export function llmJudgeEvaluator({ id = 'llm-judge', version = '1.0.0', judge = null } = {}) {
  return defineEvaluator({
    id,
    version,
    kind: 'llm-judge',
    fn: async ({ run, evidence }) => {
      if (typeof judge !== 'function') {
        return {
          scores: {},
          overall: null,
          deterministic: false,
          llmJudge: { available: false, note: 'judge not configured' },
        };
      }
      const verdict = await judge({ run, evidence });
      return {
        scores: {},
        overall: null,
        deterministic: false,
        llmJudge: {
          available: true,
          verdict,
          note: 'LLM-judge output is reported separately and never overrides deterministic checks',
        },
      };
    },
  });
}

// Final overall derives from deterministic results ONLY. A judge "pass" can
// never override a failed test/security check; a judge "fail" can never
// override a deterministic pass.
export function combineEvaluations(results) {
  const deterministic = results.filter((r) => r.deterministic && r.overall != null);
  let overall = null;
  if (deterministic.length > 0) {
    if (deterministic.some((r) => r.overall === 'fail')) overall = 'fail';
    else if (deterministic.every((r) => r.overall === 'pass')) overall = 'pass';
  }
  const llmJudge = results.filter((r) => r.llmJudge != null).map((r) => r.llmJudge);
  return { overall, llmJudge: llmJudge.length > 0 ? llmJudge[llmJudge.length - 1] : null };
}

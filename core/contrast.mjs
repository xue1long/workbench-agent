// Level 5 Task 2: contrastive trajectory comparison within a task class.
//
// Best/worst trajectories are selected ONLY inside the same versioned task
// class (workflowId + template version) using a caller-supplied deterministic
// score. The contrast extracts structured differences (agent choice,
// workflow/template version, context size, tools, retries, latency, cost)
// that feed candidate rationale.

import { taskClassOf } from './reflection.mjs';

export class ContrastError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ContrastError';
    this.code = code;
    if (details) this.details = details;
  }
}

export function bestWorstTrajectories({ rows, taskClass, scoreFn }) {
  if (!Array.isArray(rows)) {
    throw new ContrastError('CONTRAST_ROWS_INVALID', 'rows must be an array');
  }
  if (typeof scoreFn !== 'function') {
    throw new ContrastError('CONTRAST_SCOREFN_INVALID', 'scoreFn must be a function');
  }
  const inClass = rows.filter((row) => row && taskClassOf(row) === taskClass);
  if (inClass.length < 2) {
    throw new ContrastError('CONTRAST_CLASS_TOO_SMALL', `task class ${taskClass} needs at least 2 rows to compare`);
  }
  const scored = inClass.map((row) => ({ row, score: scoreFn(row) }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.row.runId < b.row.runId ? -1 : a.row.runId > b.row.runId ? 1 : 0;
  });
  return {
    best: scored[0].row,
    worst: scored[scored.length - 1].row,
    bestScore: scored[0].score,
    worstScore: scored[scored.length - 1].score,
    taskClass,
    scoreFnVersion: '1.0.0',
  };
}

function delta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  return Math.round((a - b) * 1000) / 1000;
}

export function contrast({ best, worst }) {
  const bestAgents = best.agentIds ?? [];
  const worstAgents = worst.agentIds ?? [];
  const differences = [];
  const agentChoiceDiff = bestAgents.filter((a) => !worstAgents.includes(a));
  if (agentChoiceDiff.length > 0 || bestAgents.length !== worstAgents.length) {
    differences.push({ field: 'agentChoice', best: bestAgents, worst: worstAgents, note: `best uses ${agentChoiceDiff.join(',') || 'same agents but different count'}` });
  }
  if ((best.templateVersion ?? null) !== (worst.templateVersion ?? null)) {
    differences.push({ field: 'workflowVersion', best: best.templateVersion ?? null, worst: worst.templateVersion ?? null });
  }
  const ctxDelta = delta(best.estimatedContextTokens, worst.estimatedContextTokens);
  if (ctxDelta != null && ctxDelta !== 0) {
    differences.push({ field: 'contextSize', best: best.estimatedContextTokens, worst: worst.estimatedContextTokens, delta: ctxDelta });
  }
  const bestTools = best.requiredTools ?? [];
  const worstTools = worst.requiredTools ?? [];
  if (JSON.stringify(bestTools.sort()) !== JSON.stringify(worstTools.sort())) {
    differences.push({ field: 'tools', best: bestTools, worst: worstTools });
  }
  const bestAttempts = best.attemptsPerNode ?? [];
  const worstAttempts = worst.attemptsPerNode ?? [];
  if (JSON.stringify(bestAttempts) !== JSON.stringify(worstAttempts)) {
    differences.push({ field: 'retries', best: bestAttempts, worst: worstAttempts });
  }
  if ((best.failureClass ?? null) !== (worst.failureClass ?? null)) {
    differences.push({ field: 'failureClass', best: best.failureClass ?? null, worst: worst.failureClass ?? null });
  }
  const latencyDelta = delta(best.latencyMs, worst.latencyMs);
  if (latencyDelta != null && latencyDelta !== 0) {
    differences.push({ field: 'latencyMs', best: best.latencyMs, worst: worst.latencyMs, delta: latencyDelta });
  }
  const costDelta = delta(best.cost, worst.cost);
  if (costDelta != null && costDelta !== 0) {
    differences.push({ field: 'cost', best: best.cost, worst: worst.cost, delta: costDelta });
  }
  return differences;
}

export function contrastSummary(differences) {
  if (!Array.isArray(differences)) {
    throw new ContrastError('CONTRAST_SUMMARY_INVALID', 'differences must be an array');
  }
  return differences.map((d) => {
    switch (d.field) {
      case 'agentChoice': return `agent choice: best=${d.best.join(',')} vs worst=${d.worst.join(',')} (${d.note})`;
      case 'workflowVersion': return `workflow version: best=${d.best} vs worst=${d.worst}`;
      case 'contextSize': return `context size: best=${d.best} vs worst=${d.worst} (delta ${d.delta})`;
      case 'tools': return `tools: best=${d.best.join(',')} vs worst=${d.worst.join(',')}`;
      case 'retries': return `retries: best=${JSON.stringify(d.best)} vs worst=${JSON.stringify(d.worst)}`;
      case 'failureClass': return `failure class: best=${d.best} vs worst=${d.worst}`;
      case 'latencyMs': return `latency: best=${d.best} vs worst=${d.worst} ms (delta ${d.delta})`;
      case 'cost': return `cost: best=${d.best} vs worst=${d.worst} (delta ${d.delta})`;
      default: return `${d.field}: ${JSON.stringify(d.best)} vs ${JSON.stringify(d.worst)}`;
    }
  });
}

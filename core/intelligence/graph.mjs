// Level 7 Task 1: evidence graph.
//
// Materializes a deterministic in-memory graph from the existing structured
// records (trajectory, evaluation, candidate/pattern, intelligence sources,
// knowledge index, package). Each edge carries a provenance class:
// EXTRACTED (direct mapping from a row field), INFERRED (derived link, e.g.
// candidate has evaluation reference), or AMBIGUOUS (multiple possible
// links, low confidence). The backend stays in-memory; persistence is
// deferred until the Level 4 storage gate thresholds are measured to be
// exceeded.

export class EvidenceGraphError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'EvidenceGraphError';
    this.code = code;
    if (details) this.details = details;
  }
}

export const PROVENANCE = Object.freeze(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']);

const NODE_TABLE_PREFIX = 'graph_node_';
const EDGE_TABLE_PREFIX = 'graph_edge_';

function safeKindId(kind) {
  return String(kind).toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

export function buildGraph({ store }) {
  if (!store || typeof store.readRows !== 'function' || typeof store.appendRow !== 'function') {
    throw new EvidenceGraphError('GRAPH_STORE_INVALID', 'buildGraph requires a StateStore');
  }
  const nodes = [];
  const edges = [];
  const seenNode = new Set();
  const addNode = (id, kind, attrs, provenance = 'EXTRACTED') => {
    const key = `${kind}:${id}`;
    if (seenNode.has(key)) return;
    seenNode.add(key);
    const node = { id, kind, attrs: { ...attrs }, provenance };
    nodes.push(node);
    store.appendRow(`${NODE_TABLE_PREFIX}${safeKindId(kind)}`, node);
  };
  const addEdge = (fromId, toId, kind, provenance) => {
    if (!PROVENANCE.includes(provenance)) {
      throw new EvidenceGraphError('GRAPH_PROVENANCE_INVALID', `provenance must be one of ${PROVENANCE.join(', ')}`);
    }
    const edge = { from: fromId, to: toId, kind, provenance };
    edges.push(edge);
    store.appendRow(`${EDGE_TABLE_PREFIX}${safeKindId(kind)}`, edge);
  };

  // Trajectory rows → graph nodes.
  for (const row of store.readRows('trajectory')) {
    addNode(row.runId, 'trajectory', { runId: row.runId, finalStatus: row.finalStatus, workflowId: row.workflowId, failureClass: row.failureClass, agentIds: row.agentIds ?? [] });
  }
  // Evaluation rows → graph nodes + edges (trajectory -> evaluation).
  for (const row of store.readRows('evaluation_score')) {
    const evaluatorId = `${row.evaluatorId}@${row.evaluatorVersion}`;
    addNode(evaluatorId, 'evaluator', { evaluatorId: row.evaluatorId, evaluatorVersion: row.evaluatorVersion, evaluatorKind: row.evaluatorKind, overall: row.overall, scores: row.scores });
    addNode(row.runId, 'trajectory', { runId: row.runId }); // ensure node exists even if trajectory missing
    addEdge(row.runId, evaluatorId, 'EVALUATED_BY', 'EXTRACTED');
  }
  // Evaluation raw → graph node (raw evidence).
  for (const row of store.readRows('evaluation_raw')) {
    const rawId = `${row.runId}::${row.evaluatorId}@${row.evaluatorVersion}::${row.evidenceKind}::${row._id}`;
    addNode(rawId, 'raw_evidence', { sourceId: row.runId, evaluatorId: row.evaluatorId, evaluatorVersion: row.evaluatorVersion, evidenceKind: row.evidenceKind, contentHash: row.contentHash, byteCount: row.byteCount });
  }
  // Candidate + candidate_history → graph nodes + lifecycle edges.
  const latestByCandidate = new Map();
  for (const row of store.readRows('candidate')) latestByCandidate.set(row.id, row);
  for (const row of latestByCandidate.values()) {
    addNode(row.id, 'candidate', { id: row.id, version: row.version, status: row.status, scope: row.scope, rule: row.rule });
  }
  for (const row of store.readRows('candidate_history')) {
    const historyId = `${row.candidateId}::${row.at}`;
    addNode(historyId, 'candidate_history', { candidateId: row.candidateId, from: row.from, to: row.to, actor: row.actor, evidenceRef: row.evidenceRef });
    addEdge(historyId, row.candidateId, 'TRANSITION_OF', 'EXTRACTED');
  }
  // Candidate benchmark rows → benchmark node + edge.
  for (const row of store.readRows('candidate_benchmark')) {
    const benchId = `bench::${row.candidateId}::${row.recordedAt}`;
    addNode(benchId, 'benchmark', { candidateId: row.candidateId, decision: row.decision, reasons: row.reasons ?? [], improvement: row.improvement, ci95: row.ci95 });
    addEdge(row.candidateId, benchId, 'EVALUATED_BY', 'INFERRED');
  }
  // Intelligence sources → graph nodes + extraction edges.
  for (const row of store.readRows('intelligence_source')) {
    addNode(row.id, 'intelligence_source', { id: row.id, kind: row.kind, tier: row.tier, canonicalUrl: row.canonicalUrl, retrievedAt: row.retrievedAt, doi: row.doi, repoIdentity: row.repoIdentity });
  }
  for (const row of store.readRows('intelligence_extraction')) {
    addNode(`${row.sourceId}@${row.version}`, 'extraction', { sourceId: row.sourceId, version: row.version, contentHash: row.contentHash });
    addEdge(`${row.sourceId}@${row.version}`, row.sourceId, 'EXTRACTED_FROM', 'EXTRACTED');
  }
  // Knowledge index rows.
  for (const row of store.readRows('knowledge_index')) {
    const knId = `knowledge::${row._id}`;
    addNode(knId, 'knowledge', { sourcePath: row.sourcePath, scope: row.scope, kind: row.kind, contentHash: row.contentHash });
  }
  // Packages (M-series).
  for (const row of store.readRows('package')) {
    addNode(row.id ?? row.name, 'package', { id: row.id, kind: row.kind, version: row.version ?? null, source: row.source ?? null });
  }

  // INFERRED: candidate evidence links to intelligence sources or trajectory rows.
  for (const candidate of latestByCandidate.values()) {
    for (const ref of candidate.evidenceLinks ?? []) {
      const refId = typeof ref === 'string' ? ref.replace(/^[^:]+:/, '') : null;
      if (!refId) continue;
      const existsInGraph = nodes.some((n) => n.id === refId);
      if (existsInGraph) {
        addEdge(candidate.id, refId, 'REFERENCES', 'INFERRED');
      }
    }
  }

  // INFERRED: candidate evidence links to intelligence sources or trajectory rows.
  for (const candidate of latestByCandidate.values()) {
    for (const ref of candidate.evidenceLinks ?? []) {
      const refId = typeof ref === 'string' ? ref.replace(/^[^:]+:/, '') : null;
      if (!refId) continue;
      const existsInGraph = nodes.some((n) => n.id === refId);
      if (existsInGraph) {
        addEdge(candidate.id, refId, 'REFERENCES', 'INFERRED');
      }
    }
  }

  // AMBIGUOUS placeholder edges: when a candidate lacks a recorded benchmark
  // and a raw evidence row but exists in history, link via AMBIGUOUS to the
  // latest evaluation_score (if any) to keep downstream "ambiguity" reasoning
  // reachable.
  for (const candidateId of latestByCandidate.keys()) {
    const evalRows = store.readRows('evaluation_score').filter((r) => r.runId === candidateId);
    if (evalRows.length === 0) {
      const evalRaw = store.readRows('evaluation_raw').filter((r) => r.runId === candidateId);
      for (const row of evalRaw) {
        const rawId = `${row.runId}::${row.evaluatorId}@${row.evaluatorVersion}::${row.evidenceKind}::${row._id}`;
        addEdge(candidateId, rawId, 'REFERENCES', 'AMBIGUOUS');
      }
    }
  }
  return Object.freeze({ nodes: Object.freeze([...nodes]), edges: Object.freeze([...edges]) });
}

export function queryNodes({ graph, kind = null, filter = null }) {
  if (!graph || !Array.isArray(graph.nodes)) throw new EvidenceGraphError('GRAPH_INVALID', 'graph must be a buildGraph result');
  return graph.nodes.filter((n) => (!kind || n.kind === kind) && (!filter || filter(n)));
}

export function queryEdges({ graph, kind = null, provenance = null }) {
  if (!graph || !Array.isArray(graph.edges)) throw new EvidenceGraphError('GRAPH_INVALID', 'graph must be a buildGraph result');
  return graph.edges.filter((e) => (!kind || e.kind === kind) && (!provenance || e.provenance === provenance));
}

export function path({ graph, fromId, toId }) {
  if (!graph || typeof fromId !== 'string' || typeof toId !== 'string') {
    throw new EvidenceGraphError('GRAPH_PATH_INVALID', 'graph, fromId and toId are required');
  }
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
  }
  const paths = [];
  const stack = [[{ from: null, to: fromId, kind: null, provenance: null }]];
  while (stack.length > 0) {
    const current = stack.pop();
    const tailNode = current[current.length - 1].to;
    if (tailNode === toId) {
      paths.push(current.slice(1));
      continue;
    }
    const next = adjacency.get(tailNode) ?? [];
    for (const edge of next) {
      stack.push([...current, edge]);
    }
  }
  return paths;
}

export function neighborsOf({ graph, id, maxDepth = 3 }) {
  if (!graph || typeof id !== 'string') {
    throw new EvidenceGraphError('GRAPH_NEIGHBORS_INVALID', 'graph and id are required');
  }
  const adjacency = new Map();
  for (const edge of graph.edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge);
  }
  const visitedNodes = new Set([id]);
  const visitedEdges = [];
  const queue = [[id, 0]];
  while (queue.length > 0) {
    const [node, depth] = queue.shift();
    if (depth >= maxDepth) continue;
    const edges = adjacency.get(node) ?? [];
    for (const edge of edges) {
      visitedEdges.push(edge);
      if (!visitedNodes.has(edge.to)) {
        visitedNodes.add(edge.to);
        queue.push([edge.to, depth + 1]);
      }
    }
  }
  return {
    nodes: graph.nodes.filter((n) => visitedNodes.has(n.id)),
    edges: visitedEdges,
  };
}

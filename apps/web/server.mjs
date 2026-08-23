import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspaceStatus } from '../../core/status.mjs';
import { StateStore } from '../../core/store.mjs';
import { queryTrajectory, trajectorySummary } from '../../core/trajectory.mjs';

const webRoot = path.dirname(fileURLToPath(import.meta.url));

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(body);
}

function storeFor(root) {
  return StateStore.open('default', { root: path.join(root, '.workbench', 'store') });
}

function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

async function evaluationPayload(root, url) {
  const store = storeFor(root);
  const rows = store.readRows('trajectory');
  const scoreRows = store.readRows('evaluation_score');
  const params = new URL(url, 'http://localhost').searchParams;
  const filtered = queryTrajectory({
    rows,
    agent: params.get('agent') || null,
    workflow: params.get('workflow') || null,
    status: params.get('status') || null,
    failureClass: params.get('failureClass') || null,
    minCost: num(params.get('minCost')),
    maxCost: num(params.get('maxCost')),
    maxLatencyMs: num(params.get('maxLatencyMs')),
  });
  const evaluatorVersion = params.get('evaluatorVersion') || null;
  const versioned = evaluatorVersion
    ? filtered.filter((row) => scoreRows.some((s) => s.runId === row.runId && s.evaluatorVersion === evaluatorVersion))
    : filtered;
  // Latest evaluator version per evaluator id present in the projection.
  const latestByEvaluator = {};
  for (const s of scoreRows) {
    const prev = latestByEvaluator[s.evaluatorId];
    if (!prev || s.evaluatorVersion > prev) latestByEvaluator[s.evaluatorId] = s.evaluatorVersion;
  }
  return {
    summary: trajectorySummary(versioned),
    rows: versioned,
    evaluators: latestByEvaluator,
  };
}

export function createServer({ root = path.resolve(webRoot, '../..'), manifestPath = path.join(root, 'workspace.json') } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method Not Allowed');
      if (req.url === '/api/status') {
        return send(res, 200, 'application/json', JSON.stringify(await getWorkspaceStatus(manifestPath)));
      }
      if (req.url.startsWith('/api/evaluation')) {
        return send(res, 200, 'application/json', JSON.stringify(await evaluationPayload(root, req.url)));
      }
      const asset = req.url === '/' ? 'index.html' : req.url === '/app.js' ? 'app.js' : null;
      if (!asset) return send(res, 404, 'text/plain', 'Not Found');
      const type = asset.endsWith('.js') ? 'text/javascript' : 'text/html';
      return send(res, 200, type, await fs.readFile(path.join(webRoot, asset), 'utf8'));
    } catch (error) {
      return send(res, 500, 'application/json', JSON.stringify({ error: error?.message ?? 'Internal Server Error' }));
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  createServer().listen(port, () => console.log(`workbench dashboard listening on http://localhost:${port}`));
}

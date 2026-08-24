import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createServer } from '../apps/web/server.mjs';

async function withServer(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-web-'));
  fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({
    version: '1', workspace: { id: 'web-test', name: 'Web Test' }, environment: { node: { version: '22' } },
  }));
  const server = createServer({ root, manifestPath: path.join(root, 'workspace.json') }).listen(0);
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); await once(server, 'close'); }
}

test('dashboard serves status JSON and static assets', async () => {
  await withServer(async (base) => {
    const status = await fetch(`${base}/api/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).workspace.id, 'web-test');
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/unknown`)).status, 404);
  });
});
test('dashboard exposes bilingual language controls', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'apps/web/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(process.cwd(), 'apps/web/app.js'), 'utf8');
  assert.match(html, /language-select/);
  assert.match(html, /简体中文/);
  assert.match(html, /English/);
  assert.match(app, /localStorage/);
  assert.match(app, /zh-CN/);
  assert.match(app, /en/);
});

// ---------- Level 4 Task 5: evaluation filters ----------------------------

import { StateStore } from '../core/store.mjs';
import { persistTrajectory } from '../core/trajectory.mjs';

function seedEvaluationStore(root) {
  const store = StateStore.open('default', { root: path.join(root, '.workbench', 'store') });
  persistTrajectory(store, {
    runId: 'r-ok', taskId: 't1', pipelineId: 'standard-development', templateVersion: '1.0.0',
    executionStatus: 'EXECUTION_SUCCEEDED', finalStatus: 'COMPLETED', cost: 5, latencyMs: 1000,
    startedAt: '2026-08-23T00:00:00.000Z', finishedAt: '2026-08-23T00:00:01.000Z',
    routing: { a: { agentId: 'alice' } }, evidenceClaims: [{ kind: 'test' }],
  });
  persistTrajectory(store, {
    runId: 'r-fail', taskId: 't2', pipelineId: 'standard-development', templateVersion: '1.0.0',
    executionStatus: 'FAILED', finalStatus: 'FAILED', cost: 50, latencyMs: 9000,
    startedAt: '2026-08-23T00:00:00.000Z', finishedAt: '2026-08-23T00:00:09.000Z',
    routing: { a: { agentId: 'bob' } }, nodes: { x: { status: 'FAILED' } }, actionStatus: 'stage_failed',
  });
  store.appendRow('evaluation_score', {
    runId: 'r-ok', evaluatorId: 'rule', evaluatorVersion: '1.0.0', evaluatorKind: 'rule',
    scores: { status: 1 }, overall: 'pass', deterministic: true, evaluatedAt: '2026-08-23T00:00:00.000Z',
  });
  return store;
}

test('dashboard /api/evaluation answers success rate, cost, latency and failure distribution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-web-eval-'));
  try {
    fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ version: '1', workspace: { id: 'web-eval' } }));
    seedEvaluationStore(root);
    const server = createServer({ root, manifestPath: path.join(root, 'workspace.json') }).listen(0);
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const payload = await (await fetch(`${base}/api/evaluation`)).json();
      assert.equal(payload.summary.total, 2);
      assert.equal(payload.summary.successRate, 0.5);
      assert.equal(payload.summary.avgCostUsd, 27.5);
      assert.equal(payload.summary.avgLatencyMs, 5000);
      assert.deepEqual(payload.summary.failureDistribution, { 'stage-failed': 1 });
      assert.deepEqual(payload.summary.byAgent, { alice: 1, bob: 1 });
      assert.equal(payload.evaluators.rule, '1.0.0');
    } finally {
      server.close();
      await once(server, 'close');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard /api/evaluation applies agent, status, cost, latency and evaluator-version filters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-web-eval2-'));
  try {
    fs.writeFileSync(path.join(root, 'workspace.json'), JSON.stringify({ version: '1', workspace: { id: 'web-eval2' } }));
    seedEvaluationStore(root);
    const server = createServer({ root, manifestPath: path.join(root, 'workspace.json') }).listen(0);
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const byAgent = await (await fetch(`${base}/api/evaluation?agent=alice`)).json();
      assert.deepEqual(byAgent.rows.map((r) => r.runId), ['r-ok']);
      const byStatus = await (await fetch(`${base}/api/evaluation?status=FAILED`)).json();
      assert.deepEqual(byStatus.rows.map((r) => r.runId), ['r-fail']);
      const byCost = await (await fetch(`${base}/api/evaluation?minCost=10&maxCost=100`)).json();
      assert.deepEqual(byCost.rows.map((r) => r.runId), ['r-fail']);
      const byLatency = await (await fetch(`${base}/api/evaluation?maxLatencyMs=2000`)).json();
      assert.deepEqual(byLatency.rows.map((r) => r.runId), ['r-ok']);
      const byFailure = await (await fetch(`${base}/api/evaluation?failureClass=stage-failed`)).json();
      assert.deepEqual(byFailure.rows.map((r) => r.runId), ['r-fail']);
      const byEvalVer = await (await fetch(`${base}/api/evaluation?evaluatorVersion=1.0.0`)).json();
      assert.deepEqual(byEvalVer.rows.map((r) => r.runId), ['r-ok']);
      const noMatch = await (await fetch(`${base}/api/evaluation?evaluatorVersion=9.9.9`)).json();
      assert.equal(noMatch.rows.length, 0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

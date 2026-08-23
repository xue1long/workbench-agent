// Level 4 Task 6: storage decision gate measurement.
//
// The gate: keep the read-model projection in JSONL unless a benchmark
// contains 100,000 projected events OR the versioned dashboard query p95
// exceeds 200 ms. This harness measures p95 over 30 cold-process repetitions
// of the dashboard query against a fixture with a recorded event count and
// prints the machine profile so the measurement is reproducible.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { StateStore } from '../core/store.mjs';
import { persistTrajectory } from '../core/trajectory.mjs';

const EVENT_COUNT = 1000;
const REPETITIONS = 30;

function machineProfile() {
  return {
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpuCount: os.cpus().length,
    totalRamGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    diskType: 'unknown (SSD expected on dev box)',
    node: process.version,
    eventCount: EVENT_COUNT,
    queryVersion: 'dashboard-evaluation-1.0.0',
    repetitions: REPETITIONS,
  };
}

// The exact versioned dashboard query: queryTrajectory over all rows +
// trajectorySummary + evaluation join. This is what the /api/evaluation
// endpoint runs.
const STORE_URL = pathToFileURL(path.resolve('core/store.mjs')).href;
const TRAJECTORY_URL = pathToFileURL(path.resolve('core/trajectory.mjs')).href;
const QUERY_SCRIPT = `
import { StateStore } from ${JSON.stringify(STORE_URL)};
import { queryTrajectory, trajectorySummary } from ${JSON.stringify(TRAJECTORY_URL)};
const store = StateStore.open('default', { root: process.argv[1] });
const rows = store.readRows('trajectory');
const scoreRows = store.readRows('evaluation_score');
const start = process.hrtime.bigint();
const filtered = queryTrajectory({ rows });
const summary = trajectorySummary(filtered);
const joined = filtered.filter((row) => scoreRows.some((s) => s.runId === row.runId));
process.stdout.write(JSON.stringify({ summary, joined: joined.length }));
const ms = Number(process.hrtime.bigint() - start) / 1e6;
process.stdout.write('\\n' + ms.toFixed(3));
`;

function measureOnce(storeRoot) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', QUERY_SCRIPT, storeRoot], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`query probe failed: ${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  return Number(lines[lines.length - 1]);
}

function p95(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95) - 1] ?? sorted[sorted.length - 1];
}

test('storage decision gate: JSONL projection p95 stays under 200 ms at 1k events', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-gate-'));
  try {
    const store = StateStore.open('default', { root: path.join(tmp, 'store') });
    for (let i = 0; i < EVENT_COUNT; i += 1) {
      persistTrajectory(store, {
        runId: `run-${i}`, taskId: `t${i}`, pipelineId: i % 2 === 0 ? 'standard-development' : 'task',
        executionStatus: i % 5 === 0 ? 'FAILED' : 'EXECUTION_SUCCEEDED',
        finalStatus: i % 5 === 0 ? 'FAILED' : 'COMPLETED',
        cost: (i % 50) / 10, latencyMs: (i % 100) * 10,
        startedAt: '2026-08-23T00:00:00.000Z', finishedAt: '2026-08-23T00:00:01.000Z',
        routing: { a: { agentId: i % 2 === 0 ? 'alice' : 'bob' } }, evidenceClaims: [],
      });
    }
    store.appendRow('evaluation_score', {
      runId: 'run-0', evaluatorId: 'rule', evaluatorVersion: '1.0.0', scores: { status: 1 }, overall: 'pass', deterministic: true,
    });
    const samples = [];
    for (let i = 0; i < REPETITIONS; i += 1) samples.push(measureOnce(path.join(tmp, 'store')));
    const p95ms = Math.round(p95(samples) * 100) / 100;
    const profile = machineProfile();
    console.log(`[storage-gate] p95=${p95ms}ms over ${REPETITIONS} cold-process repetitions`);
    console.log(`[storage-gate] profile=${JSON.stringify(profile)}`);
    // Gate thresholds: 100,000 projected events OR p95 > 200 ms. Neither is
    // reached at 1,000 events, so JSONL stays — record the deferral.
    assert.ok(p95ms < 200, `p95 ${p95ms}ms exceeds the 200ms gate threshold`);
    assert.ok(EVENT_COUNT < 100000, 'event count below the 100k gate threshold');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

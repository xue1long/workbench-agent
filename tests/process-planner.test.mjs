// Level 2 Task 9: structured planner adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ProcessPlanner, ProcessPlannerError } from '../adapters/process-planner.mjs';

function makeAgent() {
  return {
    id: 'planner-fixture',
    invocation: {
      executable: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.argv[1], JSON.stringify({task:{id:"t",goal:"g"},nodes:[{id:"n",goal:"g",acceptanceCriteria:[{id:"a",verifierRef:"diff",required:true}]}]}))', '{outputFile}'],
      timeoutMs: 5000,
    },
  };
}

function writePlanFixture(tmp, nodePayload) {
  const script = `
    const fs = require('fs');
    const out = process.argv[1];
    fs.writeFileSync(out, JSON.stringify(${JSON.stringify(nodePayload)}), 'utf8');
  `;
  return { script };
}

test('ProcessPlanner.plan returns a valid TaskGraph for a hand-crafted JSON output', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pp-'));
  try {
    const planPayload = {
      task: { id: 'planner-task', goal: 'plan me' },
      nodes: [
        { id: 'design', goal: 'design', acceptanceCriteria: [{ id: 'a1', verifierRef: 'diff', required: true }] },
      ],
    };
    const directPlanner = new (class extends ProcessPlanner {
      constructor() { super({ agent: { id: 'plan', invocation: { executable: process.execPath, args: ['-e', '0', '{outputFile}'], timeoutMs: 5000 } } }); }
      async _run() {
        return { stdout: JSON.stringify({
          task: { id: 'planner-task', goal: 'plan me' },
          nodes: [
            { id: 'design', goal: 'design', acceptanceCriteria: [{ id: 'a1', verifierRef: 'diff', required: true }] },
          ],
        }) };
      }
    })();
    const task = { id: 'planner-task', goal: 'plan me', context: {} };
    const graph = await directPlanner.plan(task, { sandboxPath: tmp });
    assert.equal(graph.task.id, 'planner-task');
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0].id, 'design');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ProcessPlanner rejects a cyclic provider response', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pp-'));
  try {
    const cyclic = {
      task: { id: 'cyc', goal: 'cycle' },
      nodes: [
        { id: 'a', goal: 'a', dependencies: ['b'], acceptanceCriteria: [{ id: 'a1', verifierRef: 'diff', required: true }] },
        { id: 'b', goal: 'b', dependencies: ['a'], acceptanceCriteria: [{ id: 'b1', verifierRef: 'diff', required: true }] },
      ],
    };
    fs.writeFileSync(path.join(tmp, 'cyclic.json'), JSON.stringify(cyclic), 'utf8');
    const directPlanner = new (class extends ProcessPlanner {
      constructor() { super({ agent: makeAgent() }); }
      async _run() {
        return { stdout: fs.readFileSync(path.join(tmp, 'cyclic.json'), 'utf8') };
      }
    })();
    await assert.rejects(
      () => directPlanner.plan({ id: 'cyc', goal: 'cycle' }, { sandboxPath: tmp }),
      (err) => err instanceof ProcessPlannerError && err.code === 'PLANNER_INVALID_GRAPH',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ProcessPlanner rejects malformed JSON output', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pp-'));
  try {
    const directPlanner = new (class extends ProcessPlanner {
      constructor() { super({ agent: makeAgent() }); }
      async _run() { return { stdout: 'not json' }; }
    })();
    await assert.rejects(
      () => directPlanner.plan({ id: 'p', goal: 'g' }, { sandboxPath: tmp }),
      (err) => err instanceof ProcessPlannerError && err.code === 'PLANNER_OUTPUT_INVALID',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ProcessPlanner rejects when the provider emits no output file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pp-'));
  try {
    const directPlanner = new (class extends ProcessPlanner {
      constructor() { super({ agent: makeAgent() }); }
      async _run() { return { stdout: '' }; }
    })();
    await assert.rejects(
      () => directPlanner.plan({ id: 'p', goal: 'g' }, { sandboxPath: tmp }),
      (err) => err instanceof ProcessPlannerError && err.code === 'PLANNER_OUTPUT_EMPTY',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ProcessPlanner rejects unknown verifier refs', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pp-'));
  try {
    const bad = {
      task: { id: 'bad', goal: 'g' },
      nodes: [{ id: 'a', goal: 'a', acceptanceCriteria: [{ id: 'aa', verifierRef: 'banana', required: true }] }],
    };
    fs.writeFileSync(path.join(tmp, 'bad.json'), JSON.stringify(bad), 'utf8');
    const directPlanner = new (class extends ProcessPlanner {
      constructor() { super({ agent: makeAgent() }); }
      async _run() { return { stdout: fs.readFileSync(path.join(tmp, 'bad.json'), 'utf8') }; }
    })();
    await assert.rejects(
      () => directPlanner.plan({ id: 'bad', goal: 'g' }, { sandboxPath: tmp }),
      (err) => err instanceof ProcessPlannerError,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ProcessPlanner rejects an oversized output', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pp-'));
  try {
    const directPlanner = new (class extends ProcessPlanner {
      constructor() { super({ agent: makeAgent() }); }
      async _run() { return { stdout: 'x'.repeat(2 * 1024 * 1024) }; }
    })();
    await assert.rejects(
      () => directPlanner.plan({ id: 'p', goal: 'g' }, { sandboxPath: tmp }),
      (err) => err instanceof ProcessPlannerError && err.code === 'PLANNER_OUTPUT_TOO_LARGE',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

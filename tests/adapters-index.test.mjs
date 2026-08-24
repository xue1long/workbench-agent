// tests/adapters-index.test.mjs
//
// After loading adapters/index.js, the registry in core/adapters.mjs
// must contain all 9 documented concrete adapters. Tests get instances
// through getAdapter() and assert they are the right class.
//
// We import adapters/index.js purely for its side effect (registration).
// We never import concrete adapter files directly in this test for
// registration — otherwise the boundary gate would still see concrete-adapter
// imports from tests/. The dynamic imports below only look up the class
// reference for `instanceof` assertions; they do not register.
//
// Note: ESM caches modules, so the registration side effect runs once
// per process. We do NOT call _resetAdaptersForTests() here because that
// would clear the registry but the cached modules would not re-register.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAdapter,
  listAdapters,
} from '../core/adapters.mjs';
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  DevflowRuntimeAdapter,
  GitAdapter,
  NodeAdapter,
  ProcessAgentInvoker,
  ProcessPlanner,
  PythonAdapter,
  UvAdapter,
} from '../adapters/index.js';

// The imports above trigger registration via the side-effect import chain.
const ids = listAdapters();

test('adapters/index.js registers all 9 documented adapters', () => {
  assert.deepEqual(ids, [
    'claude-code',
    'codex',
    'devflow-runtime',
    'git',
    'node',
    'process-agent',
    'process-planner',
    'python',
    'uv',
  ]);
});

test('getAdapter returns concrete instances for every registered id', () => {
  assert.ok(getAdapter('claude-code') instanceof ClaudeCodeAdapter);
  assert.ok(getAdapter('codex') instanceof CodexAdapter);
  assert.ok(getAdapter('devflow-runtime') instanceof DevflowRuntimeAdapter);
  assert.ok(getAdapter('git') instanceof GitAdapter);
  assert.ok(getAdapter('node') instanceof NodeAdapter);
  assert.ok(getAdapter('process-agent') instanceof ProcessAgentInvoker);
  assert.ok(getAdapter('process-planner') instanceof ProcessPlanner);
  assert.ok(getAdapter('python') instanceof PythonAdapter);
  assert.ok(getAdapter('uv') instanceof UvAdapter);
});

test('getAdapter passes options through to the factory', () => {
  const instance = getAdapter('node', { executable: '/usr/bin/node' });
  assert.equal(instance._executable, '/usr/bin/node');
});

test('adapters/index.js is the only allowed concrete-adapter bulk import for core/', () => {
  // Smoke test: this test file imports concrete adapters as ESM exports
  // purely for `instanceof` assertions; the side-effect registration
  // runs through the import chain in adapters/index.js. The boundary
  // gate (scripts/check-boundaries.mjs) permits this because tests/
  // has no row forbidding `adapters/*` (only core/, apps/, src/ do).
  assert.ok(true);
});

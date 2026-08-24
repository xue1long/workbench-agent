// adapters/index.js
//
// Single bulk import for the concrete adapter surface.
//
// Loading this file has the side effect of registering every concrete
// adapter (claude-code, codex, devflow-runtime, git, node, process-agent,
// process-planner, python, uv) with the adapter registry in
// core/adapters.mjs. Each adapter file owns its own registration call
// (see the bottom of each *.mjs); this index file just imports them all
// so production code can do:
//
//     import './adapters/index.js'; // one-time registration
//     const node = getAdapter('node');
//
// Production rule: this file is the ONLY place that imports concrete
// adapter files for their side effects. core/* and apps/* must go
// through `getAdapter(id)` instead. The boundary gate
// (scripts/check-boundaries.mjs) enforces that.

import './claude-code.mjs';
import './codex.mjs';
import './devflow-runtime.mjs';
import './git.mjs';
import './node.mjs';
import './process-agent.mjs';
import './process-planner.mjs';
import './python.mjs';
import './uv.mjs';

// Re-export the adapter classes so tests (and CLI bootstrap) can refer
// to them by name without re-importing the concrete files. Production
// code SHOULD obtain instances through getAdapter() from
// core/adapters.mjs instead.
export { ClaudeCodeAdapter } from './claude-code.mjs';
export { CodexAdapter } from './codex.mjs';
export { DevflowRuntimeAdapter } from './devflow-runtime.mjs';
export { GitAdapter } from './git.mjs';
export { NodeAdapter } from './node.mjs';
export { ProcessAgentInvoker } from './process-agent.mjs';
export { ProcessPlanner } from './process-planner.mjs';
export { PythonAdapter } from './python.mjs';
export { UvAdapter } from './uv.mjs';

// Level 2 Task 9: structured planner adapter.
//
// The configured planner receives a prompt file and must write one JSON plan
// file. We reuse the same provider-neutral runner as the Agent invoker so
// there is exactly one process abstraction in Core. The planner parses at
// most 1 MiB of output, deletes the temporary files immediately, and pipes
// the parsed object through ``createTaskGraph()`` for validation.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { runProcess } from './process-agent.mjs';
import { createTaskGraph, TaskGraphError } from '../core/task-graph.mjs';

export class ProcessPlannerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ProcessPlannerError';
    this.code = code;
    if (details) this.details = details;
  }
}

const MAX_OUTPUT = 1024 * 1024;

export class ProcessPlanner {
  constructor({ agent, runner } = {}) {
    if (!agent || typeof agent !== 'object') {
      throw new ProcessPlannerError('PLANNER_AGENT_INVALID', 'planner agent is required');
    }
    this._agent = agent;
    this._runner = typeof runner === 'function' ? runner : runProcess;
  }

  async _run({ executable, args, timeoutMs, cwd, promptFile, outputFile }) {
    const argv = args.map((a) => {
      if (a === '{promptFile}') return promptFile;
      if (a === '{outputFile}') return outputFile;
      if (a === '{cwd}') return cwd;
      return a;
    });
    const result = await this._runner({
      executable,
      args: argv,
      timeoutMs,
      cwd,
      prompt: undefined,
      sandboxPath: cwd,
    });
    let output = '';
    if (result?.stdout) output = result.stdout;
    return { stdout: output };
  }

  async plan(task, context = {}) {
    if (!task || typeof task !== 'object') {
      throw new ProcessPlannerError('PLANNER_TASK_INVALID', 'task must be an object');
    }
    const sandboxPath = context?.sandboxPath ?? os.tmpdir();
    const invocation = this._agent?.invocation ?? {};
    const executable = invocation.executable ?? process.execPath;
    const args = [...(invocation.args ?? [])];
    if (!args.some((a) => typeof a === 'string' && a.includes('{outputFile}'))) {
      throw new ProcessPlannerError('PLANNER_INVOCATION_INVALID', 'planner invocation must reference {outputFile}');
    }
    const tmpRoot = path.join(sandboxPath, '.workbench-planner');
    fs.mkdirSync(tmpRoot, { recursive: true });
    const promptFile = path.join(tmpRoot, `prompt-${randomUUID().slice(0, 8)}.json`);
    const outputFile = path.join(tmpRoot, `plan-${randomUUID().slice(0, 8)}.json`);
    const promptPayload = JSON.stringify({ task, schema: { taskFields: ['id', 'goal', 'context', 'priority', 'risk', 'budget', 'deadline'], nodeFields: ['id', 'goal', 'dependencies', 'capabilityRequired', 'requiredTools', 'acceptanceCriteria'] }, outputPath: outputFile }, null, 2);
    fs.writeFileSync(promptFile, promptPayload, 'utf8');
    try {
      const result = await this._run({
        executable,
        args,
        timeoutMs: invocation.timeoutMs ?? 60000,
        cwd: sandboxPath,
        promptFile,
        outputFile,
      });
      const stdout = (result?.stdout ?? '').trim();
      let raw;
      if (stdout) {
        if (stdout.length > MAX_OUTPUT) {
          throw new ProcessPlannerError('PLANNER_OUTPUT_TOO_LARGE', `planner stdout exceeded ${MAX_OUTPUT} bytes`);
        }
        raw = stdout;
      } else if (fs.existsSync(outputFile)) {
        const fileText = fs.readFileSync(outputFile, 'utf8');
        if (fileText.length > MAX_OUTPUT) {
          throw new ProcessPlannerError('PLANNER_OUTPUT_TOO_LARGE', `planner output file exceeded ${MAX_OUTPUT} bytes`);
        }
        raw = fileText;
      } else {
        throw new ProcessPlannerError('PLANNER_OUTPUT_EMPTY', 'planner produced no output file and no stdout');
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new ProcessPlannerError('PLANNER_OUTPUT_INVALID', `planner output is not valid JSON: ${err.message}`);
      }
      let graph;
      try {
        graph = createTaskGraph(parsed);
      } catch (err) {
        if (err instanceof TaskGraphError) {
          throw new ProcessPlannerError('PLANNER_INVALID_GRAPH', err.message, { code: err.code });
        }
        throw err;
      }
      return graph;
    } finally {
      try { fs.unlinkSync(promptFile); } catch (_) {}
      try { fs.unlinkSync(outputFile); } catch (_) {}
    }
  }
}

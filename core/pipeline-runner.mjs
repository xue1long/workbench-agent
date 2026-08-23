// Level 3 Task 4: pipeline runner with artifact persistence and resume.
//
// The runner compiles an immutable template + task into an ordinary Level 2
// TaskGraph and delegates execution to Orchestrator.runGraph, so every Level 2
// trust boundary applies unchanged. Its own responsibilities:
//
//   * artifact persistence: stage outputs declared as
//     `output.artifacts: [{ name, content, kind, scope }]` are written to
//     artifactsRoot/<pipelineId>/<stageId>/<name>; JSONL rows carry only
//     metadata plus sha256 digests — never the content.
//   * stage-state recording: one pipeline_stage row per stage per run.
//   * resume: with `resumeRunId`, a stage is reused only when its
//     definitionHash matches the compiled node AND every declared output
//     artifact still exists on disk with an unchanged sha256. Reused stages
//     short-circuit via Orchestrator.runGraph's skipNode, so no agent is
//     invoked and no side effect is duplicated.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compilePipeline } from './pipeline.mjs';
import { retrieve } from './knowledge-retrieval.mjs';

export class PipelineRunnerError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'PipelineRunnerError';
    this.code = code;
    if (details) this.details = details;
  }
}

const ARTIFACT_TABLE = 'pipeline_artifact';
const STAGE_TABLE = 'pipeline_stage';

function sha256Text(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export class PipelineRunner {
  constructor({ orchestrator, store, artifactsRoot = null, audit = null, knowledgeStore = null }) {
    if (!orchestrator || typeof orchestrator.runGraph !== 'function') {
      throw new PipelineRunnerError('PIPELINE_ORCHESTRATOR_INVALID', 'createPipelineRunner requires an orchestrator with runGraph');
    }
    if (!store || typeof store.appendRow !== 'function' || typeof store.readRows !== 'function') {
      throw new PipelineRunnerError('PIPELINE_STORE_INVALID', 'createPipelineRunner requires a StateStore');
    }
    this._orchestrator = orchestrator;
    this._store = store;
    this._artifactsRoot = artifactsRoot
      ? path.resolve(artifactsRoot)
      : path.resolve(process.cwd(), '.workbench', 'pipelines');
    this._audit = audit ?? null;
    this._knowledgeStore = knowledgeStore ?? null;
  }

  _artifactDir(pipelineId, stageId) {
    const dir = path.join(this._artifactsRoot, pipelineId, stageId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _persistArtifact({ pipelineId, stageId, name, content, kind = null, scope = null, runId }) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new PipelineRunnerError('PIPELINE_ARTIFACT_NAME_INVALID', `stage ${stageId} declared an artifact without a name`);
    }
    const safeName = path.basename(name);
    const dir = this._artifactDir(pipelineId, stageId);
    const filePath = path.join(dir, safeName);
    fs.writeFileSync(filePath, content, 'utf8');
    const contentHash = sha256Text(content);
    const prior = this._artifactMeta(pipelineId, stageId, safeName);
    const row = {
      pipelineId,
      runId,
      stageId,
      name: safeName,
      filePath: path.relative(this._artifactsRoot, filePath).replace(/\\/g, '/'),
      contentHash,
      byteCount: Buffer.byteLength(content, 'utf8'),
      kind,
      scope,
      producedBy: stageId,
      supersedes: prior ? prior._id : null,
    };
    const line = this._store.appendRow(ARTIFACT_TABLE, row);
    const parsed = JSON.parse(line);
    return { _id: parsed._id, name: safeName, filePath: row.filePath, contentHash, byteCount: row.byteCount, kind, scope, producedBy: stageId, runId };
  }

  _artifactMeta(pipelineId, stageId, name) {
    const rows = this._store.readRows(ARTIFACT_TABLE)
      .filter((r) => r.pipelineId === pipelineId && r.stageId === stageId && r.name === name)
      .sort((a, b) => (a._at < b._at ? -1 : a._at > b._at ? 1 : 0));
    return rows.length > 0 ? rows[rows.length - 1] : null;
  }

  _artifactHashesFor(pipelineId, stageId, outputNames) {
    const out = {};
    for (const name of outputNames) {
      const meta = this._artifactMeta(pipelineId, stageId, name);
      if (meta) out[name] = meta.contentHash;
    }
    return out;
  }

  _artifactRefsForRun(pipelineId, runId) {
    return this._store.readRows(ARTIFACT_TABLE)
      .filter((r) => r.pipelineId === pipelineId && r.runId === runId)
      .map((r) => ({ name: r.name, stageId: r.stageId, filePath: r.filePath, contentHash: r.contentHash, byteCount: r.byteCount, kind: r.kind, scope: r.scope }));
  }

  _loadStageHashes(pipelineId, runId) {
    const rows = this._store.readRows(STAGE_TABLE).filter((r) => r.pipelineId === pipelineId && r.runId === runId);
    const map = new Map();
    for (const row of rows) {
      map.set(row.stageId, { definitionHash: row.definitionHash, artifactHashes: row.artifactHashes ?? {}, evidenceClaims: row.evidenceClaims ?? [] });
    }
    return map;
  }

  _recordStage({ pipelineId, runId, stageId, definitionHash, status, artifactHashes, evidenceClaims }) {
    this._store.appendRow(STAGE_TABLE, {
      pipelineId,
      runId,
      stageId,
      definitionHash,
      status,
      artifactHashes,
      evidenceClaims,
    });
  }

  async run({ template, task, resumeRunId = null, approveChangeSet = null, options = {} }) {
    if (!template || typeof template !== 'object' || !Array.isArray(template.stages)) {
      throw new PipelineRunnerError('PIPELINE_TEMPLATE_INVALID', 'run requires a validated pipeline template');
    }
    if (!task || typeof task !== 'object') {
      throw new PipelineRunnerError('PIPELINE_TASK_INVALID', 'run requires a task');
    }
    const graph = compilePipeline(template, task);
    const pipelineId = template.id;
    const runId = options.runId ?? randomUUID();
    const stageById = new Map(template.stages.map((s) => [s.id, s]));

    let resumedFrom = null;
    let resumeHashes = null;
    if (resumeRunId) {
      resumeHashes = this._loadStageHashes(pipelineId, resumeRunId);
      resumedFrom = resumeRunId;
    }

    const skipNode = async (node) => {
      if (typeof options.skipNode === 'function') {
        const user = await options.skipNode(node);
        if (user && user.skip === true) return user;
      }
      if (!resumeHashes) return null;
      const prev = resumeHashes.get(node.id);
      if (!prev || prev.definitionHash !== node.definitionHash) return null;
      const outputs = stageById.get(node.id)?.outputs ?? [];
      const refs = [];
      for (const name of outputs) {
        const meta = this._artifactMeta(pipelineId, node.id, name);
        if (!meta) return null;
        // Verify the actual file on disk still exists with the recorded
        // sha256; a missing or edited artifact forces a re-run.
        let currentHash = null;
        try {
          currentHash = sha256Text(fs.readFileSync(path.join(this._artifactsRoot, meta.filePath), 'utf8'));
        } catch (_) {
          return null;
        }
        if (currentHash !== meta.contentHash) return null;
        if (currentHash !== (prev.artifactHashes[name] ?? null)) return null;
        refs.push({ name: meta.name, filePath: meta.filePath, contentHash: meta.contentHash, byteCount: meta.byteCount });
      }
      this._audit?.stageReused?.({ pipelineId, runId, stageId: node.id });
      return {
        skip: true,
        output: { reused: true, artifacts: refs },
        evidenceClaims: prev.evidenceClaims ?? [],
        message: 'reused verified stage',
      };
    };

    const transformResult = (node, result) => {
      const out = result.output ?? {};
      const declared = Array.isArray(out.artifacts) ? out.artifacts : [];
      const stage = stageById.get(node.id);
      const allowed = new Set(stage?.outputs ?? []);
      const refs = [];
      for (const art of declared) {
        if (typeof art.content === 'string') {
          const name = typeof art.name === 'string' ? path.basename(art.name) : null;
          if (!name || !allowed.has(name)) {
            throw new PipelineRunnerError('PIPELINE_UNDECLARED_ARTIFACT', `stage ${node.id} produced artifact ${JSON.stringify(art.name)} that is not among its declared outputs`, {
              stageId: node.id,
              declaredOutputs: [...allowed],
            });
          }
          refs.push(this._persistArtifact({
            pipelineId,
            stageId: node.id,
            name,
            content: art.content,
            kind: art.kind ?? null,
            scope: art.scope ?? null,
            runId,
          }));
        } else {
          // Already a reference (e.g. a reused artifact from resume).
          refs.push(art);
        }
      }
      return { ...result, output: { ...out, artifacts: refs } };
    };

    // Scoped knowledge wiring: stages that declare `knowledge` receive a
    // bounded, cited context package through the invoker call. The scope
    // boundary is enforced twice: the query scope must stay within the
    // stage's declared scope, and retrieve() applies the hard boundary.
    let materializedIndex = null;
    const knowledgeIndex = () => {
      if (!this._knowledgeStore) return [];
      if (materializedIndex) return materializedIndex;
      const rows = this._knowledgeStore.list();
      materializedIndex = rows.map((row) => ({ ...row, content: this._knowledgeStore.content(row) }));
      return materializedIndex;
    };
    const knowledgeUsage = new Map();
    const nodeContext = async (node) => {
      if (typeof options.nodeContext === 'function') {
        const extra = (await options.nodeContext(node)) ?? {};
        if (extra.knowledge) return extra;
      }
      const stage = stageById.get(node.id);
      const kn = stage?.knowledge;
      if (!kn || !this._knowledgeStore) return {};
      const stageScope = stage.scope ?? '.';
      if (kn.scope !== '.' && !`${kn.scope}/`.startsWith(`${stageScope.replace(/\/+$/, '')}/`)) {
        throw new PipelineRunnerError('PIPELINE_KNOWLEDGE_SCOPE', `stage ${node.id} knowledge scope ${kn.scope} exceeds its declared scope ${stageScope}`);
      }
      const result = retrieve({ index: knowledgeIndex(), query: kn.query, scope: kn.scope, budgetChars: kn.budgetChars ?? 8000 });
      knowledgeUsage.set(node.id, { items: result.items.length, budgetUsed: result.budgetUsed, sources: result.sources, scopeCapped: result.scopeCapped });
      return { knowledge: { items: result.items, budgetUsed: result.budgetUsed, sources: result.sources, scopeCapped: result.scopeCapped } };
    };

    const report = await this._orchestrator.runGraph(graph, task, {
      ...options,
      runId,
      approveChangeSet,
      skipNode,
      transformResult,
      nodeContext,
    });

    const stages = {};
    for (const [nodeId, state] of Object.entries(report.nodes)) {
      const stage = stageById.get(nodeId);
      const outputNames = stage?.outputs ?? [];
      const artifactHashes = this._artifactHashesFor(pipelineId, nodeId, outputNames);
      const evidenceClaims = Array.isArray(state.evidenceClaims) ? state.evidenceClaims : [];
      stages[nodeId] = {
        status: state.status,
        attempts: state.attempts,
        agentId: state.agentId,
        message: state.message,
        artifactHashes,
        evidenceClaims: evidenceClaims.map((c) => ({ kind: c.kind, ref: c.ref ?? c.payload?.ref ?? null })),
      };
      this._recordStage({
        pipelineId,
        runId,
        stageId: nodeId,
        definitionHash: state.node?.definitionHash ?? null,
        status: state.status,
        artifactHashes,
        evidenceClaims: stages[nodeId].evidenceClaims,
      });
    }

    const reviewState = stages.review;
    return {
      pipelineId,
      templateVersion: template.version,
      taskId: task.id,
      runId,
      resumedFrom,
      executionStatus: report.executionStatus,
      finalStatus: report.finalStatus,
      decision: report.decision ?? null,
      routing: report.routing ?? {},
      stages,
      artifacts: this._artifactRefsForRun(pipelineId, runId),
      changedFiles: Array.isArray(report.candidates)
        ? [...new Set(report.candidates.flatMap((c) => c.changedFiles ?? c.changeSet?.changedFiles ?? []))].sort()
        : [],
      evidence: stages.review?.evidenceClaims ?? [],
      reviewDecision: reviewState ? { stageId: 'review', status: reviewState.status, message: reviewState.message } : null,
      actionStatus: report.actionStatus ?? null,
      knowledge: Object.fromEntries(knowledgeUsage),
    };
  }

  async status({ pipelineId, runId }) {
    return pipelineRunStatus(this._store, pipelineId, runId);
  }
}

export function pipelineRunStatus(store, pipelineId, runId) {
  const rows = store.readRows(STAGE_TABLE).filter((r) => r.pipelineId === pipelineId && r.runId === runId);
  const stages = {};
  for (const row of rows) {
    stages[row.stageId] = {
      status: row.status,
      definitionHash: row.definitionHash,
      artifactHashes: row.artifactHashes ?? {},
      evidenceClaims: row.evidenceClaims ?? [],
    };
  }
  return { pipelineId, runId, stages };
}

export function createPipelineRunner(deps) {
  return new PipelineRunner(deps);
}

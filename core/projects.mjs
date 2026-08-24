// Project Manager — syncs a workspace's declared projects onto the host.
//
// A `ProjectDefinition` mirrors the manifest shape:
//   { id, source: { type: 'git'|'local', url?, ref? }, branch?, path }
//
// `sync(projects, root, options)` walks the list and:
//   * For type='local' sources, asserts the path is on disk; creates the
//     directory if missing.
//   * For type='git' sources, clones if missing, fetches+checks out otherwise.
//     Force-push / branch-delete / `reset --hard` are refused.
//
// The function never deletes a project directory once created.

import path from 'node:path';
import fs from 'node:fs';
import { GitAdapter } from '../adapters/git.mjs';

export class ProjectError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ProjectError';
    this.code = options.code ?? 'PROJECT_ERROR';
    this.projectId = options.projectId ?? null;
    this.cause = options.cause ?? null;
  }
}

const VALID_PROJECT_ID = /^[A-Za-z0-9._-]+$/;

export function validateProject(proj) {
  if (!proj || typeof proj !== 'object' || Array.isArray(proj)) {
    throw new ProjectError('project must be an object', { code: 'PROJECT_SHAPE_ERROR' });
  }
  if (typeof proj.id !== 'string' || proj.id.length === 0 || !VALID_PROJECT_ID.test(proj.id)) {
    throw new ProjectError(`project.id "${proj.id}" is missing or has illegal characters`, {
      code: 'PROJECT_FIELD_INVALID',
      projectId: proj.id,
    });
  }
  if (!proj.source || typeof proj.source !== 'object') {
    throw new ProjectError(`project "${proj.id}" is missing source`, {
      code: 'PROJECT_FIELD_REQUIRED',
      projectId: proj.id,
    });
  }
  if (!['git', 'local'].includes(proj.source.type)) {
    throw new ProjectError(`project "${proj.id}" source.type must be git or local`, {
      code: 'PROJECT_FIELD_INVALID',
      projectId: proj.id,
    });
  }
  if (proj.source.type === 'git' && (typeof proj.source.url !== 'string' || proj.source.url.length === 0)) {
    throw new ProjectError(`project "${proj.id}" source.url is required for git sources`, {
      code: 'PROJECT_FIELD_REQUIRED',
      projectId: proj.id,
    });
  }
  if (typeof proj.path !== 'string' || proj.path.length === 0) {
    throw new ProjectError(`project "${proj.id}" path is required`, {
      code: 'PROJECT_FIELD_REQUIRED',
      projectId: proj.id,
    });
  }
}

function resolveProjectPath(root, projPath) {
  // Disallow absolute paths outside `root` to prevent path traversal.
  const absolute = path.isAbsolute(projPath) ? path.resolve(projPath) : path.resolve(root, projPath);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ProjectError(`project path "${projPath}" escapes workspace root "${root}"`, {
      code: 'PROJECT_PATH_ESCAPE',
    });
  }
  return absolute;
}

export class ProjectManager {
  constructor(options = {}) {
    this._git = options.git ?? new GitAdapter(options.gitOptions ?? {});
    this._fs = options.fs ?? fs;
  }
  /**
   * Sync one project. Returns `{ id, status, changed, message, details }`.
   */
  syncOne(project, root) {
    validateProject(project);
    const target = resolveProjectPath(root, project.path);
    const exists = this._fs.existsSync(target);
    if (project.source.type === 'local') {
      if (!exists) {
        this._fs.mkdirSync(target, { recursive: true });
        return { id: project.id, status: 'CREATED', changed: true, message: `created local project directory ${target}`, details: { target } };
      }
      return { id: project.id, status: 'PRESENT', changed: false, message: `local project already present at ${target}`, details: { target } };
    }
    // git source
    if (!exists) {
      this._git.clone(project.source.url, target, project.source.ref ?? project.branch ?? null);
      return { id: project.id, status: 'CLONED', changed: true, message: `cloned ${project.source.url} to ${target}`, details: { target } };
    }
    this._git.fetch(target);
    const sha = this._git.headCommit(target);
    return { id: project.id, status: 'FETCHED', changed: false, message: `fetched; HEAD=${sha}`, details: { target, sha } };
  }
  /**
   * Sync many projects; stops on first failure unless `options.continueOnError`.
   */
  sync(projects, root, options = {}) {
    if (!Array.isArray(projects)) {
      throw new ProjectError('projects must be an array', { code: 'PROJECT_BAD_INPUT' });
    }
    const continueOnError = options.continueOnError === true;
    const results = [];
    let failed = 0;
    for (const project of projects) {
      try {
        results.push(this.syncOne(project, root));
      } catch (err) {
        failed += 1;
        const report = {
          id: project?.id ?? '<unknown>',
          status: 'FAILED',
          changed: false,
          message: err.message,
          details: {},
          error: { code: err.code ?? 'PROJECT_ERROR', message: err.message },
        };
        results.push(report);
        if (!continueOnError) {
          return {
            ok: false,
            workspace: root,
            projects: results,
            summary: { total: projects.length, synced: results.length - 1, failed },
          };
        }
      }
    }
    return {
      ok: failed === 0,
      workspace: root,
      projects: results,
      summary: { total: projects.length, synced: results.length - failed, failed },
    };
  }
  /**
   * Verify a project's working-tree state. Pure read.
   */
  verifyOne(project, root) {
    validateProject(project);
    const target = resolveProjectPath(root, project.path);
    if (!this._fs.existsSync(target)) {
      return { id: project.id, status: 'MISSING', changed: false, message: `${target} does not exist`, details: { target } };
    }
    if (project.source.type === 'local') {
      return { id: project.id, status: 'PRESENT', changed: false, message: 'local project present', details: { target } };
    }
    const status = this._git.status(target);
    return {
      id: project.id,
      status: status.dirty ? 'DIRTY' : 'CLEAN',
      changed: false,
      message: status.dirty ? `${status.files.length} modified file(s)` : 'working tree clean',
      details: { target, files: status.files },
    };
  }
}

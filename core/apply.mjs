// Workspace Core apply engine (M2).
//
// `applyPlan(plan, adapters, options)` consumes an ExecutionPlan and an
// adapter map, then either previews or actually executes each step. The
// engine enforces the runtime invariants required by the Level 1 spec:
//
//   * dry-run by default; mutation requires `options.apply = true`.
//   * Plan-action SKIP steps are no-ops; INSTALL/UPDATE route to the adapter.
//   * Failed steps short-circuit downstream steps (marked BLOCKED, never
//     FAILED, so the report makes it obvious what was *not* attempted).
//     BLOCKED is the engine-status; the plan action SKIP remains on the
//     record (`action` field) so the two vocabularies don't collide.
//   * Idempotency at the applyPlan boundary: a plan is idempotent iff it
//     was built from the host's *current* observed state. To make a re-apply
//     a no-op, the caller must re-plan — call adapter.detect() again, re-run
//     diffResource, hand the resulting plan back to applyPlan. The CLI does
//     this on every invocation. applyPlan itself does NOT re-detect; that
//     is by design, so a caller can dry-run a stored plan without touching
//     the host.
//   * Retry/skip/rollback actions are recorded but not orchestrated here.
//     Higher layers can replay them by calling `applyPlan` with a custom
//     `onStep` or by re-issuing the original plan once the root cause is
//     fixed. SQLite-backed audit arrives in Task 4.
//
// Options:
//   apply         boolean, default false (dry-run preview)
//   stopOnFailure boolean, default true; false runs remaining steps after failure
//   log(evt)      optional observer for { level, message, resource }
//   onStep(rec, result)  per-step callback (awaited)
//
// The function returns an `ApplyReport`:
//   {
//     workspace: string,
//     dryRun: boolean,
//     changed: boolean,
//     summary: { total, applied, blocked, failed, noChange },
//     steps: [
//       { resource, action, status: APPLIED|FAILED|BLOCKED|NO_CHANGE|PREVIEW,
//         message, details, before, after, error? }
//     ],
//     error?: { message, code, resource, action },
//     appliedState: AppliedState
//   }

import { AdapterError } from './adapters.mjs';
import { AppliedState, AppliedStep } from './state.mjs';

const NO_CHANGE_ACTIONS = new Set(['SKIP']);

export class ApplyError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ApplyError';
    this.code = options.code ?? 'APPLY_FAILED';
    this.resource = options.resource ?? null;
    this.action = options.action ?? null;
    this.cause = options.cause ?? null;
  }
}

function statusFor(action, result) {
  // An adapter that returned nothing (undefined / null) or threw without
  // going through the catch path must NOT be reported as APPLIED. Treat the
  // absence of a result as a soft failure — the catch block will already
  // have set status='FAILED' for thrown errors, but a buggy adapter that
  // resolves to nothing must surface here too.
  if (result == null) return 'FAILED';
  if (result.success === false) return 'FAILED';
  if (NO_CHANGE_ACTIONS.has(action)) return 'NO_CHANGE';
  if (result.changed === false) return 'NO_CHANGE';
  return 'APPLIED';
}

export async function applyPlan(plan, adapters, options = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps)) {
    throw new ApplyError('applyPlan requires a plan with a steps array', { code: 'APPLY_BAD_PLAN' });
  }
  if (!(adapters instanceof Map) && adapters && typeof adapters === 'object') {
    adapters = new Map(Object.entries(adapters));
  }
  if (!(adapters instanceof Map)) {
    throw new ApplyError('applyPlan requires an adapter map or plain object', { code: 'APPLY_BAD_ADAPTERS' });
  }

  const dryRun = options.apply !== true;
  const stopOnFailure = options.stopOnFailure !== false;
  const log = options.log ?? (() => {});
  const onStep = typeof options.onStep === 'function' ? options.onStep : null;
  const audit = options.audit ?? null;
  const stateStore = options.stateStore ?? null;
  if (audit) audit.executionStarted(plan, dryRun ? 'dry-run' : 'apply');
  if (stateStore) stateStore.recordExecution({ plan, report: null, mode: dryRun ? 'dry-run' : 'apply' });

  const steps = [];
  const summary = { total: plan.steps.length, applied: 0, blocked: 0, failed: 0, noChange: 0 };
  let failed = false;
  let error = null;

  for (const step of plan.steps) {
    if (failed && stopOnFailure) {
      const blockedRecord = {
        resource: step.resource,
        action: step.action,
        // BLOCKED = downstream of a failed step (not the same as plan-action
        // SKIP). Decoupling the two avoids overloading 'SKIPPED' across the
        // plan-action vocabulary and the apply-status vocabulary.
        status: 'BLOCKED',
        message: 'dependency step failed',
        details: {},
        before: step.previous,
        after: null,
        version: step.version,
      };
      steps.push(blockedRecord);
      summary.blocked += 1;
      if (audit) audit.stepApplied(blockedRecord);
      continue;
    }
    const adapter = adapters.get(step.resource);
    if (!adapter) {
      failed = true;
      error = { message: `no adapter registered for resource "${step.resource}"`, code: 'APPLY_NO_ADAPTER', resource: step.resource, action: step.action };
      const noAdapterRecord = {
        resource: step.resource,
        action: step.action,
        status: 'FAILED',
        message: error.message,
        details: {},
        before: step.previous,
        after: null,
        version: step.version,
        error: { code: error.code },
      };
      steps.push(noAdapterRecord);
      summary.failed += 1;
      log({ level: 'error', message: error.message, resource: step.resource });
      if (audit) audit.stepApplied(noAdapterRecord);
      continue;
    }

    if (dryRun) {
      const preview = {
        resource: step.resource,
        action: step.action,
        status: 'PREVIEW',
        message: `would ${step.action.toLowerCase()} ${step.resource} ${step.version}`,
        details: {},
        before: step.previous,
        after: step.action === 'SKIP' ? (step.previous ?? step.version) : step.version,
        version: step.version,
      };
      steps.push(preview);
      summary.noChange += 1;
      log({ level: 'info', message: preview.message, resource: step.resource });
      if (audit) audit.stepApplied(preview);
      if (onStep) await onStep(preview, null);
      continue;
    }

    let result;
    try {
      if (step.action === 'INSTALL') result = await adapter.install(step.version);
      else if (step.action === 'UPDATE') result = await adapter.update(step.version);
      else if (step.action === 'SKIP') {
        // SKIP does not call the adapter. Verified in the second pass via verify().
        result = { success: true, changed: false, status: 'NO_CHANGE', message: '', details: {} };
      } else {
        throw new ApplyError(`unsupported action "${step.action}"`, { code: 'APPLY_BAD_ACTION', resource: step.resource, action: step.action });
      }
    } catch (err) {
      failed = true;
      const wrapped = err instanceof AdapterError
        ? { message: err.message, code: err.code, resource: err.resource ?? step.resource, action: err.action ?? step.action }
        : { message: err.message, code: 'APPLY_EXCEPTION', resource: step.resource, action: step.action, cause: err };
      error = wrapped;
      const failedRecord = {
        resource: step.resource,
        action: step.action,
        status: 'FAILED',
        message: wrapped.message,
        details: {},
        before: step.previous,
        after: null,
        version: step.version,
        error: { code: wrapped.code },
      };
      steps.push(failedRecord);
      summary.failed += 1;
      log({ level: 'error', message: wrapped.message, resource: step.resource });
      if (audit) audit.stepApplied(failedRecord);
      if (onStep) await onStep(steps[steps.length - 1], null);
      continue;
    }

    const status = statusFor(step.action, result);
    const record = {
      resource: step.resource,
      action: step.action,
      status,
      message: result?.message ?? '',
      details: result?.details ?? {},
      // before/after capture the host state transition (what was there -> what
      // is there now). For SKIP steps `before` is null by design (diffResource
      // doesn't track previous for SKIP) and `after` defaults to the current
      // version so callers can still display a meaningful value.
      before: step.previous,
      after: status === 'NO_CHANGE' ? (step.previous ?? step.version) : step.version,
      version: step.version,
      error: null,
    };
    steps.push(record);
    if (status === 'FAILED') {
      failed = true;
      error = { message: result?.message || `${step.resource} ${step.action} failed`, code: result?.code ?? 'APPLY_ADAPTER_FAILED', resource: step.resource, action: step.action };
      record.error = { code: error.code };
      summary.failed += 1;
    } else if (status === 'NO_CHANGE') {
      summary.noChange += 1;
    } else {
      summary.applied += 1;
    }
    log({ level: status === 'FAILED' ? 'error' : 'info', message: record.message || `${status} ${step.resource}`, resource: step.resource });
    if (audit) audit.stepApplied(record);
    if (onStep) await onStep(record, result);
  }

  const changed = !dryRun && summary.applied > 0;
  const report = {
    workspace: plan.workspace ?? null,
    dryRun,
    changed,
    summary,
    steps,
  };
  if (error) report.error = error;
  if (audit) audit.executionFinished(report);
  if (stateStore) stateStore.recordExecution({ plan, report, mode: dryRun ? 'dry-run' : 'apply' });
  report.appliedState = new AppliedState(
    plan.workspace ?? 'unknown',
    steps.map((s) => new AppliedStep({
      resource: s.resource,
      action: s.action,
      version: s.after,
      previous: s.before,
      // Map the engine status onto the AppliedStep lifecycle vocabulary:
      //   APPLIED  -> APPLIED     (mutation succeeded)
      //   NO_CHANGE-> APPLIED     (work was intended but host already matched; e.g. SKIP plan)
      //   PREVIEW  -> SKIPPED     (dry-run, nothing actually executed)
      //   BLOCKED  -> SKIPPED     (downstream of a failed step)
      //   FAILED   -> FAILED      (adapter refused or threw)
      status: s.status === 'APPLIED' || s.status === 'NO_CHANGE' ? 'APPLIED'
        : s.status === 'PREVIEW' ? 'SKIPPED'
        : s.status === 'BLOCKED' ? 'SKIPPED'
        : 'FAILED',
      message: s.message,
      details: s.details,
      error: s.error ?? null,
    }))
  );
  return report;
}

export function isNoChanges(report) {
  if (!report) return false;
  return report.summary.applied === 0
    && report.summary.failed === 0
    && (report.summary.blocked ?? 0) === 0;
}
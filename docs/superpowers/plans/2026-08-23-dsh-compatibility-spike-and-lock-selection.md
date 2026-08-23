# DSH Compatibility Spike and Lock Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, with repeatable black-box evidence, whether published dsh can safely serve as the Workbench core; migrate the repository to Node.js 24 and pnpm 11.7.0; and lock exactly one dsh release only if every Phase 0 architecture and security gate passes.

**Architecture:** Keep the accepted Workbench implementation untouched while a self-contained `spikes/dsh-compat` harness installs and launches two exact published dsh versions in disposable homes. Node's standard library drives processes, temporary Git repositories, HTTP probes, filesystem snapshots, and evidence hashing. Each probe writes a normalized JSON result; one decision module fails closed unless every required capability passes. `0.1.0-rc.8` is the baseline and `0.1.1-rc.2` is the upgrade candidate, not an assumed winner.

**Tech Stack:** Node.js 24 LTS ESM, pnpm 11.7.0, built-in `node:test`, published `@deepseek-ai/dsh` packages, Git CLI, existing DevFlow Runtime test fixture, SHA-256 from `node:crypto`; no test framework or orchestration dependency is added.

**Spec:** `docs/superpowers/specs/2026-08-23-dsh-core-plugin-architecture-design.md`, especially Sections 4, 7, 13-19 and Phase 0.

## Global Constraints

- Work in an isolated Git worktree created with `superpowers:using-git-worktrees`; never run the spike against the user's canonical checkout.
- Preserve the 414-test Level 4 baseline. The spike may add tests and evidence but may not move, rewrite, or delete accepted business modules.
- Test only exact published versions: `@deepseek-ai/dsh@0.1.0-rc.8` and `@deepseek-ai/dsh@0.1.1-rc.2`. Do not use `latest`, ranges, Git branches, or source checkouts.
- Use a fresh temporary `DSH_HOME` and a fresh temporary Git repository for every test. Never reuse `~/.dsh` or a developer's credentials.
- Do not require a real model API key. A gate that cannot be exercised with a deterministic local adapter or published test seam is `FAIL`, not `SKIP`.
- No Host, Agent Loop, Session, Tool, Sandbox, Storage, or Web source patch may turn a failure into a pass.
- Never persist the canary secret. The scanner must cover Session stores, candidate checkouts, temporary files, journals/WAL, indices, evidence payloads, stdout, and stderr.
- A probe result is immutable JSON. Re-running creates a new run directory; it never edits old evidence.
- One required failure makes the version ineligible. If both versions are ineligible, record `REJECT_DSH_CORE` and stop before Plan 2.
- Every non-trivial module starts with one focused failing test, then the full suite must pass.
- Each task commits only its own files. Do not stage the currently modified architecture spec unless the user separately asks to commit it.

---

## Phase 0: Execution Readiness

### Task 0: Isolate the work and capture the accepted baseline

**Files:**
- Create: `docs/dsh-compatibility/baseline.md`

**Interfaces:**
- Records: Git commit, Node version, pnpm version, OS, `npm test` count, and the SHA-256 digest of `package.json` before migration.

- [ ] **Step 1: Create the isolated worktree**

  Invoke `superpowers:using-git-worktrees`, create a sibling worktree named `workbench-dsh-spike`, and run every later command there.

- [ ] **Step 2: Verify the toolchain without changing it**

  Run:

  ```powershell
  node --version
  pnpm --version
  git --version
  ```

  Expected: Node starts with `v24.`, pnpm is callable, and Git exits 0. Record the current pnpm version even when it differs; Task 2 activates repository-pinned pnpm 11.7.0 through Corepack without installing a global package.

- [ ] **Step 3: Run the accepted suite twice**

  Run twice:

  ```powershell
  npm test
  ```

  Expected each time: 414 passing tests and zero failures. If the count differs, update `baseline.md` with the observed count only after checking the current acceptance document; any failure stops the plan.

- [ ] **Step 4: Write `docs/dsh-compatibility/baseline.md`**

  Use this exact shape, replacing command-derived values:

  ```markdown
  # DSH Compatibility Baseline

  - Commit: `<git rev-parse HEAD>`
  - Node: `<node --version>`
  - pnpm: `<pnpm --version>`
  - OS: `<node -p "process.platform + ' ' + process.arch">`
  - Existing suite: `414/414`, two clean runs
  - package.json SHA-256: `<Get-FileHash package.json -Algorithm SHA256>`
  ```

- [ ] **Step 5: Commit**

  ```powershell
  git add docs/dsh-compatibility/baseline.md
  git commit -m "docs: record dsh spike baseline"
  ```

---

### Task 1: Define a fail-closed evidence contract

**Files:**
- Create: `spikes/dsh-compat/lib/evidence.mjs`
- Create: `tests/dsh-compat-evidence.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `requiredProbeIds` — frozen array of every hard gate.
- Produces: `normalizeProbeResult({ probeId, version, status, observations, artifacts })`.
- Produces: `decideVersion(results, version) -> { version, decision: 'PROMOTE'|'REJECT', failures, evidenceDigest }`.
- Produces: `decideCore(results) -> { decision: 'PROMOTE'|'HOLD'|'REJECT_DSH_CORE', selectedVersion, upgradeFrom, upgradeTo }`.

- [ ] **Step 1: Write the failing contract test**

  Assert the exact required IDs:

  ```js
  const required = [
    'profile-host-plugin', 'web-client-plugin', 'remote-call',
    'conversation-node', 'settings-card', 'workspace-access',
    'agent-subagent-candidate-binding', 'git-admin-denial',
    'sandbox-boundary', 'session-encryption', 'secret-redaction',
    'storage-atomicity', 'storage-locking', 'storage-recovery',
    'storage-provider-registration', 'web-approval-identity',
    'headless-approval-identity', 'devflow-dispatch-recovery',
    'distinct-approval-semantics', 'web-boot', 'headless-boot'
  ]
  ```

  Test that a missing result, `SKIP`, duplicate probe ID, version mismatch, or any status except `PASS` rejects a version. Test that core promotion requires both versions to pass and selects `0.1.1-rc.2`; one passing version produces `HOLD`; neither passing produces `REJECT_DSH_CORE`.

- [ ] **Step 2: Verify the test fails**

  ```powershell
  node --test tests/dsh-compat-evidence.test.mjs
  ```

- [ ] **Step 3: Implement the minimum evidence module**

  Use `node:crypto`, canonical JSON keys sorted recursively, and no dependency. A result has this shape:

  ```js
  {
    schema: 'workbench-dsh-probe-1',
    probeId: 'web-boot',
    version: '0.1.1-rc.2',
    status: 'PASS',
    observations: [{ name: 'loopback', value: '127.0.0.1' }],
    artifacts: [{ path: 'web/stdout.txt', sha256: '...' }]
  }
  ```

  Reject unknown fields so evidence cannot silently change meaning.

- [ ] **Step 4: Ignore generated runs, not fixtures**

  Append:

  ```gitignore
  # DSH compatibility probe output
  .dsh-compat-runs/
  spikes/dsh-compat/.installed/
  ```

- [ ] **Step 5: Run focused and full tests**

  ```powershell
  node --test tests/dsh-compat-evidence.test.mjs
  npm test
  ```

- [ ] **Step 6: Commit**

  ```powershell
  git add .gitignore spikes/dsh-compat/lib/evidence.mjs tests/dsh-compat-evidence.test.mjs
  git commit -m "test: define fail-closed dsh compatibility evidence"
  ```

---

### Task 2: Migrate the repository toolchain and lock the candidate matrix

**Files:**
- Modify: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `pnpm-lock.yaml`
- Create: `spikes/dsh-compat/package.json`
- Create: `tests/dsh-compat-toolchain.test.mjs`

**Interfaces:**
- Root package declares Node `>=24 <25` and `packageManager: pnpm@11.7.0`.
- Workspace contains the spike package only; production packages are introduced by Plan 2.
- Spike dependencies use exact versions and cannot leak into the root runtime.

- [ ] **Step 1: Write the failing toolchain test**

  Parse root and spike manifests and assert:

  ```js
  assert.equal(root.engines.node, '>=24 <25')
  assert.equal(root.packageManager, 'pnpm@11.7.0')
  assert.equal(spike.dependencies['@deepseek-ai/dsh-rc8'], 'npm:@deepseek-ai/dsh@0.1.0-rc.8')
  assert.equal(spike.dependencies['@deepseek-ai/dsh-rc2'], 'npm:@deepseek-ai/dsh@0.1.1-rc.2')
  ```

  Also assert dependency values contain no `^`, `~`, `*`, Git URL, or dist-tag.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-toolchain.test.mjs
  ```

- [ ] **Step 3: Edit `package.json`**

  Preserve `test`, `start`, and all existing metadata. Set:

  ```json
  "engines": { "node": ">=24 <25" },
  "packageManager": "pnpm@11.7.0",
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "test:dsh-compat": "node --test tests/dsh-compat-*.test.mjs",
    "probe:dsh": "node spikes/dsh-compat/run.mjs",
    "start": "node src/workbench.mjs"
  }
  ```

- [ ] **Step 4: Create workspace and spike manifests**

  `pnpm-workspace.yaml`:

  ```yaml
  packages:
    - spikes/dsh-compat
  ```

  `spikes/dsh-compat/package.json`:

  ```json
  {
    "name": "@workbench/dsh-compat-spike",
    "private": true,
    "type": "module",
    "dependencies": {
      "@deepseek-ai/dsh-rc8": "npm:@deepseek-ai/dsh@0.1.0-rc.8",
      "@deepseek-ai/dsh-rc2": "npm:@deepseek-ai/dsh@0.1.1-rc.2"
    }
  }
  ```

- [ ] **Step 5: Activate pnpm and create the frozen lock**

  ```powershell
  corepack enable
  corepack prepare pnpm@11.7.0 --activate
  pnpm install --lockfile-only
  pnpm install --frozen-lockfile
  ```

  If aliases do not expose two independent `dsh` binaries, keep the dependencies for metadata inspection and have the runner invoke each resolved `lib/bin.js` by package path. Do not install a global CLI.

- [ ] **Step 6: Verify baseline and frozen reinstall**

  ```powershell
  pnpm test
  pnpm test:dsh-compat
  pnpm install --frozen-lockfile
  ```

- [ ] **Step 7: Commit**

  ```powershell
  git add package.json pnpm-workspace.yaml pnpm-lock.yaml spikes/dsh-compat/package.json tests/dsh-compat-toolchain.test.mjs
  git commit -m "build: adopt node 24 and pnpm 11.7 for dsh spike"
  ```

---

### Task 3: Build the disposable black-box probe runner

**Files:**
- Create: `spikes/dsh-compat/lib/process.mjs`
- Create: `spikes/dsh-compat/lib/run-context.mjs`
- Create: `spikes/dsh-compat/run.mjs`
- Create: `tests/dsh-compat-runner.test.mjs`

**Interfaces:**
- Produces: `createRunContext({ version, root }) -> { runId, dshHome, candidateRepo, canonicalRepo, evidenceDir, env }`.
- Produces: `runCommand(file, args, { cwd, env, timeoutMs }) -> { code, stdout, stderr, timedOut }`.
- Produces: `snapshotTree(root) -> [{ path, kind, mode, sha256 }]` without following symlinks.
- CLI: `node spikes/dsh-compat/run.mjs --version 0.1.0-rc.8|0.1.1-rc.2|all --out .dsh-compat-runs`.

- [ ] **Step 1: Write failing runner tests**

  Cover argument rejection, unique run directories, owner-separated dsh homes, timeout termination, stdout/stderr capture, symlink-safe tree snapshots, and cleanup limited to the created temporary root.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-runner.test.mjs
  ```

- [ ] **Step 3: Implement with Node standard library**

  Use `mkdtemp`, `spawn`, `lstat`, `readdir`, `readlink`, and `createHash`. The runner must pass an explicit environment:

  ```js
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: runTemp,
    TMP: runTemp,
    DSH_HOME: dshHome,
    WORKBENCH_CANARY_SECRET: 'wb-canary-6f28d0ad',
    NO_COLOR: '1'
  }
  ```

  Do not copy API keys, home-directory variables, npm tokens, or the caller's full environment.

- [ ] **Step 4: Add fixture Git repositories**

  The runner creates `canonicalRepo`, commits `tracked.txt` containing `canonical\n`, then creates `candidateRepo` using the isolation mode under test. Record before/after snapshots for canonical working tree and `.git` separately.

- [ ] **Step 5: Run focused and full suites**

  ```powershell
  pnpm test:dsh-compat
  pnpm test
  ```

- [ ] **Step 6: Commit**

  ```powershell
  git add spikes/dsh-compat/lib spikes/dsh-compat/run.mjs tests/dsh-compat-runner.test.mjs
  git commit -m "test: add disposable dsh compatibility runner"
  ```

---

### Task 4: Prove out-of-tree Profile, Host, Web, and Headless extension seams

**Files:**
- Create: `spikes/dsh-compat/fixtures/plugin/package.json`
- Create: `spikes/dsh-compat/fixtures/plugin/index.mjs`
- Create: `spikes/dsh-compat/fixtures/bundle/package.json`
- Create: `spikes/dsh-compat/fixtures/bundle/cordis.patch.yml`
- Create: `spikes/dsh-compat/fixtures/profile/package.json`
- Create: `spikes/dsh-compat/fixtures/profile/cordis.patch.yml`
- Create: `spikes/dsh-compat/probes/composition.mjs`
- Create: `tests/dsh-compat-composition.test.mjs`

**Interfaces:**
- Plugin uses named Cordis exports only: `name`, `inject`, `apply`; no default export.
- Host writes an activation marker and registers one `workbenchSpike` service with `ping() -> 'pong'`.
- Bundle inserts the plugin through a dsh patch row.
- Probe emits `profile-host-plugin`, `web-boot`, and `headless-boot` results.

- [ ] **Step 1: Write failing fixture-contract tests**

  Assert manifests use exact file dependencies, the bundle declares:

  ```json
  { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
  ```

  and the profile declares ordered dsh base, app, and spike bundle layers. Assert plugin source has named exports and no `export default`.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-composition.test.mjs
  ```

- [ ] **Step 3: Implement the smallest Host plugin**

  `index.mjs` must activate through Cordis and dispose cleanly:

  ```js
  export const name = 'workbench-dsh-spike'
  export const inject = []

  export function apply(ctx, config = {}) {
    const marker = config.marker
    if (!marker) throw new Error('workbench-dsh-spike: marker is required')
    ctx.workbenchSpike = Object.freeze({ ping: () => 'pong' })
    return () => { delete ctx.workbenchSpike }
  }
  ```

  If direct service assignment is rejected by the installed Cordis contract, replace only those two lines with the documented `Service` registration used by that exact package. Record the public package and symbol in probe observations; do not import a private source path.

- [ ] **Step 4: Compose and inspect both profiles**

  For each version run the resolved CLI:

  ```powershell
  dsh --profile workbench-spike-web --dump-config
  dsh --profile workbench-spike-headless --dump-config
  ```

  Assert the dump contains the inserted plugin row and no unmatched-patch warning.

- [ ] **Step 5: Boot Web on loopback and Headless without Workbench credentials**

  Web:

  ```powershell
  dsh --profile workbench-spike-web --host 127.0.0.1 --port 0
  ```

  Discover the bound port from structured startup output, request the health/root endpoint, then terminate gracefully. Headless must boot through a deterministic local adapter fixture; invoke:

  ```powershell
  dsh --profile workbench-spike-headless "return exactly SPIKE_OK"
  ```

  If no published deterministic adapter can execute the task, `headless-boot` is `FAIL`; dumping config is not a substitute.

- [ ] **Step 6: Prove default profiles still compose**

  With a separate empty `DSH_HOME`, run `--profile web --dump-default-config` and `--profile headless --dump-default-config`. The Workbench row must be absent.

- [ ] **Step 7: Run tests and commit**

  ```powershell
  pnpm test:dsh-compat
  pnpm test
  git add spikes/dsh-compat/fixtures spikes/dsh-compat/probes/composition.mjs tests/dsh-compat-composition.test.mjs
  git commit -m "test: probe dsh profile host web and headless seams"
  ```

---

### Task 5: Prove Client Plugin, Remote, Conversation Node, and Settings Card seams

**Files:**
- Modify: `spikes/dsh-compat/fixtures/plugin/package.json`
- Create: `spikes/dsh-compat/fixtures/plugin/client.mjs`
- Modify: `spikes/dsh-compat/fixtures/plugin/index.mjs`
- Create: `spikes/dsh-compat/probes/web-extensions.mjs`
- Create: `tests/dsh-compat-web-extensions.test.mjs`

**Interfaces:**
- Host Remote method: `workbenchSpike.ping` returns `{ value: 'pong', actorSource, requestId }` and ignores any actor field supplied by the caller.
- Client contribution registers one route, one Settings Card, and one Conversation Node renderer bearing stable test IDs.
- Probe emits `web-client-plugin`, `remote-call`, `conversation-node`, and `settings-card`.

- [ ] **Step 1: Write failing contract tests**

  Assert the Host and Client entries ship from the same package, browser code does not import the Host module, Remote input schema rejects extra fields, and all disposers are registered through Cordis effects.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-web-extensions.test.mjs
  ```

- [ ] **Step 3: Implement only the four extension contributions**

  Use the public registrations exported by the tested dsh version. The page renders these literal markers:

  ```html
  <section data-testid="workbench-spike-page">pong</section>
  <div data-testid="workbench-spike-settings">settings</div>
  <div data-testid="workbench-spike-conversation-node">probe</div>
  ```

  Put version-sensitive registration code in `spikes/dsh-compat/fixtures/plugin/compat.mjs`; do not introduce a general compatibility facade during the spike.

- [ ] **Step 4: Run a real browser-facing HTTP probe**

  Boot Web on loopback, fetch the generated client-plugin manifest and route assets, call the typed Remote endpoint with the server-issued local session, and assert the response. Then send an `actor: 'forged'` input and prove the recorded actor remains server-derived or the request is rejected.

- [ ] **Step 5: Inspect rendered registration state**

  Use the dsh Client Plugin inspection endpoint or browser smoke mechanism shipped by the exact release. Each of the three stable test IDs must appear in rendered output. A package that merely loads but cannot render receives `FAIL`.

- [ ] **Step 6: Run tests and commit**

  ```powershell
  pnpm test:dsh-compat
  pnpm test
  git add spikes/dsh-compat/fixtures/plugin spikes/dsh-compat/probes/web-extensions.mjs tests/dsh-compat-web-extensions.test.mjs
  git commit -m "test: probe dsh web extension contracts"
  ```

---

### Task 6: Prove the complete candidate-only execution world

**Files:**
- Create: `spikes/dsh-compat/probes/execution-world.mjs`
- Create: `tests/dsh-compat-execution-world.test.mjs`

**Interfaces:**
- Probe emits `workspace-access`, `agent-subagent-candidate-binding`, `git-admin-denial`, and `sandbox-boundary`.
- Produces: `selectIsolationMode(results) -> 'detached-worktree'|'full-clone'`; worktree wins only if every shared-Git escape attempt is denied, otherwise full clone must pass.

- [ ] **Step 1: Write failing selection and snapshot tests**

  Test that a worktree with any writable canonical `.git` path selects no mode until full clone passes; a passing full clone selects `full-clone`; a fully contained worktree selects `detached-worktree`; mode selection is deterministic and never changes at runtime.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-execution-world.test.mjs
  ```

- [ ] **Step 3: Exercise every Agent-visible capability through dsh**

  From a dsh Agent and one dsh Subagent, attempt the following through Filesystem, Shell, PTY, LSP, and Subprocess providers:

  ```text
  write candidate/tracked.txt
  create candidate/new.txt
  write ../canonical/tracked.txt
  read and write candidate/.git
  git config --local spike.value changed
  git update-ref refs/heads/spike HEAD
  git add tracked.txt
  create a symlink/junction from candidate/escape to canonical
  write candidate/escape/tracked.txt
  spawn a child process with cwd=canonical
  ask LSP to resolve a file outside candidate
  ```

  The first two operations must succeed. Every escape operation must be denied before mutation. After each attempt, compare canonical working-tree, index, config, refs, objects, and file digests with their pre-probe snapshots.

- [ ] **Step 4: Test both isolation candidates**

  First test a detached worktree. Reject it if the Agent can reach the shared Git administration link by any capability. Then test a disposable full clone with independent `.git`. If the full clone cannot contain every capability, the version fails Phase 0.

- [ ] **Step 5: Prove checkpoint restoration and read-only overlap**

  Run a mutating attempt that writes then fails; restore the Workbench-owned content checkpoint and assert no change remains. Run two declared read-only attempts against one immutable checkpoint and assert both lack mutating providers. Attempt overlap between read-only and mutating modes and assert the scheduler refuses it. This validates dsh can be constrained; it does not implement the later governed-task scheduler.

- [ ] **Step 6: Run tests and commit**

  ```powershell
  pnpm test:dsh-compat
  pnpm test
  git add spikes/dsh-compat/probes/execution-world.mjs tests/dsh-compat-execution-world.test.mjs
  git commit -m "test: prove dsh candidate execution isolation"
  ```

---

### Task 7: Prove Session, secret, Storage, and approval security contracts

**Files:**
- Create: `spikes/dsh-compat/probes/security.mjs`
- Create: `spikes/dsh-compat/lib/secret-scan.mjs`
- Create: `tests/dsh-compat-security.test.mjs`

**Interfaces:**
- Produces: `scanForSecret({ roots, outputs, secret }) -> Finding[]`, inspecting text and binary byte sequences without following links.
- Probe emits `session-encryption`, `secret-redaction`, `storage-atomicity`, `storage-locking`, `storage-recovery`, `storage-provider-registration`, `web-approval-identity`, `headless-approval-identity`, and `distinct-approval-semantics`.

- [ ] **Step 1: Write failing scanner and gate tests**

  Cover raw UTF-8, UTF-16LE, base64, URL-encoded, JSON-escaped, and split-line secret forms. Test that unreadable files and symlinks are findings, not silently skipped. Test that each approval kind rejects the other two identifiers.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-security.test.mjs
  ```

- [ ] **Step 3: Probe Session confidentiality and redaction**

  Inject `WORKBENCH_CANARY_SECRET` only through the dsh credential provider, run one supervisor and one child Session, and cause a trusted adapter to consume it. Verify:

  - plaintext session files do not exist;
  - equal plaintext records produce different ciphertext/nonces;
  - changing ciphertext or authenticated metadata makes reading fail;
  - restart with the same installation key recovers sessions;
  - restart without the key refuses access without deleting ciphertext;
  - model-visible messages and persisted events never contain the value;
  - retention, deletion, and pinning operate on encrypted records.

  If published dsh persistence is plaintext and no out-of-tree registered persistence provider can replace it, record `session-encryption: FAIL`. Do not build the provider in this plan.

- [ ] **Step 4: Probe required Storage semantics**

  Through public dsh Storage APIs or a documented registered provider seam, run concurrent compare-and-set/transaction attempts, process-kill recovery, workspace isolation, schema marker creation, and idempotent replay. Confirm a third-party provider can register without a Host patch. Missing atomicity, lock exclusion, recovery, or provider replacement is `FAIL`.

- [ ] **Step 5: Probe trusted approval identity**

  Web must bind loopback, require a server-issued session plus Origin/CSRF protection for mutation, and derive actor identity server-side. Headless must derive the operating-system principal for interactive approval and require a configured automation identity for non-interactive approval. Caller-provided names must be rejected or ignored.

- [ ] **Step 6: Probe non-substitutable approvals**

  Register three fixture approval payloads with disjoint `kind`, identifier prefix, error code, bound fields, and expiry. Submit each identifier at both wrong boundaries and assert fail-closed behavior. This proves extension feasibility; the production approval implementation belongs to Plans 2 and 3.

- [ ] **Step 7: Scan every persistence surface**

  Scan the dsh home, candidate checkout, canonical checkout, temp root, Session store, Storage files, lock/WAL/journal files, indices, structured evidence, stdout, and stderr. Zero findings is required.

- [ ] **Step 8: Run tests and commit**

  ```powershell
  pnpm test:dsh-compat
  pnpm test
  git add spikes/dsh-compat/probes/security.mjs spikes/dsh-compat/lib/secret-scan.mjs tests/dsh-compat-security.test.mjs
  git commit -m "test: probe dsh persistence storage and approval security"
  ```

---

### Task 8: Prove durable DevFlow dispatch recovery

**Files:**
- Create: `spikes/dsh-compat/probes/devflow-recovery.mjs`
- Create: `tests/dsh-compat-devflow-recovery.test.mjs`

**Interfaces:**
- Probe emits `devflow-dispatch-recovery`.
- Uses the existing real DevFlow stable protocol, not a second fake business implementation.
- Recovery key is either caller-reserved `devflowSessionId` or stable workspace-scoped `idempotencyKey`; at least one must be queryable after an uncertain response.

- [ ] **Step 1: Locate the existing stable protocol and write failing integration tests**

  Use `rg "idempot|sessionId|EventStore|Decision" devflow-runtime core tests` to identify the accepted entry point. Test four transport cuts: before request, after durable outbox write, after DevFlow accepts but before response, and after confirmation.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-devflow-recovery.test.mjs
  ```

- [ ] **Step 3: Implement only the probe adapter**

  The probe persists this exact envelope before dispatch:

  ```js
  {
    schema: 'workbench-dispatch-probe-1',
    actionId,
    actionDigest,
    idempotencyKey,
    devflowSessionId,
    candidateDigest,
    state: 'DISPATCHING'
  }
  ```

  After restart it queries DevFlow by the supported stable key before any retry. An unknown outcome becomes `QUARANTINED`; it is never guessed as success or retried with a new key.

- [ ] **Step 4: Drive the adapter from a dsh Host plugin lifecycle**

  Start dispatch, terminate the dsh process at each cut point, restart with the same dsh home, reconcile, and assert exactly one logical Action and one trusted final Decision in DevFlow.

- [ ] **Step 5: Run tests and commit**

  ```powershell
  pnpm test:dsh-compat
  pnpm test
  git add spikes/dsh-compat/probes/devflow-recovery.mjs tests/dsh-compat-devflow-recovery.test.mjs
  git commit -m "test: probe dsh devflow dispatch recovery"
  ```

---

### Task 9: Generate dependency, license, integrity, and vulnerability evidence

**Files:**
- Create: `spikes/dsh-compat/probes/supply-chain.mjs`
- Create: `tests/dsh-compat-supply-chain.test.mjs`

**Interfaces:**
- Produces per-version immutable artifacts: package inventory, lockfile digest, registry integrity values, license inventory, and vulnerability report.
- Vulnerability decision rejects known-exploited, Critical, and applicable High findings; every accepted lower finding requires owner, rationale, and expiry.

- [ ] **Step 1: Write failing policy tests**

  Test Critical/High rejection, expired exception rejection, missing license rejection, exact version enforcement, and lockfile-integrity mismatch rejection.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-supply-chain.test.mjs
  ```

- [ ] **Step 3: Implement evidence generation**

  Parse `pnpm-lock.yaml` and installed package manifests. Invoke:

  ```powershell
  pnpm list --recursive --json
  pnpm licenses list --json
  pnpm audit --json
  pnpm install --frozen-lockfile
  ```

  Normalize volatile timestamps out of JSON before hashing. Do not auto-create vulnerability exceptions.

- [ ] **Step 4: Run tests and commit**

  ```powershell
  pnpm test:dsh-compat
  pnpm test
  git add spikes/dsh-compat/probes/supply-chain.mjs tests/dsh-compat-supply-chain.test.mjs
  git commit -m "test: gate dsh supply chain evidence"
  ```

---

### Task 10: Run the two-version matrix and make the architecture decision

**Files:**
- Create: `docs/dsh-compatibility/0.1.0-rc.8.md`
- Create: `docs/dsh-compatibility/0.1.1-rc.2.md`
- Create: `docs/dsh-compatibility/decision.md`
- Conditionally modify: `spikes/dsh-compat/package.json`
- Conditionally modify: `pnpm-lock.yaml`

**Interfaces:**
- Final decision is exactly one of:
  - `PROMOTE`: both versions pass, select `0.1.1-rc.2`, and prove `0.1.0-rc.8 → 0.1.1-rc.2` upgrade.
  - `HOLD`: exactly one version passes; dsh may remain under evaluation but Plan 2 does not start.
  - `REJECT_DSH_CORE`: neither version passes; retain current Workbench core.

- [ ] **Step 1: Run each version from a clean install twice**

  ```powershell
  pnpm install --frozen-lockfile
  pnpm probe:dsh -- --version 0.1.0-rc.8 --out .dsh-compat-runs
  pnpm probe:dsh -- --version 0.1.0-rc.8 --out .dsh-compat-runs
  pnpm probe:dsh -- --version 0.1.1-rc.2 --out .dsh-compat-runs
  pnpm probe:dsh -- --version 0.1.1-rc.2 --out .dsh-compat-runs
  ```

  Both runs for a version must reach the same decision and isolation mode. Any flaky result rejects that version.

- [ ] **Step 2: Run the in-place upgrade probe**

  Create state with rc.8, stop it cleanly, back up the dsh home, switch the exact CLI/package set to rc.2, and reopen the same state. Re-run Web, Headless, Session, Storage, Remote, and governed dispatch probes. Do not perform a reverse schema migration.

- [ ] **Step 3: Write per-version reports**

  Each report contains the exact package/version/integrity, run IDs, every probe status, isolation mode, artifacts and digests, supply-chain decision, observed upstream regressions, and reproduction command. Link generated evidence by digest; do not commit large runtime directories or secrets.

- [ ] **Step 4: Write `decision.md` from the decision module output**

  Include:

  ```markdown
  # DSH Core Compatibility Decision

  - Decision: `PROMOTE|HOLD|REJECT_DSH_CORE`
  - Selected version: `<exact version or none>`
  - Candidate isolation mode: `detached-worktree|full-clone|none`
  - Upgrade proven: `yes|no`
  - Failed hard gates: `<sorted probe IDs or none>`
  - Next plan allowed: `yes|no`
  ```

- [ ] **Step 5: Conditionally reduce the dependency matrix**

  Only for `PROMOTE`, replace the two aliases in the spike manifest with one exact dependency:

  ```json
  "@deepseek-ai/dsh": "0.1.1-rc.2"
  ```

  Run `pnpm install --lockfile-only` and `pnpm install --frozen-lockfile`. For `HOLD` or `REJECT_DSH_CORE`, retain both aliases as reproducibility fixtures and do not create production plugin packages.

- [ ] **Step 6: Verify completion evidence**

  Invoke `superpowers:verification-before-completion`, then run:

  ```powershell
  pnpm install --frozen-lockfile
  pnpm test:dsh-compat
  pnpm test
  git diff --check
  git status --short
  ```

  Expected: all tests pass, no whitespace errors, generated run directories ignored, and only intended reports/manifests are staged.

- [ ] **Step 7: Commit the decision without staging the architecture spec**

  ```powershell
  git add docs/dsh-compatibility/0.1.0-rc.8.md docs/dsh-compatibility/0.1.1-rc.2.md docs/dsh-compatibility/decision.md spikes/dsh-compat/package.json pnpm-lock.yaml
  git commit -m "docs: record dsh core compatibility decision"
  ```

## Exit Gate

Plan 2 may begin only when `docs/dsh-compatibility/decision.md` says all of the following:

- `Decision: PROMOTE`.
- Exact selected version is `0.1.1-rc.2` or a newer exact release introduced by a separately reviewed amendment to this plan.
- Upgrade from the baseline published version passed twice.
- One candidate isolation mode is fixed and every Agent-visible capability is contained.
- All 21 required probes passed twice with no skipped or flaky result.
- The canary secret is absent from every scanned surface.
- Frozen install, inventory, integrity, license, and vulnerability gates passed.
- Existing Workbench tests still pass twice.

Any other result is a successful spike with a negative architecture decision: stop, preserve the evidence, and do not scaffold `dsh-compat`, the Workbench Profile, or business plugins.

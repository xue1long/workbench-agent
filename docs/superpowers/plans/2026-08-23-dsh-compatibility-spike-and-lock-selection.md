# DSH Compatibility Spike and Lock Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide, with repeatable black-box evidence, whether published dsh can safely serve as the Workbench core; migrate the repository to Node.js 24 and pnpm 11.7.0; and lock exactly one dsh release only if every Phase 0 architecture and security gate passes.

**Architecture:** Keep the accepted Workbench implementation untouched while a self-contained `spikes/dsh-compat` runner launches two exact published dsh versions from separate pnpm projects, lockfiles, module trees, and disposable homes. Node's standard library drives processes, temporary Git repositories, HTTP probes, filesystem snapshots, evidence hashing, and a small out-of-tree proof Bundle; Playwright drives the real browser surface. `0.1.0-rc.8` only creates representative legacy state, while `0.1.1-rc.2` must pass every hard gate and reopen that state before it can be selected.

**Tech Stack:** Node.js 24 LTS ESM, pnpm 11.7.0, built-in `node:test`, `@playwright/test@1.62.1`, published `@deepseek-ai/dsh` and `@deepseek-ai/dsh-llm-mock-server` packages, Git CLI, existing DevFlow Runtime fixture, SHA-256 from `node:crypto`; no production dependency is added.

**Spec:** `docs/superpowers/specs/2026-08-23-dsh-core-plugin-architecture-design.md`, especially Sections 4, 7, 13-19 and Phase 0.

## Global Constraints

- Freeze the approved design in its own commit before creating the isolated worktree. Every evidence file records that commit and the design-file digest.
- Work in an isolated Git worktree created with `superpowers:using-git-worktrees`; never run the spike against the user's canonical checkout.
- Preserve the 414-test Level 4 baseline. The spike may add tests and evidence but may not move, rewrite, or delete accepted business modules.
- Test only exact published versions: `@deepseek-ai/dsh@0.1.0-rc.8` and `@deepseek-ai/dsh@0.1.1-rc.2`. Each gets an independent package manifest, lockfile, `node_modules`, and `DSH_HOME`; do not use aliases, `latest`, ranges, Git branches, or source checkouts.
- Use a fresh temporary `DSH_HOME` and a fresh temporary Git repository for every test. Never reuse `~/.dsh` or a developer's credentials.
- Do not require a real model API key. Run the matching exact release of `@deepseek-ai/dsh-llm-mock-server` behind the shipping dsh model adapter; the model/network boundary is mocked while Agent Loop, Session, tools, and executors remain real.
- No Host, Agent Loop, Session, Tool, Sandbox, Storage, or Web source patch may turn a failure into a pass.
- Never persist the canary secret. The scanner must cover Session stores, candidate checkouts, temporary files, journals/WAL, indices, evidence payloads, stdout, and stderr.
- A probe result is immutable JSON. Re-running creates a new run directory; it never edits old evidence. Redacted result manifests are committed; bulky raw logs remain ignored and are bound by digest.
- Any required `0.1.1-rc.2` failure makes that target ineligible. A missing public extension seam records `REJECT_DSH_CORE`; a release-specific defect records `HOLD` for a later exact candidate.
- Every non-trivial module starts with one focused failing test, then the full suite must pass.
- Each task commits only its own files. Task 0 is the sole task allowed to commit the approved architecture spec; later tasks must leave it unchanged.

---

## Phase 0: Execution Readiness

### Task 0: Isolate the work and capture the accepted baseline

**Files:**
- Modify: `docs/superpowers/specs/2026-08-23-dsh-core-plugin-architecture-design.md` (commit the already approved revision; do not edit its content in this task)
- Create: `docs/dsh-compatibility/baseline.md`
- Create: `spikes/dsh-compat/write-baseline.mjs`

**Interfaces:**
- Records: Git commit, Node version, pnpm version, OS, `npm test` count, and the SHA-256 digest of `package.json` before migration.

- [ ] **Step 1: Freeze the approved design revision**

  From the canonical checkout, verify only the known design revision is dirty, check it, and commit it separately:

  ```powershell
  git status --short
  git diff --check -- docs/superpowers/specs/2026-08-23-dsh-core-plugin-architecture-design.md
  git add -- docs/superpowers/specs/2026-08-23-dsh-core-plugin-architecture-design.md
  git commit -m "docs: finalize dsh core architecture security model"
  ```

  Stop if another file is staged or if the design status is not `approved for implementation planning`.

- [ ] **Step 2: Create the isolated worktree**

  Invoke `superpowers:using-git-worktrees`, create a sibling worktree named `workbench-dsh-spike` from the new design commit, and run every later command there.

- [ ] **Step 3: Verify the toolchain without changing it**

  Run:

  ```powershell
  node --version
  pnpm --version
  git --version
  ```

  Expected: Node starts with `v24.`, pnpm is callable, and Git exits 0. Record the current pnpm version even when it differs; Task 2 activates repository-pinned pnpm 11.7.0 through Corepack without installing a global package.

- [ ] **Step 4: Run the accepted suite twice**

  Run twice:

  ```powershell
  npm test
  ```

  Expected each time: 414 passing tests and zero failures. A sandbox-only `spawn EPERM` is an environment denial: rerun the same suite outside the process sandbox and record both outputs. A real test failure stops the plan.

- [ ] **Step 5: Write `docs/dsh-compatibility/baseline.md`**

  `write-baseline.mjs` uses `execFileSync` with literal argv arrays and `createHash('sha256')` to collect the six command-derived values, verifies the two recorded suite results are `414/414`, and writes this Markdown shape through `writeFile`:

  ```js
  const markdown = `# DSH Compatibility Baseline

  - Commit: ${commit}
  - Node: ${nodeVersion}
  - pnpm: ${pnpmVersion}
  - OS: ${platform} ${arch}
  - Existing suite: 414/414, two clean runs
  - package.json SHA-256: ${packageDigest}
  - Design commit: ${designCommit}
  - Design SHA-256: ${designDigest}
  `
  ```

  Run `node spikes/dsh-compat/write-baseline.mjs`, then inspect the generated file before committing it.

- [ ] **Step 6: Commit**

  ```powershell
  git add docs/dsh-compatibility/baseline.md spikes/dsh-compat/write-baseline.mjs
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
- Produces: `decideCore({ targetResults, legacyStateResults, upgradeResults }) -> { decision: 'PROMOTE'|'HOLD'|'REJECT_DSH_CORE', selectedVersion, isolationMode, upgradeProven, failedProbeIds, reasonClass }`.

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

  Test that a missing result, `SKIP`, duplicate probe ID, version mismatch, or any status except `PASS` rejects the target. Test that `PROMOTE` requires all rc.2 probes, successful rc.8 legacy-state creation, and successful rc.2 reopening. An rc.8 hard-gate failure does not reject rc.2. Classify a missing public extension seam as `REJECT_DSH_CORE`; classify a target release regression as `HOLD`.

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
- Create: `pnpm-lock.yaml`
- Create: `spikes/dsh-compat/installs/rc8/package.json`
- Create: `spikes/dsh-compat/installs/rc8/pnpm-lock.yaml`
- Create: `spikes/dsh-compat/installs/rc2/package.json`
- Create: `spikes/dsh-compat/installs/rc2/pnpm-lock.yaml`
- Create: `tests/dsh-compat-toolchain.test.mjs`

**Interfaces:**
- Root package declares Node `>=24 <25` and `packageManager: pnpm@11.7.0`.
- Root dependencies contain only the exact browser-test tool; production packages are introduced by Plan 2.
- Each dsh install is a standalone pnpm project opened with `--ignore-workspace`; neither version can resolve packages from the other project.

- [ ] **Step 1: Write the failing toolchain test**

  Parse the root and both install manifests and assert:

  ```js
  assert.equal(root.engines.node, '>=24 <25')
  assert.equal(root.packageManager, 'pnpm@11.7.0')
  assert.equal(root.devDependencies['@playwright/test'], '1.62.1')
  assert.deepEqual(rc8.dependencies, {
    '@deepseek-ai/dsh': '0.1.0-rc.8',
    '@deepseek-ai/dsh-llm-mock-server': '0.1.0-rc.8'
  })
  assert.deepEqual(rc2.dependencies, {
    '@deepseek-ai/dsh': '0.1.1-rc.2',
    '@deepseek-ai/dsh-llm-mock-server': '0.1.1-rc.2'
  })
  ```

  Also assert dependency values contain no alias, `^`, `~`, `*`, Git URL, or dist-tag, and each lockfile contains only its own dsh release family.

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
  },
  "devDependencies": { "@playwright/test": "1.62.1" }
  ```

- [ ] **Step 4: Create the two standalone spike manifests**

  `spikes/dsh-compat/installs/rc8/package.json`:

  ```json
  {
    "name": "@workbench/dsh-compat-rc8",
    "private": true,
    "type": "module",
    "dependencies": {
      "@deepseek-ai/dsh": "0.1.0-rc.8",
      "@deepseek-ai/dsh-llm-mock-server": "0.1.0-rc.8"
    }
  }
  ```

  `spikes/dsh-compat/installs/rc2/package.json` is identical except for package name `@workbench/dsh-compat-rc2` and both dependency versions `0.1.1-rc.2`.

- [ ] **Step 5: Activate pnpm and create the frozen lock**

  ```powershell
  corepack pnpm --version
  corepack pnpm install --lockfile-only
  corepack pnpm install --frozen-lockfile
  corepack pnpm --dir spikes/dsh-compat/installs/rc8 install --lockfile-only --ignore-workspace
  corepack pnpm --dir spikes/dsh-compat/installs/rc8 install --frozen-lockfile --ignore-workspace
  corepack pnpm --dir spikes/dsh-compat/installs/rc2 install --lockfile-only --ignore-workspace
  corepack pnpm --dir spikes/dsh-compat/installs/rc2 install --frozen-lockfile --ignore-workspace
  ```

  Expected: `corepack pnpm --version` prints `11.7.0`; no global shim or active package-manager version is changed.

- [ ] **Step 6: Prove the installations are disjoint**

  Resolve `@deepseek-ai/dsh/package.json` from each install directory with `createRequire()`. Assert the two absolute paths have different install roots, exact versions, and lockfile digests. Walk installed `@deepseek-ai/dsh-*` manifests: reject any `0.1.1-rc.*` package in rc8 and any `0.1.0-rc.*` package in rc2. Record every package/version pair in its version evidence.

- [ ] **Step 7: Verify baseline and frozen reinstall**

  ```powershell
  corepack pnpm test
  corepack pnpm test:dsh-compat
  corepack pnpm install --frozen-lockfile
  corepack pnpm --dir spikes/dsh-compat/installs/rc8 install --frozen-lockfile --ignore-workspace
  corepack pnpm --dir spikes/dsh-compat/installs/rc2 install --frozen-lockfile --ignore-workspace
  ```

- [ ] **Step 8: Commit**

  ```powershell
  git add package.json pnpm-lock.yaml spikes/dsh-compat/installs tests/dsh-compat-toolchain.test.mjs
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
- Produces: `writeEvidenceManifest(result, committedDir) -> { path, sha256 }`, rejecting secrets, absolute local paths, and artifact paths outside the run root.
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
  const canarySecret = `wb-canary-${randomBytes(24).toString('hex')}`
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: runTemp,
    TMP: runTemp,
    DSH_HOME: dshHome,
    WORKBENCH_CANARY_SECRET: canarySecret,
    NO_COLOR: '1'
  }
  ```

  Import `randomBytes` from `node:crypto`. Do not copy API keys, home-directory variables, npm tokens, or the caller's full environment. Keep `canarySecret` only in memory and pass it directly to the final scanner.

- [ ] **Step 4: Add fixture Git repositories**

  The runner creates `canonicalRepo`, commits `tracked.txt` containing `canonical\n`, then creates `candidateRepo` using the isolation mode under test. Record before/after snapshots for canonical working tree and `.git` separately.

- [ ] **Step 5: Write durable redacted evidence**

  Store raw logs only under the template-literal path ``.dsh-compat-runs/${runId}``. Store the normalized, secret-scanned result at ``docs/dsh-compatibility/evidence/${runId}.json``; include `specCommit`, `specSha256`, both relevant lockfile digests, raw-artifact relative paths and SHA-256 digests, but no absolute machine path or raw content.

- [ ] **Step 6: Run focused and full suites**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  ```

- [ ] **Step 7: Commit**

  ```powershell
  git add spikes/dsh-compat/lib spikes/dsh-compat/run.mjs tests/dsh-compat-runner.test.mjs docs/dsh-compatibility/evidence
  git commit -m "test: add disposable dsh compatibility runner"
  ```

---

### Task 4: Prove out-of-tree Profile, Host, Web, and Headless extension seams

**Files:**
- Create: `spikes/dsh-compat/fixtures/workbench-spike/package.json`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/host.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/materialize.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/mock-llm.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/cordis.patch.yml`
- Create: `spikes/dsh-compat/probes/composition.mjs`
- Create: `tests/dsh-compat-composition.test.mjs`

**Interfaces:**
- Plugin uses named Cordis exports only: `name`, `inject`, `apply`; no default export.
- `materializeFixture({ version, installRoot, runRoot })` copies the fixture into the run root and writes exact dependency versions read from package manifests resolved under `installRoot`, avoiding cross-version resolution through a linked source tree.
- Host registers one Cordis `workbenchSpike` service with `ping() -> 'pong'` and writes an activation marker through a tracked effect.
- Bundle inserts the plugin through a dsh patch row.
- Probe emits `profile-host-plugin`, `web-boot`, and `headless-boot` results.

- [ ] **Step 1: Write failing fixture-contract tests**

  Assert the materialized manifest uses the exact installed versions of `@deepseek-ai/cordis` and every imported dsh public package, obtained with `createRequire(join(installRoot, 'package.json')).resolve()`, and the bundle declares:

  ```json
  { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
  ```

  Assert plugin source has named `name`, `inject`, and `apply` exports and no default export. Assert materialization rejects rc.8 source with rc.2 dependencies.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-composition.test.mjs
  ```

- [ ] **Step 3: Implement the smallest Host plugin**

  `host.mjs` must activate through Cordis and dispose cleanly:

  ```js
  import { Service } from '@deepseek-ai/cordis'

  export class WorkbenchSpikeService extends Service {
    constructor(ctx) { super(ctx, 'workbenchSpike') }
    ping() { return 'pong' }
  }

  export const name = 'workbench-dsh-spike'
  export const inject = []

  export function apply(ctx) {
    ctx.plugin(WorkbenchSpikeService)
    ctx.effect(() => {
      process.stdout.write('WORKBENCH_SPIKE_ACTIVE\n')
      return () => process.stdout.write('WORKBENCH_SPIKE_DISPOSED\n')
    }, 'workbench-spike.lifecycle')
  }
  ```

  The fixture may import only package exports installed in its materialized manifest; a private source-path import fails the contract test.

- [ ] **Step 4: Initialize and extend the two shipped profiles**

  For each version and fresh `DSH_HOME`, initialize the shipped profiles, materialize the version-matched fixture, and install the bundle through the documented plugin command:

  ```js
  await runCommand(dshBin, ['--profile', 'web', '--dump-default-config'], processOptions)
  await runCommand(dshBin, ['--profile', 'headless', '--dump-default-config'], processOptions)
  await runCommand(dshBin, ['plugin', '--profile', 'web', 'add', materialized.bundlePath], processOptions)
  await runCommand(dshBin, ['plugin', '--profile', 'headless', 'add', materialized.bundlePath], processOptions)
  await runCommand(dshBin, ['--profile', 'web', '--dump-config'], processOptions)
  await runCommand(dshBin, ['--profile', 'headless', '--dump-config'], processOptions)
  ```

  `materialized.bundlePath` is absolute and the runner passes it as one literal argv element. Assert both dumps contain the inserted row and no unmatched-patch warning. Custom Workbench Profile composition remains Plan 2 scope.

- [ ] **Step 5: Start the exact-version scripted model server**

  `mock-llm.mjs` resolves `startMockLlmServer` from the current install root and starts it with exact key `spike-key`, response `SPIKE_OK`, seed `1`, and a fresh loopback port. Point the shipping dsh model adapter at its returned `baseURL` through the fixture Profile patch and expose the credential only through the isolated dsh credential provider.

- [ ] **Step 6: Boot Web on loopback and Headless through the real Agent Loop**

  Web:

  ```js
  await runCommand(dshBin, [
    '--profile', 'web', '--host', '127.0.0.1', '--port', String(reserved.port)
  ], processOptions)
  ```

  The runner reserves a loopback port, releases it immediately before spawn, requests `/`, then terminates gracefully. Invoke Headless with the same materialized bundle and mock server:

  ```powershell
  dsh --profile headless "return exactly SPIKE_OK"
  ```

  Assert stdout's final non-empty assistant text is `SPIKE_OK`, the mock server captured one authenticated request, and a durable Session exists. Dumping config is not a substitute.

- [ ] **Step 7: Prove plugin removal restores the shipped profiles**

  Invoke `runCommand(dshBin, ['plugin', '--profile', 'web', 'remove', materialized.packageName], processOptions)` and the corresponding Headless argv. Dump both profiles and assert the Workbench row is absent while the shipped layers remain.

- [ ] **Step 8: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  git add spikes/dsh-compat/fixtures spikes/dsh-compat/probes/composition.mjs tests/dsh-compat-composition.test.mjs
  git commit -m "test: probe dsh profile host web and headless seams"
  ```

---

### Task 5: Prove Client Plugin, Remote, Conversation Node, and Settings Card seams

**Files:**
- Modify: `spikes/dsh-compat/fixtures/workbench-spike/package.json`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/client.ts`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/compat.mjs`
- Modify: `spikes/dsh-compat/fixtures/workbench-spike/host.mjs`
- Create: `spikes/dsh-compat/probes/web-extensions.mjs`
- Create: `tests/dsh-compat-web-extensions.test.mjs`
- Create: `tests/dsh-compat-web.spec.mjs`

**Interfaces:**
- Host Remote method: `workbenchSpike.ping` returns `{ value: 'pong', actorSource, requestId }` and ignores any actor field supplied by the caller.
- Client contribution registers one route, one Settings Card, and one Conversation Node renderer bearing stable test IDs.
- Probe emits `web-client-plugin`, `remote-call`, `conversation-node`, and `settings-card`.

- [ ] **Step 1: Write failing contract tests**

  Assert the Host and Client entries ship from the same package, `exports["./client"]` resolves to built `lib/client.js`, `dsh.client.platform` is `web`, browser code does not import the Host module, Remote input schema rejects extra fields, and all disposers are registered through Cordis effects.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-web-extensions.test.mjs
  ```

- [ ] **Step 3: Implement only the four extension contributions**

  Materialization writes exact version-matched dependencies and a `build:client` script using the published dsh client build contract. The package declares:

  ```json
  {
    "exports": {
      ".": "./host.mjs",
      "./client": "./lib/client.js"
    },
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": {
        "platform": "web",
        "inject": [
          "@deepseek-ai/dsh-client-runtime",
          "@deepseek-ai/dsh-client-ui-conversation"
        ]
      }
    }
  }
  ```

  Build `client.ts` into the closure-factory `lib/client.js`, then assert the Web boot graph serves that exact file digest. The page renders these literal markers:

  ```html
  <section data-testid="workbench-spike-page">pong</section>
  <div data-testid="workbench-spike-settings">settings</div>
  <div data-testid="workbench-spike-conversation-node">probe</div>
  ```

  `spikes/dsh-compat/fixtures/workbench-spike/compat.mjs` contains only the version-keyed public import and registration names used by rc.8 and rc.2. It throws on every other version and may not import `src/`, `lib/private`, or a filesystem path inside an installed package.

- [ ] **Step 4: Install Chromium for the pinned test runner**

  ```powershell
  corepack pnpm exec playwright install chromium
  ```

  Record the Playwright and Chromium revisions in the evidence manifest.

- [ ] **Step 5: Run a real browser and Remote probe**

  `tests/dsh-compat-web.spec.mjs` boots Web on loopback, launches Chromium, waits for the dsh loading screen to settle, opens the contributed route, and asserts the three test IDs. It invokes `workbenchSpike.ping` through the browser's real Remote client with the server-issued local session. It then sends `actor: 'forged'`, a foreign `Origin`, and a mutation without the issued CSRF value; each must be rejected or retain the server-derived actor.

- [ ] **Step 6: Verify rendered registration and Conversation replay**

  Append the fixture Session start/end events, reload the page, and assert `data-testid="workbench-spike-conversation-node"` renders the replayed terminal state. Each stable test ID must appear in the real DOM. A package that merely loads or serves JavaScript but cannot render receives `FAIL`.

- [ ] **Step 7: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm exec playwright test tests/dsh-compat-web.spec.mjs --project=chromium --workers=1
  corepack pnpm test
  git add spikes/dsh-compat/fixtures/workbench-spike spikes/dsh-compat/probes/web-extensions.mjs tests/dsh-compat-web-extensions.test.mjs tests/dsh-compat-web.spec.mjs
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
- Produces: `inventoryExecutionCapabilities(profileDump) -> [{ id, installed, agentVisible, provider }]`; an absent optional capability passes only when the boot graph proves it is not Agent-visible.

- [ ] **Step 1: Write failing selection and snapshot tests**

  Test that a worktree with any writable canonical `.git` path selects no mode until full clone passes; a passing full clone selects `full-clone`; a fully contained worktree selects `detached-worktree`; mode selection is deterministic and never changes at runtime.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-execution-world.test.mjs
  ```

- [ ] **Step 3: Exercise every Agent-visible capability through dsh**

  Before testing denial, run host-side controls that successfully write the canonical file, create a symlink on Unix or junction on Windows, change a temporary Git ref, and spawn with canonical cwd; immediately restore the fixture. If a control cannot exercise its attack, that case is `INCONCLUSIVE` and rejects the target rather than becoming a false pass.

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

  Inventory Filesystem, Shell, PTY, LSP, Subprocess, Agent, and Subagent from the composed boot graph. Test every installed Agent-visible provider. For an uninstalled optional provider, assert no model tool, Remote entry, or Subagent preset can reach it; do not report a denial test for code that never loaded.

- [ ] **Step 4: Test both isolation candidates**

  First test a detached worktree. Reject it if the Agent can reach the shared Git administration link by any capability. Then test a disposable full clone with independent `.git`. If the full clone cannot contain every capability, the version fails Phase 0.

- [ ] **Step 5: Prove checkpoint restoration and read-only overlap**

  Run a mutating attempt that writes then fails; restore the Workbench-owned content checkpoint and assert no change remains. Run two declared read-only attempts against one immutable checkpoint and assert both lack mutating providers. Attempt overlap between read-only and mutating modes and assert the scheduler refuses it. This validates dsh can be constrained; it does not implement the later governed-task scheduler.

- [ ] **Step 6: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  git add spikes/dsh-compat/probes/execution-world.mjs tests/dsh-compat-execution-world.test.mjs
  git commit -m "test: prove dsh candidate execution isolation"
  ```

---

### Task 7: Prove Session, secret, Storage, and approval security contracts

**Files:**
- Create: `spikes/dsh-compat/probes/security.mjs`
- Create: `spikes/dsh-compat/lib/secret-scan.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/session-provider.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/storage-provider.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/approvals.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/local-auth.mjs`
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

- [ ] **Step 3: Implement the throwaway encrypted Session provider**

  Register through the public Session Persistence provider seam. Encrypt each canonical Session record independently with AES-256-GCM, a fresh 12-byte nonce from `randomBytes`, and authenticated metadata `{ installationId, sessionId, sequence, eventType, schema }`. Store the 32-byte installation key in the isolated dsh home with owner-only permissions. Redact credential values before serialization. This provider is a feasibility fixture and must stay under `spikes/`; Plan 2 decides the production implementation.

- [ ] **Step 4: Probe Session confidentiality and redaction**

  Inject `WORKBENCH_CANARY_SECRET` only through the dsh credential provider, run one supervisor and one child Session, and cause a trusted adapter to consume it. Verify:

  - plaintext session files do not exist;
  - equal plaintext records produce different ciphertext/nonces;
  - changing ciphertext or authenticated metadata makes reading fail;
  - restart with the same installation key recovers sessions;
  - restart without the key refuses access without deleting ciphertext;
  - model-visible messages and persisted events never contain the value;
  - retention, deletion, and pinning operate on encrypted records.

  First prove the shipping provider's observed behavior, then activate the throwaway provider entirely through the out-of-tree Bundle. If the replacement cannot become the sole Session persistence path without a Host patch, record `session-encryption: FAIL` and `reasonClass: architectural-seam`.

- [ ] **Step 5: Implement and probe the throwaway Storage provider**

  `storage-provider.mjs` follows the public backend lifecycle: `ctx.storage.backend.register('workbench-spike', backend)` inside `ctx.effect`, publishes its lifecycle service key, and closes after unregistering. Back it with the shipping SQLite backend where its public contract provides the required operations; add only the minimal transaction/idempotency wrapper the public seam requires. Run concurrent compare-and-set/transaction attempts, process-kill recovery, workspace isolation, schema marker creation, and idempotent replay. Missing atomicity, lock exclusion, recovery, or provider replacement is `FAIL`.

- [ ] **Step 6: Implement and probe trusted approval identity**

  `local-auth.mjs` first consumes a verified dsh local-auth actor when exposed. Otherwise it generates a launch-scoped 32-byte credential, returns it only in an HttpOnly `SameSite=Strict` cookie, stores its CSRF value in browser memory from an authenticated bootstrap response, and excludes both from URLs and logs. Web binds loopback and derives actor server-side. Headless derives the operating-system principal for interactive approval; non-interactive approval requires fixture automation identity `workbench-spike-ci` authenticated by a separate environment reference. Caller-provided names are rejected or ignored.

- [ ] **Step 7: Probe non-substitutable approvals**

  `approvals.mjs` registers three fixture boundaries with prefixes `rap_`, `eap_`, and `cap_`, kinds `runtime`, `execution`, and `change`, and errors `RUNTIME_APPROVAL_KIND`, `EXECUTION_APPROVAL_KIND`, and `CHANGE_APPROVAL_KIND`. Each payload binds actor, issue time, expiry, workspace identity, and its boundary-specific digest. Submit every identifier at both wrong boundaries and assert fail-closed behavior. This proves extension feasibility; the production approval implementation belongs to Plans 2 and 3.

- [ ] **Step 8: Scan every persistence surface**

  Scan the dsh home, candidate checkout, canonical checkout, temp root, Session store, Storage files, lock/WAL/journal files, indices, structured evidence, stdout, and stderr. Zero findings is required.

- [ ] **Step 9: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  git add spikes/dsh-compat/probes/security.mjs spikes/dsh-compat/lib/secret-scan.mjs spikes/dsh-compat/fixtures/workbench-spike/session-provider.mjs spikes/dsh-compat/fixtures/workbench-spike/storage-provider.mjs spikes/dsh-compat/fixtures/workbench-spike/approvals.mjs spikes/dsh-compat/fixtures/workbench-spike/local-auth.mjs tests/dsh-compat-security.test.mjs
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
- Recovery uses the existing caller-known `sessionId` through `DevflowRuntimeAdapter.recover({ workspace, sessionId })`; the Action retains its stable workspace-scoped idempotency key for identical delivery rejection inside DevFlow.

- [ ] **Step 1: Bind the existing stable protocol and write failing integration tests**

  Read `adapters/devflow-runtime.mjs:142` and `tests/integration.test.mjs:48`; use `DevflowRuntimeAdapter.run()` and `recover()` without creating another transport. Test four cuts: before request, after durable outbox write, after DevFlow accepts but before response, and after confirmation.

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

  After restart it calls `recover({ workspace, sessionId: devflowSessionId })` before any retry and validates EventStore integrity. An unknown outcome becomes `QUARANTINED`; it is never guessed as success or retried with a new key.

- [ ] **Step 4: Drive the adapter from a dsh Host plugin lifecycle**

  Start dispatch, terminate the dsh process at each cut point, restart with the same dsh home, reconcile, and assert exactly one logical Action and one trusted final Decision in DevFlow.

- [ ] **Step 5: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  git add spikes/dsh-compat/probes/devflow-recovery.mjs tests/dsh-compat-devflow-recovery.test.mjs
  git commit -m "test: probe dsh devflow dispatch recovery"
  ```

---

### Task 9: Generate dependency, license, integrity, and vulnerability evidence

**Files:**
- Create: `spikes/dsh-compat/probes/supply-chain.mjs`
- Create: `spikes/dsh-compat/supply-chain-exceptions.json`
- Create: `tests/dsh-compat-supply-chain.test.mjs`

**Interfaces:**
- Produces per-version immutable artifacts: package inventory, lockfile digest, registry integrity values, license inventory, generated third-party notices, npm advisory report, and CISA KEV correlation.
- Vulnerability decision rejects known-exploited, Critical, and applicable High findings; every accepted lower finding requires owner, rationale, and expiry.

- [ ] **Step 1: Write failing policy tests**

  Test Critical/High rejection, KEV rejection at any severity, expired exception rejection, missing license/notice rejection, exact version enforcement, and lockfile-integrity mismatch rejection. `supply-chain-exceptions.json` begins as `[]`; the probe never creates exceptions.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-supply-chain.test.mjs
  ```

- [ ] **Step 3: Implement evidence generation**

  Parse `pnpm-lock.yaml` and installed package manifests. Invoke:

  ```powershell
  corepack pnpm list --recursive --json
  corepack pnpm licenses list --json
  corepack pnpm audit --json
  corepack pnpm install --frozen-lockfile
  ```

  Repeat these commands independently under `installs/rc8` and `installs/rc2`. Fetch `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`, store its retrieval time and SHA-256, and join audit CVEs against `vulnerabilities[].cveID`. Generate `THIRD_PARTY_NOTICES.txt` deterministically from package name, exact version, SPDX expression, repository, and included license text. Normalize volatile timestamps out of JSON before hashing. Do not auto-create vulnerability exceptions.

- [ ] **Step 4: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  git add spikes/dsh-compat/probes/supply-chain.mjs spikes/dsh-compat/supply-chain-exceptions.json tests/dsh-compat-supply-chain.test.mjs
  git commit -m "test: gate dsh supply chain evidence"
  ```

---

### Task 10: Run the two-version matrix and make the architecture decision

**Files:**
- Create: `docs/dsh-compatibility/0.1.0-rc.8.md`
- Create: `docs/dsh-compatibility/0.1.1-rc.2.md`
- Create: `docs/dsh-compatibility/decision.md`
- Create: `docs/dsh-compatibility/evidence/upgrade-run-1.json`
- Create: `docs/dsh-compatibility/evidence/upgrade-run-2.json`
- Conditionally create: `spikes/dsh-compat/selected-version.json`

**Interfaces:**
- Final decision is exactly one of:
  - `PROMOTE`: rc.2 passes all 21 hard gates twice, rc.8 creates legacy state twice, and rc.2 reopens both legacy states and re-passes the upgrade-critical probes.
  - `HOLD`: rc.2 has a release-specific defect while all required public extension seams exist; evaluate a later exact release before Plan 2.
  - `REJECT_DSH_CORE`: a required security or product capability cannot be supplied through a documented out-of-tree seam; retain the current Workbench core.

- [ ] **Step 1: Run each version from a clean install twice**

  ```powershell
  corepack pnpm install --frozen-lockfile
  corepack pnpm --dir spikes/dsh-compat/installs/rc8 install --frozen-lockfile --ignore-workspace
  corepack pnpm --dir spikes/dsh-compat/installs/rc2 install --frozen-lockfile --ignore-workspace
  corepack pnpm probe:dsh -- --version 0.1.0-rc.8 --mode legacy-state --out .dsh-compat-runs
  corepack pnpm probe:dsh -- --version 0.1.0-rc.8 --mode legacy-state --out .dsh-compat-runs
  corepack pnpm probe:dsh -- --version 0.1.1-rc.2 --mode target --out .dsh-compat-runs
  corepack pnpm probe:dsh -- --version 0.1.1-rc.2 --mode target --out .dsh-compat-runs
  ```

  Both target runs must reach the same decision and isolation mode. Both legacy runs must produce identical schema/catalog identities and equivalent representative records; rc.8 hard-gate observations remain informational.

- [ ] **Step 2: Run the in-place upgrade probe**

  For each legacy run, stop rc.8 cleanly, copy its dsh home to a new owner-only upgrade directory, launch only the rc.2 binary and dependency tree against the copy, and reopen the state. Re-run Web, Headless, Session decryption/replay, Storage schema and recovery, Remote, identity, candidate isolation, and governed dispatch recovery probes. Do not perform a reverse schema migration. Write one committed redacted upgrade evidence JSON per run.

- [ ] **Step 3: Write per-version reports**

  Each report contains the exact package/version/integrity, run IDs, every probe status, isolation mode, artifacts and digests, supply-chain decision, observed upstream regressions, and reproduction command. Link the committed normalized evidence JSON by path and digest; do not commit large raw runtime directories or secrets.

- [ ] **Step 4: Write `decision.md` from the decision module output**

  Generate it directly from `decideCore()` using this rendering expression; do not hand-edit the result:

  ```js
  const markdown = `# DSH Core Compatibility Decision

  - Decision: ${decision.decision}
  - Selected version: ${decision.selectedVersion ?? 'none'}
  - Candidate isolation mode: ${decision.isolationMode ?? 'none'}
  - Upgrade proven: ${decision.upgradeProven ? 'yes' : 'no'}
  - Failed hard gates: ${decision.failedProbeIds.length ? decision.failedProbeIds.sort().join(', ') : 'none'}
  - Next plan allowed: ${decision.decision === 'PROMOTE' ? 'yes' : 'no'}
  `
  ```

- [ ] **Step 5: Conditionally record the selected version**

  Only for `PROMOTE`, generate `spikes/dsh-compat/selected-version.json` from the decision object and committed evidence:

  ```js
  const selection = {
    schema: 'workbench-dsh-selection-1',
    dshVersion: '0.1.1-rc.2',
    isolationMode: decision.isolationMode,
    targetEvidenceDigests: targetRuns.map(run => run.evidenceDigest).sort(),
    upgradeEvidenceDigests: upgradeRuns.map(run => run.evidenceDigest).sort(),
  }
  await writeFile(selectionPath, `${JSON.stringify(selection, null, 2)}\n`, { flag: 'wx' })
  ```

  Do not add dsh to the root production dependencies; Plan 2 consumes this selection when it creates production packages. For `HOLD` or `REJECT_DSH_CORE`, do not create the selection file or any production plugin package.

- [ ] **Step 6: Verify completion evidence**

  Invoke `superpowers:verification-before-completion`, then run:

  ```powershell
  corepack pnpm install --frozen-lockfile
  corepack pnpm --dir spikes/dsh-compat/installs/rc8 install --frozen-lockfile --ignore-workspace
  corepack pnpm --dir spikes/dsh-compat/installs/rc2 install --frozen-lockfile --ignore-workspace
  corepack pnpm test:dsh-compat
  corepack pnpm test
  git diff --check
  git status --short
  ```

  Expected: all tests pass, no whitespace errors, generated run directories ignored, and only intended reports/manifests are staged.

- [ ] **Step 7: Commit the decision without staging the architecture spec**

  ```powershell
  git add docs/dsh-compatibility/0.1.0-rc.8.md docs/dsh-compatibility/0.1.1-rc.2.md docs/dsh-compatibility/decision.md docs/dsh-compatibility/evidence
  if (Test-Path spikes/dsh-compat/selected-version.json) { git add spikes/dsh-compat/selected-version.json }
  git commit -m "docs: record dsh core compatibility decision"
  ```

## Exit Gate

Plan 2 may begin only when `docs/dsh-compatibility/decision.md` says all of the following:

- `Decision: PROMOTE`.
- Exact selected version is `0.1.1-rc.2` or a newer exact release introduced by a separately reviewed amendment to this plan.
- rc.8 created representative legacy state twice and rc.2 reopened both copies without reverse migration.
- One candidate isolation mode is fixed and every Agent-visible capability is contained.
- All 21 required rc.2 probes passed twice with no skipped, inconclusive, or flaky result.
- The canary secret is absent from every scanned surface.
- Frozen install, inventory, integrity, license, and vulnerability gates passed.
- Existing Workbench tests still pass twice.

Any other result is a successful spike with a negative architecture decision: stop, preserve the evidence, and do not scaffold `dsh-compat`, the Workbench Profile, or business plugins.

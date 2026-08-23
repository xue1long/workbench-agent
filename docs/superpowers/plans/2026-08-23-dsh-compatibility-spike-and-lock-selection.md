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
- Produces: `runBaselineSuite() -> { code, tests, pass, fail, tap, tapSha256 }`, called twice by the baseline writer.

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

- [ ] **Step 4: Implement and run the accepted suite twice**

  `write-baseline.mjs` calls `spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/*.test.mjs'])` twice with `shell: false`, writes each complete TAP stream under `.dsh-compat-runs/baseline/`, and parses the terminal lines `1..414`, `# pass 414`, and `# fail 0`. It throws before writing Markdown unless both child exit codes are zero and both parsed summaries equal `{ tests: 414, pass: 414, fail: 0 }`.

  Run:

  ```powershell
  node spikes/dsh-compat/write-baseline.mjs
  ```

  Expected: two TAP files plus `baseline.md`; each TAP digest is recorded in the Markdown. A sandbox-only `spawn EPERM` is an environment denial: rerun the same command outside the process sandbox. A real test failure stops the plan.

- [ ] **Step 5: Write `docs/dsh-compatibility/baseline.md`**

  `write-baseline.mjs` uses `execFileSync` with literal argv arrays and `createHash('sha256')` to collect the command-derived values, includes the two returned TAP digests, and writes this Markdown shape through `writeFile`:

  ```js
  const markdown = `# DSH Compatibility Baseline

  - Commit: ${commit}
  - Node: ${nodeVersion}
  - pnpm: ${pnpmVersion}
  - OS: ${platform} ${arch}
  - Existing suite: ${runs[0].pass}/${runs[0].tests}, two clean runs
  - Baseline run 1 TAP SHA-256: ${runs[0].tapSha256}
  - Baseline run 2 TAP SHA-256: ${runs[1].tapSha256}
  - package.json SHA-256: ${packageDigest}
  - Design commit: ${designCommit}
  - Design SHA-256: ${designDigest}
  `
  ```

  Inspect the generated file and both ignored TAP files before committing it.

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
- Produces: `normalizeProbeResult(input: ProbeResultInput) -> ProbeResult` with the exact schema below.
- Produces: `normalizeRunManifest({ runId, version, mode, results }) -> RunManifest` with schema `workbench-dsh-run-1`, mode `legacy-state|target|upgrade`, probe results sorted by ID, and one computed manifest `evidenceDigest`.
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

  Test that a missing result, `SKIP`, duplicate probe ID, version mismatch, `INCONCLUSIVE`, or `FAIL` rejects the target. A run manifest rejects an invalid run ID, duplicate result, mixed version/spec/lockfile identity, wrong mode/version pair, unknown field, or caller-supplied digest. `target` requires exactly all 21 IDs; `legacy-state` and `upgrade` require their explicit probe subsets declared by the runner. Test that `PROMOTE` requires all rc.2 probes, successful rc.8 legacy-state creation, and successful rc.2 reopening. An rc.8 hard-gate failure does not reject rc.2. `reasonClass: 'architectural-seam'` produces `REJECT_DSH_CORE`; `release-specific` or `environment` produces `HOLD`.

- [ ] **Step 2: Verify the test fails**

  ```powershell
  node --test tests/dsh-compat-evidence.test.mjs
  ```

- [ ] **Step 3: Implement the minimum evidence module**

  Use `node:crypto`, canonical JSON keys sorted recursively, and no dependency. Reject unknown fields and enforce this exact shape:

  ```js
  {
    schema: 'workbench-dsh-probe-1',
    probeId: 'web-boot',
    version: '0.1.1-rc.2',
    status: 'PASS', // PASS | FAIL | INCONCLUSIVE
    reasonClass: null, // null | release-specific | architectural-seam | environment
    specCommit: '0123456789abcdef0123456789abcdef01234567',
    specSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    lockfileDigests: {
      root: '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      install: '2123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    },
    observations: [{ name: 'loopback', value: '127.0.0.1' }],
    artifacts: [{
      path: 'web/stdout.txt',
      sha256: '3123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    }]
  }
  ```

  Require `reasonClass === null` only for `PASS`; require a non-null reason for `FAIL` and `INCONCLUSIVE`. Digest fields are lowercase 64-character hex, commit is lowercase 40-character hex, artifact paths are relative POSIX paths without `..`, and observation names are unique. Compute `evidenceDigest` over the normalized object rather than accepting it from input.

  `normalizeRunManifest` emits this exact outer shape and computes its digest after normalizing every result:

  ```js
  {
    schema: 'workbench-dsh-run-1',
    runId: 'target-rc2-run-1',
    version: '0.1.1-rc.2',
    mode: 'target',
    results: Object.freeze(normalizedResults),
    evidenceDigest: digestCanonical({ schema, runId, version, mode, results: normalizedResults })
  }
  ```

  Tests compare the digest to an independently canonicalized SHA-256.

- [ ] **Step 4: Ignore generated runs, not fixtures**

  Append:

  ```gitignore
  # DSH compatibility probe output
  .dsh-compat-runs/
  spikes/dsh-compat/installs/*/node_modules/
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
- Create: `docs/dsh-compatibility/evidence/README.md`
- Create: `tests/dsh-compat-runner.test.mjs`

**Interfaces:**
- Produces: `createRunContext({ version, root, runId? }) -> { runId, dshHome, candidateRepo, canonicalRepo, evidenceDir, env }`; an explicit ID must match `/^[a-z0-9][a-z0-9-]{0,63}$/` and its directory must not exist.
- Produces: `runCommand(file, args, { cwd, env, timeoutMs }) -> { code, stdout, stderr, timedOut }`.
- Produces: `snapshotTree(root) -> [{ path, kind, mode, sha256 }]` without following symlinks.
- Produces: `writeEvidenceManifest(manifest, committedDir) -> { path, sha256 }`, accepting only a normalized `workbench-dsh-run-1` manifest and rejecting secrets, absolute local paths, and artifact paths outside the run root.
- CLI example: `node spikes/dsh-compat/run.mjs --version 0.1.1-rc.2 --mode target --run-id target-rc2-run-1 --out .dsh-compat-runs`; version/mode mismatch is rejected.

- [ ] **Step 1: Write failing runner tests**

  Cover argument rejection, generated unique run directories, accepted fixed run IDs, fixed-ID collision rejection, owner-separated dsh homes, timeout termination, stdout/stderr capture, symlink-safe tree snapshots, and cleanup limited to the created temporary root.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-runner.test.mjs
  ```

- [ ] **Step 3: Implement with Node standard library**

  Use `mkdtemp`, `spawn`, `lstat`, `readdir`, `readlink`, and `createHash`. The runner must pass an explicit environment:

  ```js
  const canarySecret = `wb-canary-${randomBytes(24).toString('hex')}`
  const env = Object.fromEntries(Object.entries({
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: runTemp,
    TMP: runTemp,
    DSH_HOME: dshHome,
    WORKBENCH_CANARY_SECRET: canarySecret,
    NO_COLOR: '1'
  }).filter(([, value]) => typeof value === 'string' && value.length > 0))
  ```

  Import `randomBytes` from `node:crypto`. Do not copy API keys, home-directory variables, npm tokens, or the caller's full environment. Keep `canarySecret` only in memory and pass it directly to the final scanner.

- [ ] **Step 4: Add fixture Git repositories**

  The runner creates `canonicalRepo`, writes `tracked.txt` containing `canonical\n`, and commits without reading global Git identity:

  ```js
  await runCommand('git', ['init'], { cwd: canonicalRepo, env, timeoutMs: 10_000 })
  await runCommand('git', ['add', 'tracked.txt'], { cwd: canonicalRepo, env, timeoutMs: 10_000 })
  await runCommand('git', [
    '-c', 'user.name=Workbench Spike',
    '-c', 'user.email=spike@invalid.local',
    'commit', '-m', 'fixture baseline'
  ], { cwd: canonicalRepo, env, timeoutMs: 10_000 })
  ```

  Then create `candidateRepo` using the isolation mode under test. Record before/after snapshots for canonical working tree and `.git` separately.

- [ ] **Step 5: Write durable redacted evidence**

  `docs/dsh-compatibility/evidence/README.md` documents `workbench-dsh-probe-1`, committed versus ignored artifacts, and the digest verification command. Store raw logs only under the template-literal path ``.dsh-compat-runs/${runId}``. Store normalized, secret-scanned results at ``docs/dsh-compatibility/evidence/${runId}.json`` only during Task 10; Task 3 unit tests write evidence beneath their temporary directory, never into the repository.

- [ ] **Step 6: Run focused and full suites**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  ```

- [ ] **Step 7: Commit**

  ```powershell
  git add spikes/dsh-compat/lib spikes/dsh-compat/run.mjs tests/dsh-compat-runner.test.mjs docs/dsh-compatibility/evidence/README.md
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
- Create: `spikes/dsh-compat/fixtures/workbench-spike/remote-host.ts`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/client.ts`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/tsconfig.host.json`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/tsconfig.client.json`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/tsdown.config.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/client-bundle.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/playwright.config.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/compat.mjs`
- Modify: `spikes/dsh-compat/fixtures/workbench-spike/host.mjs`
- Create: `spikes/dsh-compat/probes/web-extensions.mjs`
- Create: `tests/dsh-compat-web-extensions.test.mjs`
- Create: `tests/dsh-compat-web.spec.mjs`

**Interfaces:**
- `WorkbenchSpikeRemote extends TypertRemoteService`; `@Remote('ping') ping(request: { requestId: string }): Promise<{ value: 'pong'; actorSource: string; requestId: string }>` is generated under namespace `workbenchSpike`. Its strict generated codec rejects unknown request fields, including `actor`.
- Client contribution registers one route, one Settings Card, and one Conversation Node renderer bearing stable test IDs.
- `buildClientBundle({ entry, output, packageId, externals })` emits the documented lazy CommonJS registration `window.__ModuleLoader__.load({ id, factory })`; it rejects non-allowlisted value imports instead of bundling Host code.
- Probe emits `web-client-plugin`, `remote-call`, `conversation-node`, and `settings-card`.

- [ ] **Step 1: Write failing contract tests**

  Assert the Host and Client entries ship from the same package, `exports["./client"]` resolves to built `lib/client.js`, `dsh.client.platform` is `web`, browser code does not import the Host module, Remote input schema rejects extra fields, and all disposers are registered through Cordis effects.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-web-extensions.test.mjs
  ```

- [ ] **Step 3: Generate the strict Remote projection before compiling Client**

  Materialization writes exact candidate-matched dsh dependencies plus `typescript: 6.0.3`, `tsdown: 0.22.14`, `@deepseek-ai/dsh-typert-generator: 0.1.1-rc.2`, `react: 18.3.1`, and `@types/react: 18.3.1`; no caret or workspace range is allowed. If rc.8 cannot consume the rc.2 generator, record that only as an rc.8 observation because rc.2 is the target gate. The package declares:

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

  `remote-host.ts` exports `WorkbenchSpikeRemote` and uses only JSON wire types. `tsdown.config.mjs` imports `defineConfig` from `tsdown` and `typertPlugin` from `@deepseek-ai/dsh-typert-generator/tsdown`; it reads `DSH_SPIKE_FACE`, accepts only `host` or `client`, selects `remote-host.ts` plus `typertPlugin({ mode: 'package', faces: ['host'] })` for Host, and selects `client.ts` for Client. Run this fixed order:

  ```powershell
  corepack pnpm --dir spikes/dsh-compat/fixtures/workbench-spike exec tsc -p tsconfig.host.json --noEmit
  $env:DSH_SPIKE_FACE = 'host'
  corepack pnpm --dir spikes/dsh-compat/fixtures/workbench-spike exec tsdown --config tsdown.config.mjs
  corepack pnpm --dir spikes/dsh-compat/fixtures/workbench-spike exec tsc -p tsconfig.client.json --noEmit
  $env:DSH_SPIKE_FACE = 'client'
  corepack pnpm --dir spikes/dsh-compat/fixtures/workbench-spike exec tsdown --config tsdown.config.mjs
  Remove-Item Env:DSH_SPIKE_FACE
  node spikes/dsh-compat/fixtures/workbench-spike/client-bundle.mjs
  ```

  The Host phase uses `typertPlugin({ mode: 'package', faces: ['host'] })` and must produce `lib/typert.host.js`, `lib/typert.host.d.ts`, `lib/typert.remote-client.js`, `lib/typert.remote-client.d.ts`, and its source map. The Client phase imports the package's public `./remote` export, never Host declarations. Extend `exports` with `./remote: ./lib/typert.remote-client.js` and `./typert: ./lib/typert.host.js`; `host.mjs` registers the compiled Host service and its generated Typert artifact through Cordis effects.

- [ ] **Step 4: Build the four Client contributions without a private dsh preset**

  The official external-package surface does not publish the repository-internal `clientBundle` preset. `client-bundle.mjs` is therefore an explicitly test-only compatibility builder: it reads the Client phase's `lib/client.cjs`, permits value imports only from the two declared Client injections, rejects `@deepseek-ai/*` Host imports and absolute/package-internal paths, wraps the result in `window.__ModuleLoader__.load({ id: '@workbench/dsh-spike', factory })`, and writes `lib/client.js` with `flag: 'wx'` after deleting only its known prior output. Its unit test executes the factory against a fake loader and verifies one disposer for each registration.

  Assert the Web boot graph serves the exact SHA-256 of `lib/client.js`. The page renders these literal markers:

  ```html
  <section data-testid="workbench-spike-page">pong</section>
  <div data-testid="workbench-spike-settings">settings</div>
  <div data-testid="workbench-spike-conversation-node">probe</div>
  ```

  `spikes/dsh-compat/fixtures/workbench-spike/compat.mjs` contains only the version-keyed public import and registration names used by rc.8 and rc.2. It throws on every other version and may not import `src/`, `lib/private`, or a filesystem path inside an installed package.

- [ ] **Step 5: Pin the browser project and install Chromium**

  `playwright.config.mjs` imports `fileURLToPath` and sets `testDir: fileURLToPath(new URL('../../../../tests', import.meta.url))`, `workers: 1`, and exactly one project named `chromium` with `devices['Desktop Chrome']`. The command below is invalid unless that config first loads and lists the named project.

  ```powershell
  corepack pnpm exec playwright install chromium
  ```

  Record the Playwright and Chromium revisions in the evidence manifest.

- [ ] **Step 6: Run a real browser and Remote probe**

  `tests/dsh-compat-web.spec.mjs` boots Web on loopback, launches Chromium, waits for the dsh loading screen to settle, opens the contributed route, and asserts the three test IDs. It invokes `workbenchSpike.ping` through the browser's real Remote client with the server-issued local session. It then sends `actor: 'forged'`, a foreign `Origin`, and a mutation without the issued CSRF value; each must be rejected or retain the server-derived actor.

- [ ] **Step 7: Verify rendered registration and Conversation replay**

  Append the fixture Session start/end events, reload the page, and assert `data-testid="workbench-spike-conversation-node"` renders the replayed terminal state. Each stable test ID must appear in the real DOM. A package that merely loads or serves JavaScript but cannot render receives `FAIL`.

- [ ] **Step 8: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm exec playwright test tests/dsh-compat-web.spec.mjs --config=spikes/dsh-compat/fixtures/workbench-spike/playwright.config.mjs --project=chromium
  corepack pnpm test
  git add spikes/dsh-compat/fixtures/workbench-spike spikes/dsh-compat/probes/web-extensions.mjs tests/dsh-compat-web-extensions.test.mjs tests/dsh-compat-web.spec.mjs
  git commit -m "test: probe dsh web extension contracts"
  ```

---

### Task 6: Prove the complete candidate-only execution world

**Files:**
- Create: `spikes/dsh-compat/probes/execution-world.mjs`
- Create: `spikes/dsh-compat/fixtures/workbench-spike/execution-gate.mjs`
- Create: `tests/dsh-compat-execution-world.test.mjs`

**Interfaces:**
- Probe emits `workspace-access`, `agent-subagent-candidate-binding`, `git-admin-denial`, and `sandbox-boundary`.
- Produces: `selectIsolationMode(results) -> 'detached-worktree'|'full-clone'`; worktree wins only if every shared-Git escape attempt is denied, otherwise full clone must pass.
- Produces: `inventoryExecutionCapabilities(profileDump) -> [{ id, installed, agentVisible, provider }]`; an absent optional capability passes only when the boot graph proves it is not Agent-visible.
- Test-only `ExecutionGate.run({ mode, checkpointDigest }, operation)` accepts `mode: 'read-only'|'mutating'`; an omitted or unknown mode is mutating. Readers overlap only on the same immutable checkpoint, a writer is exclusive, and a failed writer awaits `restore(checkpointDigest)` before releasing its lock.

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

- [ ] **Step 5: Implement the smallest test-only execution gate**

  Do not claim the current Workbench already has the later governed-task scheduler. `execution-gate.mjs` is a Phase 0 fixture with one process-local reader/writer queue and an injected `restore` callback. It exposes only `run`; it has no persistence, priority, cancellation, or distributed locking. Tests hold operations on deferred Promises to prove same-checkpoint readers overlap, different-checkpoint readers serialize, writers exclude all readers, undeclared modes receive mutating providers, and restoration finishes before a failed writer's successor starts.

- [ ] **Step 6: Prove checkpoint restoration and read-only overlap through dsh**

  Run a mutating dsh attempt through `ExecutionGate` that writes then fails; restore the Workbench-owned content checkpoint and assert no change remains. Run two declared read-only dsh attempts against one immutable checkpoint and assert both lack mutating providers. Attempt overlap between read-only and mutating modes and assert the fixture queues it. This proves the dsh provider graph can be switched at an execution boundary; production scheduling remains Plan 2 work.

- [ ] **Step 7: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  git add spikes/dsh-compat/probes/execution-world.mjs spikes/dsh-compat/fixtures/workbench-spike/execution-gate.mjs tests/dsh-compat-execution-world.test.mjs
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
- `EncryptedSessionPersistence extends SessionPersistence` implements all nine public members: `locate`, `create`, `append`, `prepare`, `load`, `inspect`, `readFrom`, `list`, and `listSnapshots`; its TypeScript compilation against each candidate's exported declarations is a gate and no member may use `any`. Fixture-only `setPinned(id, pinned)`, `deleteSession(id)`, and `expireSessions({ now, maxAgeMs })` supply the three Workbench retention operations without changing dsh's seam.
- The Storage fixture registers one candidate-exported SQLite `StorageBackend` as `workbench-spike`, opens a `workbench_spike` version-1 domain through `ctx.storageDomain`, and uses one `dispatches` table; it does not create a second storage API.
- `createLocalAuth({ consumeLaunchToken, issueSession, deriveActor })` accepts a launch credential exactly once from the `Authorization: Bearer launchToken` header, then issues the browser cookie and CSRF value. No cookie is issued merely because a loopback request arrived.
- Probe emits `session-encryption`, `secret-redaction`, `storage-atomicity`, `storage-locking`, `storage-recovery`, `storage-provider-registration`, `web-approval-identity`, `headless-approval-identity`, and `distinct-approval-semantics`.

- [ ] **Step 1: Write failing scanner and gate tests**

  Cover raw UTF-8, UTF-16LE, base64, URL-encoded, JSON-escaped, and split-line secret forms. Test that unreadable files and symlinks are findings, not silently skipped. Test that each approval kind rejects the other two identifiers.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-security.test.mjs
  ```

- [ ] **Step 3: Implement the throwaway encrypted Session provider**

  Register `EncryptedSessionPersistence` as the sole `ctx.sessionPersistence` provider through the public seam. Its nine methods preserve dsh semantics: `create` durably writes one immutable header before resolving; `append` accepts only the next contiguous sequence and makes the complete batch durable; `prepare` reuses the cold read and commits interrupted-tail repair before publication; `load` and `inspect` return the same logical event stream while `inspect` does not publish or rewrite; `readFrom` returns the physical suffix from the requested sequence; `list` and `listSnapshots` are metadata-only observations; `locate` returns the independent encrypted artifact path. Reuse candidate-exported Session types and run `tsc --noEmit` against both candidates so a signature drift fails materialization.

  Encrypt each canonical header/event record independently with AES-256-GCM, a fresh 12-byte nonce from `randomBytes`, and authenticated metadata `{ installationId, sessionId, sequence, eventType, schema }`. Store the installation key at `<DSH_HOME>/workbench-spike/session.key` and ciphertext at `<DSH_HOME>/workbench-spike/sessions/`. On POSIX create the directory with `0700` and the key using `open(path, 'wx', 0o600)`. On Windows create the key with `open(path, 'wx')`, invoke `icacls` with `shell: false` and argument array `[path, '/inheritance:r', '/grant:r', `${userInfo().username}:(F)`]`, then parse `icacls path` and fail if `Everyone`, `BUILTIN\\Users`, or `Authenticated Users` has an ACE. Never continue after an ACL command or verification failure. Redact credential values before serialization. This provider stays under `spikes/`; Plan 2 decides the production implementation.

- [ ] **Step 4: Probe Session confidentiality and redaction**

  Inject `WORKBENCH_CANARY_SECRET` only through the dsh credential provider, run one supervisor and one child Session, and cause a trusted adapter to consume it. Verify:

  - plaintext session files do not exist;
  - equal plaintext records produce different ciphertext/nonces;
  - changing ciphertext or authenticated metadata makes reading fail;
  - restart with the same installation key recovers sessions;
  - restart without the key refuses access without deleting ciphertext;
  - model-visible messages and persisted events never contain the value;
  - `setPinned`, `deleteSession`, and `expireSessions` operate only on encrypted artifacts, reject an active Session, and durably update the provider's encrypted metadata before returning.

  First prove the shipping provider's observed behavior, then activate the throwaway provider entirely through the out-of-tree Bundle. If the replacement cannot become the sole Session persistence path without a Host patch, record `session-encryption: FAIL` and `reasonClass: architectural-seam`.

- [ ] **Step 5: Implement and probe the throwaway Storage provider**

  Do not implement a backend. `storage-provider.mjs` constructs the candidate's public SQLite `StorageBackend`, registers it with `ctx.storage.backend.register('workbench-spike', backend)` inside `ctx.effect`, publishes `storageBackendServiceKey('workbench-spike')`, routes only the fixture domain to it, and disposes in this order: close domain, unregister backend, await `backend.close()`. Compilation pins the exact public contract: `StorageBackend.close()`, optional `kv.open(descriptor)`, and returned `KvUnit.loadAll()`, `putRecord()`, `deleteRecord()`, `setGlobal()`, and `close()`.

  Declare the fixture data via `defineDomain({ name: 'workbench_spike', version: 1, tables: { dispatches: domainTable<string, DispatchEnvelope>(z.object({ schema: z.literal('workbench-dispatch-probe-1'), actionId: z.string().min(1), actionDigest: z.string().regex(/^[0-9a-f]{64}$/), idempotencyKey: z.string().min(1), devflowSessionId: z.string().min(1), candidateDigest: z.string().regex(/^[0-9a-f]{64}$/), state: z.enum(['DISPATCHING', 'CONFIRMED', 'QUARANTINED']) }).strict()) } })` and access it only through `ctx.storageDomain.open(spec)`, `table.get/entries/put/delete/update`, and `domain.close()`. Pin the candidate-resolved `zod` package exactly in the fixture manifest. Run concurrent `update` attempts, SQLite cross-process writer contention, forced process termination followed by reopen, workspace-key isolation, schema/application marker validation, and idempotent replay. Missing durability, lock exclusion, recovery, routing, or clean provider replacement is `FAIL`.

- [ ] **Step 6: Implement and probe trusted approval identity**

  `local-auth.mjs` first consumes a verified dsh local-auth actor when exposed. Otherwise it generates a launch-scoped 32-byte token and stores only its SHA-256 server-side. The first bootstrap request must present the raw token as `Authorization: Bearer launchToken`; compare digests with `timingSafeEqual`, atomically mark it consumed, then issue `workbench-spike-session=sessionValue` with `HttpOnly; SameSite=Strict; Path=/` and return a distinct CSRF value in the authenticated response body. `launchToken` and `sessionValue` name runtime-generated byte strings, not literals. Add `Secure` when the probed dsh Web origin is HTTPS; for its HTTP loopback origin the test records that transport limitation instead of emitting an invalid `__Host-` cookie. A missing, wrong, or second-use token receives `401` and no cookie. Playwright uses `extraHTTPHeaders` only for this exchange, then creates a new context containing only the cookie; every mutation requires that cookie, the CSRF header, and an allowed loopback `Origin`.

  Tokens, cookie values, and CSRF values are excluded from URLs, browser storage, evidence, and logs. Web binds loopback and derives actor server-side. Headless derives the operating-system principal for interactive approval; non-interactive approval requires fixture automation identity `workbench-spike-ci` authenticated by a separate environment reference. Caller-provided actor names are rejected or ignored.

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
- Create: `spikes/dsh-compat/lib/dispatch-outbox.mjs`
- Create: `tests/dsh-compat-devflow-recovery.test.mjs`

**Interfaces:**
- Probe emits `devflow-dispatch-recovery`.
- Uses the existing real DevFlow stable protocol, not a second fake business implementation.
- Recovery uses the existing caller-known `sessionId` through `DevflowRuntimeAdapter.recover({ workspace, sessionId })`; the Action retains its stable workspace-scoped idempotency key for identical delivery rejection inside DevFlow.
- `createDispatch(table, envelope)`, `transitionDispatch(table, actionId, expectedState, nextState)`, `loadDispatch(table, actionId)`, and `reconcileDispatch(table, adapter, workspace, actionId)` are the complete probe outbox API. States are `DISPATCHING`, `CONFIRMED`, and `QUARANTINED`; all transitions use the Storage domain's serialized `table.update` and reject a stale expected state.

- [ ] **Step 1: Bind the existing stable protocol and write failing integration tests**

  Read `adapters/devflow-runtime.mjs:142` and `tests/integration.test.mjs:48`; use `DevflowRuntimeAdapter.run()` and `recover()` without creating another transport. Test four cuts: before request, after durable outbox write, after DevFlow accepts but before response, and after confirmation.

- [ ] **Step 2: Verify failure**

  ```powershell
  node --test tests/dsh-compat-devflow-recovery.test.mjs
  ```

- [ ] **Step 3: Persist the probe outbox through the Task 7 Storage domain**

  `createDispatch` performs `table.put(actionId, envelope)` and awaits durability before the DevFlow call. A duplicate key is accepted only when `actionDigest`, `idempotencyKey`, `devflowSessionId`, and `candidateDigest` all match; otherwise it rejects. The persisted envelope is:

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

  `transitionDispatch` uses `table.update` to compare the durable `state` before replacement. `loadDispatch` returns one immutable snapshot. After restart `reconcileDispatch` calls `recover({ workspace, sessionId: devflowSessionId })` before any retry and validates EventStore integrity. A matching trusted Decision changes `DISPATCHING` to `CONFIRMED`; an unknown or conflicting outcome changes it to `QUARANTINED`. It is never guessed as success or retried with a new key. No JSON-file writer or second database is permitted.

- [ ] **Step 4: Drive crash cuts from child processes**

  The probe child accepts only `DSH_SPIKE_CUT=before-request|after-outbox|after-accept|after-confirmation`. At the selected hook it emits `CUT_READY <name>` after the preceding durable operation, then waits; the parent kills that PID, reopens the same dsh home and Storage domain, and reconciles. Start dispatch through a dsh Host plugin lifecycle at all four cuts and assert exactly one logical Action and one trusted final Decision in DevFlow. The test fails if a hook fires before its documented commit point or if reopening requires deleting WAL/lock files.

- [ ] **Step 5: Run tests and commit**

  ```powershell
  corepack pnpm test:dsh-compat
  corepack pnpm test
  git add spikes/dsh-compat/probes/devflow-recovery.mjs spikes/dsh-compat/lib/dispatch-outbox.mjs tests/dsh-compat-devflow-recovery.test.mjs
  git commit -m "test: probe dsh devflow dispatch recovery"
  ```

---

### Task 9: Generate dependency, license, integrity, and vulnerability evidence

**Files:**
- Create: `spikes/dsh-compat/probes/supply-chain.mjs`
- Create: `spikes/dsh-compat/supply-chain-exceptions.json`
- Create: `tests/dsh-compat-supply-chain.test.mjs`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.0-rc.8/inventory.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.0-rc.8/integrity.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.0-rc.8/licenses.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.0-rc.8/audit.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.0-rc.8/osv-aliases.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.0-rc.8/kev.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.0-rc.8/THIRD_PARTY_NOTICES.txt`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.1-rc.2/inventory.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.1-rc.2/integrity.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.1-rc.2/licenses.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.1-rc.2/audit.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.1-rc.2/osv-aliases.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.1-rc.2/kev.json`
- Generate: `docs/dsh-compatibility/evidence/supply-chain/0.1.1-rc.2/THIRD_PARTY_NOTICES.txt`

**Interfaces:**
- `resolveAdvisoryAliases(audit) -> [{ advisoryId, aliases, osvDigest }]` resolves every GHSA through `https://api.osv.dev/v1/vulns/<GHSA>` and records all CVE aliases; an unresolved advisory makes the supply-chain result `INCONCLUSIVE`, never “not in KEV”.
- Produces the seven named immutable artifacts per version: package inventory, lockfile/registry integrity, license inventory, npm advisory report, OSV alias resolution, CISA KEV correlation, and generated third-party notices.
- Vulnerability decision rejects known-exploited, Critical, and applicable High findings; every accepted lower finding requires owner, rationale, and expiry.

- [ ] **Step 1: Write failing policy tests**

  Test Critical/High rejection, direct-CVE and GHSA-to-CVE KEV rejection at any severity, unresolved alias rejection, expired exception rejection, missing license/notice rejection, exact version enforcement, and lockfile-integrity mismatch rejection. `supply-chain-exceptions.json` begins as `[]`; the probe never creates exceptions.

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

  Repeat these commands independently under `installs/rc8` and `installs/rc2`. Extract both CVE and GHSA identifiers from the audit. Resolve each GHSA with OSV, require a stable response for every query, and union the returned CVE aliases. Fetch `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`, store retrieval time plus raw SHA-256, and join the complete CVE set against `vulnerabilities[].cveID`. Preserve the normalized OSV responses and their digests in `osv-aliases.json`; a network/parse/missing-alias failure is `INCONCLUSIVE` and blocks promotion.

  Generate each `THIRD_PARTY_NOTICES.txt` deterministically from package name, exact version, SPDX expression, repository, actual included license-file name, license-file SHA-256, and license text. Reject missing or ambiguous license files instead of inventing notice text. Normalize volatile timestamps out of JSON before hashing. Write all seven artifacts with `flag: 'wx'` into the exact version directory, secret-scan them, and commit them only in Task 10. Do not auto-create vulnerability exceptions.

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
- Create: `docs/dsh-compatibility/evidence/legacy-rc8-run-1.json`
- Create: `docs/dsh-compatibility/evidence/legacy-rc8-run-2.json`
- Create: `docs/dsh-compatibility/evidence/target-rc2-run-1.json`
- Create: `docs/dsh-compatibility/evidence/target-rc2-run-2.json`
- Create: `docs/dsh-compatibility/evidence/upgrade-run-1.json`
- Create: `docs/dsh-compatibility/evidence/upgrade-run-2.json`
- Commit: all generated files under `docs/dsh-compatibility/evidence/supply-chain/`
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
  corepack pnpm probe:dsh -- --version 0.1.0-rc.8 --mode legacy-state --run-id legacy-rc8-run-1 --out .dsh-compat-runs
  corepack pnpm probe:dsh -- --version 0.1.0-rc.8 --mode legacy-state --run-id legacy-rc8-run-2 --out .dsh-compat-runs
  corepack pnpm probe:dsh -- --version 0.1.1-rc.2 --mode target --run-id target-rc2-run-1 --out .dsh-compat-runs
  corepack pnpm probe:dsh -- --version 0.1.1-rc.2 --mode target --run-id target-rc2-run-2 --out .dsh-compat-runs
  ```

  Both target runs must reach the same decision and isolation mode. Both legacy runs must produce identical schema/catalog identities and equivalent representative records; rc.8 hard-gate observations remain informational.

- [ ] **Step 2: Run the in-place upgrade probe**

  For each legacy run, stop rc.8 cleanly, copy its dsh home to a new owner-only upgrade directory, launch only the rc.2 binary and dependency tree against the copy, and reopen the state. Re-run Web, Headless, Session decryption/replay, Storage schema and recovery, Remote, identity, candidate isolation, and governed dispatch recovery probes. Do not perform a reverse schema migration. Write one committed redacted upgrade evidence JSON per run.

- [ ] **Step 3: Write per-version reports**

  For each of the six runs, normalize through Task 1, verify `specCommit`, `specSha256`, and both lockfile digests against the current files, secret-scan the result, and create its evidence JSON with `flag: 'wx'`. Each report contains the exact package/version/integrity, run IDs, every probe status, isolation mode, artifacts and digests, supply-chain decision, observed upstream regressions, and reproduction command. Link the committed normalized evidence JSON and supply-chain artifacts by path and digest; do not commit large raw runtime directories or secrets.

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

# Level 6 Technology Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independent ingestion pipeline that discovers external technology (papers, official docs, official repositories, releases, benchmarks), normalizes it into problem/method/evidence/limitations/capability/provenance records, deduplicates and versions it, ranks Tier 1/2 evidence above discovery-only Tier 3/4 sources, and generates Candidate Patterns that may enter Level 7 experiments but can never modify production behavior.

**Architecture:** `core/intelligence/sources.mjs` registers immutable source metadata (canonical URL, retrieval timestamp, tier, license, terms, retention class, permission) and enforces the "store full content only when permission + license + retention are recorded, otherwise metadata + link only" rule. `core/intelligence/ingest.mjs` is the idempotent, versioning ingestion pipeline (dedupe by canonical URL / content hash / DOI / repository identity; unchanged → no-op; changed → new version preserving the old extraction). `core/intelligence/normalize.mjs` produces the structured extraction. `core/intelligence/patterns.mjs` ranks sources by tier and generates Candidate Patterns; only Tier 1/2 sources can make an experiment-eligible candidate — secondary sources alone cannot.

**Tech Stack:** Node.js 20+ ESM, built-in`node:test`, existing JSONL `StateStore` + content-addressed object pattern; no new dependency, no network calls in the automated suite (fixtures stand in for real sources).

**Spec:** `C:\Users\HP\OneDrive\007 - 个人笔记\000 Inbox\2026-08-23 Agent Workbench — Level 2 至 Level 7 实施方案.md` (Level 6) and `docs/superpowers/plans/2026-08-23-agent-workbench-level-2-to-7-execution.md` Release 6.0.

## Global Constraints

- This pipeline is read-only with respect to production behavior: it cannot modify routing, workflow, or any governed state. Its only output is Candidate Patterns for Level 7 experiments.
- Source URLs are immutable once recorded; retrieval timestamps are recorded with every ingestion.
- Full content is stored only after license/terms, retrieval permission, and retention class are recorded; otherwise the store keeps metadata and a link only.
- Deduplication is by canonical URL, content hash, DOI, or repository identity.
- Reprocessing unchanged sources is idempotent (no new versions, no duplicate rows).
- Changed sources create a new version while the old extraction remains readable.
- Tier 1/2 sources may produce experiment-eligible candidates; Tier 3/4 sources are discovery-only and cannot.
- Every Candidate Pattern is traceable to the exact source record that produced it.
- Every task begins with a failing test and ends with`npm test` passing (451 baseline).

---

## Phase 0: Execution readiness

- [ ] Run`npm test` in the worktree; expected: 451 tests, zero failures.
- [ ] Create isolated worktree `workbench-l6` from main; record baseline in `docs/level-6-acceptance.md`.

---

### Task 1: Source registration with rights metadata

**Files:**
- Create: `core/intelligence/sources.mjs`
- Create: `tests/intelligence-sources.test.mjs`

**Interfaces:**
- Produces: `SourceError`.
- Produces: `registerSource({ store, objectsRoot, source }) -> SourceRecord` — validates and persists:
  ```js
  { id, kind: 'paper'|'docs'|'repo'|'release'|'benchmark',
    canonicalUrl, retrievedAt, tier: 1|2|3|4,
    license: string|null, terms: string|null, retentionClass: 'keep'|'expire-after-days'|'link-only',
    permission: 'granted'|'denied'|'unknown',
    doi: string|null, repoIdentity: string|null }
  ```
- Produces: `storeContent({ store, objectsRoot, sourceId, content })` — writes content-addressed object and appends a content row; REJECTS full-content storage when `permission !== 'granted'` OR `license/terms` missing OR `retentionClass === 'link-only'` (then only metadata + link are kept).
- Produces: `sourceById({ store, sourceId })` — latest record.

- [ ] **Step 1: Write failing tests** (registration validation; content storage gating on permission/license/retention; link-only fallback; immutable URL)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/intelligence/sources.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: register intelligence sources with rights metadata`

### Task 2: Idempotent, versioning ingestion

**Files:**
- Create: `core/intelligence/ingest.mjs`
- Create: `tests/intelligence-ingest.test.mjs`

**Interfaces:**
- Produces: `ingestSource({ store, objectsRoot, source, content }) -> { status: 'created'|'unchanged'|'updated', version, contentHash, previousVersion }`:
  - Dedupe by canonicalUrl / doi / repoIdentity (whichever is present) + contentHash.
  - Unchanged content → `unchanged`, no new rows.
  - Changed content → `updated` with `version = previous + 1`; the old extraction rows remain readable.
- Produces: `sourceVersions({ store, sourceId }) -> versions[]` and `extractionAt({ store, sourceId, version })`.
- Reprocessing the same content twice is a no-op.

- [ ] **Step 1: Write failing tests** (create; idempotent re-ingest; changed content creates a new version preserving the old; dedupe by URL and by repo identity; version monotonicity)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/intelligence/ingest.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: add idempotent versioning ingestion`

### Task 3: Structured normalization

**Files:**
- Create: `core/intelligence/normalize.mjs`
- Create: `tests/intelligence-normalize.test.mjs`

**Interfaces:**
- Produces:`normalizeSource({ source, content, extractor = null }) -> NormalizedRecord`:
  ```js
  { sourceId, version, problem, method, evidence, limitations, applicableCapability, provenance,
    tier, normalizedAt }
  ```
- Default extractor is deterministic (headings/keyword heuristic for markdown/text); a caller-supplied extractor may override.
- Provenance records `{ canonicalUrl, retrievedAt, contentHash }`.

- [ ] **Step 1: Write failing tests** (default extraction from a markdown fixture; explicit extractor override; provenance fields; tier preserved)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/intelligence/normalize.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: normalize sources into structured records`

### Task 4: Tier ranking and Candidate Patterns

**Files:**
- Create: `core/intelligence/patterns.mjs`
- Create: `tests/intelligence-patterns.test.mjs`

**Interfaces:**
- Produces: `rankSources(normalizedRecords) -> ranked` — Tier 1/2 before Tier 3/4; within tier by retrievedAt desc.
- Produces: `generateCandidatePattern({ normalized, source, minTier = 2 }) -> CandidatePattern | null`:
  ```js
  { id, title, sourceRefs: [sourceId@version], applicability, expectedBenefit, risk, implementationIdea, evidenceTier, experimentEligible }
  ```
  — returns null when the source tier > minTier (discovery-only); `experimentEligible` is true only for Tier ≤ minTier.
- Produces: `tracePattern(pattern, store) -> { sources: [...] }` — every pattern links back to exact source records.
- Produces: `candidatePatterns({ store, normalizedRecords })` — batch generation.

- [ ] **Step 1: Write failing tests** (tier ordering; secondary-only sources cannot produce an experiment-eligible pattern; pattern shape; traceability; batch generation)
- [ ] **Step 2: Verify failure**
- [ ] **Step 3: Implement `core/intelligence/patterns.mjs`**
- [ ] **Step 4: Verify focused and full suites**
- [ ] **Step 5: Commit** `feat: generate tier-ranked candidate patterns`

### Task 5: Level 6 acceptance fixtures and phase gate

**Files:**
- Create: `tests/intelligence_e2e.test.mjs`
- Create: `docs/level-6-acceptance.md`

**Acceptance fixtures:**
- A Candidate Pattern traces back to the exact paper/repository/release evidence (sourceId@version + canonical URL + content hash).
- Secondary sources (Tier 3/4) alone cannot create an experiment-eligible candidate.
- Reprocessing unchanged sources is idempotent (same status `unchanged`, no new rows).
- Changed sources create a new version while the old extraction stays readable.
- Full lifecycle: register rights → ingest → normalize → rank → pattern → trace.

**Exit gate:**
- [ ] A source can be traced from Candidate Pattern back to exact paper/repository/release evidence.
- [ ] Secondary sources alone cannot create an experiment-eligible candidate.
- [ ] Reprocessing unchanged sources is idempotent.
- [ ] Changed sources create a new version while preserving the old extraction.
- [ ] Full suite (`npm test`) passes twice.

**Stop line:** Do not start Level 7 product work if sources cannot be traced, Tier 3/4 sources can create candidates, or ingestion is not idempotent.

---

## Level 6 Definition of Done

- [ ] Source registration with immutable URLs, retrieval timestamps, tier, license/terms, retention class, permission; full content gated on rights.
- [ ] Idempotent, versioning ingestion with dedupe (URL / hash / DOI / repo identity).
- [ ] Structured normalization: problem, method, evidence, limitations, applicable capability, provenance.
- [ ] Tier ranking; experiment-eligible candidates only from Tier 1/2.
- [ ] Candidate Patterns traceable to exact source records; never enter production directly.
- [ ] Exit gate and stop line satisfied; suite passes twice.

## Deliberate Deferrals

- Live web crawling/scraping — the pipeline accepts ingested content; network acquisition is out of the automated suite.
- Citation tracking graphs — Level 7's evidence graph builds on these records.
- Hosted intelligence service — local-first only.

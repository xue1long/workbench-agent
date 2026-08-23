# Level 6 Acceptance Summary

> Recorded for Agent Workbench Level 6 (Technology Intelligence) on 2026-08-23, branch `workbench-l6`. All numbers come from the Workbench npm test suite run from the `workbench-l6` worktree.

## Gate Status

| Gate | Status | Evidence |
| --- | --- | --- |
| Workbench baseline | PASS | `npm test` 451/451 before Level 6 tasks |
| Level 5 exit gate | PASS | `docs/level-5-acceptance.md`; merged `a13fadd` |
| Level 6 full suite | PASS | 474/474 (second full pass: 474/474) |
| E2E acceptance | PASS | 3/3 in `tests/intelligence_e2e.test.mjs` |

## Test Counts

- Workbench baseline (Level 5): 451/451
- Workbench after Level 6 Tasks 1-5: **474/474** (second full pass: 474/474)
- DevFlow Runtime pytest (unchanged): 338/338

## Commits (workbench-l6, oldest → newest)

1. `732941d` feat: register intelligence sources and add idempotent ingestion
2. `a0b89ba` feat: normalize intelligence sources and generate tier-ranked candidate patterns
3. `2ae597c` test: establish level 6 acceptance gate

## Acceptance Fixtures

- **Full lifecycle (Tier 1)** — register (CC-BY-4.0, granted, tier 1) → ingest (body stored) → re-ingest unchanged (idempotent, no new extraction rows) → re-ingest changed content (new version 2, old v1 preserved) → normalize (custom extractor) → rank (Tier 1 first) → Candidate Pattern (experimentEligible true) → trace (canonicalUrl + version + extracted problem all recovered).
- **Secondary-only (Tier 3/4)** — community blog tier 3 + blog tier 4 → patterns all have `experimentEligible: false` and risk strings carrying "secondary".
- **Link-only rights gating** — `permission: unknown` + `license: null` + `retentionClass: link-only` → `bodyStored: false`, metadata-only, body content never stored.

## Trust Boundary Checklist

- Source URLs are immutable for a given id (re-registration with a different URL throws).
- Tier 3/4 sources alone cannot produce experiment-eligible patterns.
- Reprocessing unchanged content returns `unchanged` and does not append extraction rows.
- Changed content creates a new version; the old extraction remains readable via `extractionAt`.
- Full content is gated by permission + license + terms + retention class.
- The pipeline is read-only with respect to production behavior (no candidate it produces can modify routing/workflow/governed state).

## Level 6 Definition of Done

- [x] Source registration with immutable URLs, retrieval timestamps, tier, license/terms, retention, permission.
- [x] Idempotent, versioning ingestion with dedupe (URL / hash / DOI / repo identity).
- [x] Structured normalization: problem, method, evidence, limitations, capability, provenance.
- [x] Tier ranking; experiment-eligible candidates only from Tier 1/2.
- [x] Patterns traceable to exact sources; never enter production directly.
- [x] Exit gate and stop line satisfied; suite passes twice (474/474).

## Stop Line Review (Level 6 → Level 7)

- Sources can always be traced from Candidate Pattern back to exact paper/repository/release evidence — `tracePattern` returns source + ingestion + extraction rows — PASS.
- Tier 3/4 sources cannot create experiment-eligible candidates — `generateCandidatePattern` returns `experimentEligible: false` when tier > minTier — PASS.
- Ingestion is idempotent for unchanged sources — second ingest of identical content returns `unchanged` — PASS.

## Known Limits

- Network acquisition is out of the automated suite; the pipeline accepts ingested content.
- The default extractor uses deterministic heading + keyword heuristics; production deployments may wire a stronger extractor.

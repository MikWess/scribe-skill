# PR #8 blind test: semantic chapter and passage corpus

- Date: 2026-08-17
- Branch: `codex/semantic-chapter-passages`
- Base: `codex/redesign-home-reader`
- Final verdict: **SHIP — six of six profiles**

## What was tested

- Deterministic semantic chapter proposals, table-of-contents signals, exact block bounds, and citation-ready passages.
- Chapter acceptance, exclusion, reorder, page-boundary split/merge, persistence, and stale-history behavior.
- Source-asset tamper detection and optimistic corpus revision checks for human and agent mutations.
- Passage-level source-versus-reading inspection and page/block navigation in the desktop browser UI.
- The relationship between retrieval passages, reviewed audio tracks, and provider-sized audio parts.
- OCR blockers, two-column reading order, schema-4 migration, narration source drift, and zero provider egress on stale work.

The user's copy of *Good Strategy/Bad Strategy* was not discoverable from the workspace or normal local search paths, so the live test used the repository's four-page strategy fixture. A real-book golden test remains required when that PDF is attached or its path is provided.

## Round one

| Profile | Lens | Verdict | Finding |
| --- | --- | --- | --- |
| Maya | Human reader and keyboard review | Ship | Chapter proposals and review controls were understandable and keyboard-native. |
| Cipher | Security and provenance | Block | Direct corpus and passage endpoints did not verify the content-addressed source asset. |
| Leo | Listener and product value | Block | The UI did not explain that retrieval passages and provider-sized audio parts serve different jobs. |
| Sam | Audio pipeline integrity | Ship | Evidence receipts and stale-source checks stopped changed audiobook work before provider calls. |
| Forge | Autonomous agent | Block | Global passage regeneration churned unrelated IDs, and mutations lacked a revision precondition. |
| Priya | Research provenance | Block | The reader showed anchor counts but not the immutable source, exact anchors, or click-to-highlight trace. |

## Fixes made from round one

- Added source verification to section, corpus, and passage reads, with a tampered-asset HTTP regression test.
- Removed global structure revision from passage identity and limited invalidation to affected sections. Metadata-only and unrelated edits now preserve passage IDs and stale meaning.
- Required `expectedCorpusRevision` for corpus-changing section and block mutations. Stale callers receive HTTP 409 and the current corpus summary.
- Added passage source/reading comparison, hashes, revisions, character spans, individual anchor buttons, and exact page/block navigation.
- Clarified that passages anchor retrieval, graph, and skill context; accepted sections become tracks; provider limits may split a track into smaller audio parts.

## Round two and final gate

Maya, Cipher, Forge, and Priya all returned **SHIP** after the first fix set. Leo and Sam found one remaining paid-egress gap: proposed chapter boundaries could still enter provider audio and audiobook planning.

The final fix keeps no-key device preview explicitly provisional while requiring `accepted` section status in both the UI and the two paid server entry points: `/api/audio/jobs` and `/api/audiobooks/plans`. Focused tests prove both routes return 422 for proposed boundaries. Leo and Sam then returned **SHIP**.

An independent adversarial pass then exercised a migrated 7,936-block library and a 200-page book-sized corpus. It found identity injection, missing migrated hierarchy constraints, one-sided range-anchor drift, stale audiobook approvals, multi-page TOC false positives, and a 5.3 MB eager corpus response. The final implementation allowlists section patches, rejects hierarchy cycles, rebuilds schema-4 sections with the fresh-schema foreign key, reparents children on merge, preserves untouched boundary anchors, records corpus/reading-copy identity in audiobook plans, verifies the source before every paid dispatch, suppresses contiguous TOC spans, tightens chapter grammar, computes passage counts in SQL, and lazy-loads paginated passages by section.

## Is this genuinely useful?

**Yes for the PR's bounded job.** A person can turn a normal digital PDF into an editable chapter map, inspect a passage's exact source trace, and safely approve boundaries for later retrieval or audio. An agent can consume deterministic corpus JSON, retain stable passage references across unrelated reviews, detect concurrent edits, and refuse derived data after source tampering.

It is not yet the complete PDF-to-skill MVP. OCR, lexical retrieval, grounded Q&A, knowledge-graph extraction, and skill compilation remain in the next PRs. The missing real-book golden run is the main evidence gap, not a reason to weaken this slice's shipped contract.

## Verification

- `pnpm check`: type checks, 66 tests, fixture secret/PII scan, and production reader build.
- `git diff --check`: clean.
- Browser journey: import fixture, review chapter map, accept, split, merge, reload, inspect source/reading copies, and jump from an evidence anchor to its exact page/block.
- CLI journey: deterministic three-section, three-passage output with two table-of-contents signals and exact evidence anchors.

# PR 3 blind test — cited narrated section

## Gate result

All six profiles returned **MERGE YES**. The first wave found two repeated weaknesses: edited scripts became durable only after a provider render, and cache identity did not directly include immutable source/evidence. Before the second wave, PR 3 added independently saved versioned drafts, source/evidence-bound script and cache identities, and known provider-limit preflight. The final wave re-tested that iteration.

| Profile | Final verdict | Evidence used for the decision | Explicitly deferred |
| --- | --- | --- | --- |
| Maya — dyslexic graduate student | Merge | Whole-section zero-key device preview; visible boundary highlighting; pause/resume/stop; immutable source versus editable script; explicit timing quality; saved cited revision | Fine-grained edit-to-anchor mapping; persistent device playback position |
| Leo — ADHD commuter | Merge | Device is the default and immediately ready; no upfront whole-book render; clear provider tabs; saved-draft status; cache reuse and readable failures | Automatically surface the last completed artifact; compact commuter mode |
| Forge — autonomous Codex agent | Merge | Capability endpoint separates Codex from TTS; cited script endpoint; missing-key 409/no egress; deterministic queue/cache; cancel/retry/artifact API | OpenAPI/CLI/MCP discovery in PR 7 |
| Cipher — offline/BYOK enterprise agent | Merge | OS-encrypted secret store outside SQLite; set/delete/status-only renderer bridge; invalid provider names rejected; loopback token/origin boundary; fixed provider hosts; artifact hash verification; in-flight abort test | Egress receipts and broader enterprise policy enforcement |
| Priya — academic researcher | Merge | Versioned draft save/reopen; immutable source plus exact block anchors; evidence/source change prevents stale draft reuse; cache binds complete provenance; provider preflight | Revision compare/restore UI; sentence-level adaptation provenance |
| Sam — independent publisher | Merge | Prepare/preview/render one section; included-block script assembly; provider truthfulness; content-addressed local artifact; reuse avoids repeat spend; no whole-book production claim | Rights, budgets, manifests, chunk QC and delivery packaging in PR 4 |

## Verification record

- `pnpm check`: 45 tests passed; all type checks, fixture hygiene, and production reader build passed.
- Provider contract tests: OpenAI request shape, 4,096-character preflight/no egress, required voice disclosure, empty/non-audio rejection, ElevenLabs timestamp validation and Unicode ranges, invalid-base64 rejection, and missing-key no-egress behavior passed with mocks; no user API key was required.
- Queue tests: deterministic provenance-bound identity, durable draft and job persistence, idempotent cache reuse, artifact integrity, interrupted-v1 migration recovery, restart recovery, failure/retry, queued cancellation, running-request abort, and shutdown-during-synthesis safety passed.
- Local-service integration: import → cited section script → save/reopen revision → fake-provider job → poll → artifact read → cached reuse passed; missing credentials return 409 rather than creating false-success jobs.
- Secret tests: encrypted-at-rest representation, atomic concurrent updates, replacement/removal, secure-storage fail-closed behavior, private-origin enforcement, and invalid IPC provider names passed.
- Packaged macOS arm64 app: `electron-builder --dir` completed and the standalone fixture import/render smoke returned `SCRIBE_SKILL_DESKTOP_SMOKE_OK`.
- Browser QA: PDF file import, zero-key device narration, live highlighted word boundary, pause state, honest OpenAI setup/no-sync state, script edit, `UNSAVED DRAFT` state, explicit save, section switch, and saved revision reopen passed.

## Is this genuinely useful?

**Yes, within the PR 3 boundary.** A person can open a permitted PDF, select a section, edit and save a citation-bound reading script, and listen immediately with a device voice without any new account or API key. A BYOK user can generate a local, integrity-checked OpenAI or ElevenLabs artifact without losing the script/evidence provenance or accidentally paying twice for the same request. An agent can inspect capabilities and cited scripts, then fail accurately when a voice capability is absent.

It is not yet a whole-book audiobook production system. Chapter batching, rights attestation, budgets, resumable chunk manifests, pronunciation/QC, and delivery packaging remain PR 4, as stated in the UI, PRD, and ADR.

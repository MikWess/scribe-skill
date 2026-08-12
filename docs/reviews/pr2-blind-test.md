# PR 2 blind test — accessible reader

## Gate result

All six profiles returned **MERGE YES** after one blocker-driven revision. The first pass rejected the slice for a non-standalone desktop wrapper, ambiguous source versus repaired text, opaque note citations, unsafe reading-order moves, missing assistive state, and incomplete pause/resume/reload behavior. Those findings were implemented and independently re-tested.

| Profile | Final verdict | Evidence used for the decision | Explicitly deferred |
| --- | --- | --- | --- |
| Maya — dyslexic graduate student | Merge | File picker, original page + selectable regions, page quality disclosure, atomic repair/reorder/exclude, `aria-pressed`/`aria-current`, source-vs-repair panel, exact resume | OCR, synchronized word highlighting, semantic chapters |
| Leo — ADHD commuter | Merge | Device selection listening with pause/resume/stop, Media Session handlers, exact block resume after reload/reopen, one-step cited note | Generated/cached audiobook playback, skip/seek controls |
| Forge — autonomous Codex agent | Merge | Token-protected loopback JSON API covers import, page/block/section operations, progress, annotations and evidence export without a provider key | Capability discovery, CLI, MCP, cited skill compiler |
| Cipher — offline/BYOK enterprise agent | Merge | Random-port ephemeral-token desktop service, origin checks, renderer sandbox/CSP, denied permissions/navigation, no provider calls, asset integrity | Encryption, deletion, provider egress receipts |
| Priya — academic researcher | Merge | Immutable cited source visibly separate from repaired reading text; Markdown embeds a complete anchor; JSON sidecar resolves in a fresh workspace | Arbitrary selection ranges, figure/table anchors, Q&A |
| Sam — independent publisher | Merge | Standalone desktop import/render smoke, source preparation, page-based section guide, listening preview and evidence-backed editorial notes | Narration scripts, voices, rights attestation, audio/MP4 export |

## Verification record

- `pnpm check`: 26 tests passed; type checks, fixture scan and production browser build passed.
- Packaged macOS arm64 app: built with `electron-builder --dir` and completed import → page render smoke with `SCRIBE_SKILL_DESKTOP_SMOKE_OK`.
- Browser QA: file chooser import, page/section navigation, repair, atomic reorder, cited note, exact reload resume, responsive viewport and console-error inspection passed.
- Native UI inspection: the packaged app rendered the welcome and evidence-workspace surfaces and exposed the expected macOS accessibility roles/states.

## Is this genuinely useful?

**Yes, within the PR 2 boundary.** It is a usable local PDF evidence/repair notebook and device-voice preview reader. The user can start from a file picker, see exactly what extraction is uncertain, compare the immutable source with locally repaired reading text, restore their exact place and hand verifiable notes to another person or agent. It is not yet an audiobook generator, cited question-answering system, graph builder or skill compiler; the interface and documentation do not claim those later slices are complete.

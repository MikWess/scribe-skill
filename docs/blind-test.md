# Six-profile blind-test program — Iteration 1

These are independent role simulations performed against the planning artifacts, not claims about a running product. Each profile used the same proposed journey without access to the author’s intent. The resulting blockers have been incorporated into the revised PRD.

| Profile | Journey | Overall result | Scope change accepted |
| --- | --- | --- | --- |
| Maya — dyslexic graduate student | Scanned two-column science textbook → listen/read → figure question → study skill | Cannot trust document-level OCR quality alone | Page/block quality, repair queue, accessible figure descriptions, highlight preferences |
| Leo — ADHD commuter | Strategy PDF → immediate offline listening → capture idea → agent briefing | Playback contract underspecified | Offline-ready state, media controls, skips, bookmarks, script cleanup/preview |
| Forge — autonomous Codex agent, no API key | Local PDF → cited search → graph → skill | Codex SDK requires explicit capability path, not implicit BYOK fallback | Codex execution adapter, `capabilities.get`, run/budget/cancel contract, `skills.validate` |
| Cipher — offline/BYOK enterprise agent | Confidential PDF → offline retrieval/graph → portable export | Local-first intent did not enforce no egress | Offline/BYOK policy, egress receipts, local endpoint, deletion and audit requirements |
| Priya — academic researcher | Research PDF → figure/quote annotation → cited evidence export | Figure/table/quote fidelity and annotations incomplete | EvidenceAnchor, reading-order repair, region/caption model, citation/export contract |
| Sam — independent publisher | Owned manuscript → approved script → multi-chapter audio → MP4 companion | Rights, script/QC/budget and MP4 were vague | Rights attest, script revisions, hard cost ceiling, audio manifest/QC, scoped captioned MP4 |

## Gate tests before each PR

1. Every PR adds or updates at least one relevant profile fixture and measurable acceptance test.
2. A feature cannot be marked complete when it merely works on clean digital PDF text; it must disclose its quality/capability limitations.
3. Every answer, graph relationship, narration span, and export claim must resolve to an `EvidenceAnchor` or be clearly marked derived/unsupported.
4. Offline mode must be verified with network instrumentation, and agent operations must expose bounded, cancellable runs.
5. At PR 3, PR 6, PR 8, and PR 9, rerun all six profiles and publish scorecards before merging the next phase.

## Iteration 1 feedback detail

### Maya

Add per-block OCR confidence and correction/reorder/exclude before narration. Add selection playback, word/sentence/off highlighting, presentation controls, diagram description with provenance, and a keyboard/screen-reader journey.

### Leo

Require first audio in under three minutes, visibly offline before departure. Playback must restore sentence/source anchor after interruption, support media keys and configurable rewind. One action saves a timestamped bookmark/note. Provide a compact, cited briefing-skill export.

### Forge

Codex SDK is a dedicated local execution adapter with `available`, `requires-login`, and `unavailable` states; it never silently sends a book to another provider. Add `capabilities.get`, resumable budgeted runs, structured passage citations, and `skills.validate`.

### Cipher

Offline must be a technical guarantee, not a preference. BYOK needs allowlisted hosts, preflight disclosure of exact blocks/pages leaving device, approval receipts, audit provenance, and verified purge of derivatives.

### Priya

Create a durable `EvidenceAnchor` across parsing revisions; handle figures/tables/captions as visual regions. Preserve source-vs-derived annotations and export quote/title/hash/page/anchor data. Answers need claim status and exact evidence inspection.

### Sam

Require a non-legal rights attestation and manifest, editable immutable-source-linked narration scripts, pronunciation mapping, per-chunk re-render, budget ceiling, QC report, and a concrete MP4 MVP: chosen source visuals + timed captions + rights warning.

# PR #10 foundation blind test: guided inquiry

- Date: 2026-08-18
- Branch: `codex/guided-inquiry`
- Base: `codex/local-cited-retrieval`
- Final verdict: **SHIP — six of six profiles**

## What was tested

- No-key understand, challenge, apply, and reflect routes over accepted passages.
- One-question-at-a-time branching through deepen, challenge, connect, apply, synthesize, and complete moves.
- Citation-required grounded interpretations versus explicitly user-authored personal reflections.
- Local SQLite persistence, restart/resume, edits, eight-step bounds, stale-corpus refusal, deletion, and Markdown/JSON export.
- Exact source navigation from session evidence and from every saved grounded response.
- Idempotent, loopback agent API use with server-pinned document and corpus revisions.
- First-use comprehension, accessibility, privacy language, and whether the workflow is genuinely useful rather than merely functional.

## Round one

| Profile | Lens | Verdict | Finding |
| --- | --- | --- | --- |
| Maya | Accessibility-first reader | Ship | The purpose and authorship distinction were clear, but starting a second inquiry was less prominent than resuming one. |
| Cipher | Security and privacy agent | Ship with recheck | The agent contract was strong. A suspected missing source-integrity check on list was rechecked; the route already verifies the content-addressed asset, and the tamper regression now covers it explicitly. |
| Leo | Research power user | Ship | The workflow was useful, but a route name alone did not preview the actual first question or explain when branching occurs. |
| Sam | Local API integrator | Ship | The API was sufficient, but documentation did not explicitly say that creation pins current revisions server-side or show a minimal request. |
| Forge | Autonomous skill-building agent | Ship | The persisted, bounded, exportable trail was useful; a direct handoff from a saved response to its exact supporting block would improve agent reuse. |
| Priya | Careful reader/researcher | Block | Saved responses showed only a citation count, and session snippets were not labeled locally as derived retrieval context. |

## Iteration

The active-session header now exposes **New inquiry**. The route picker previews the exact opening question and tells the reader that they choose the next move after every answer. README documentation now states that creation pins the source revision on the server and includes an authenticated, idempotent agent request plus resume/edit guidance.

Priya's provenance blocker was fixed at the response itself: every saved grounded interpretation now has a clickable **Open cited block** action resolving its retrieval-selected page/block. Session excerpts say **Derived retrieval snippet · verify against source**, and Markdown exports retain preferred source-anchor IDs beside each cited answer. The existing list-route integrity check is covered by the source-tamper endpoint regression.

All six profiles rechecked their findings. No release blocker remains.

## Is this genuinely useful?

**Yes, as the provider-independent inquiry foundation.** A reader can turn an objective into a bounded line of questioning, keep book claims separate from personal thought, resume later, and audit a saved interpretation directly against the rendered source. An agent can use the same deterministic state machine and frozen evidence packet without an API key, retry creation safely, detect drift, and export a portable record with exact source anchors.

This slice deliberately does not claim AI-generated answers, a knowledge graph, or the final portable book-skill compiler. It makes those later systems inherit an inspectable evidence and inquiry contract instead of storing another opaque chat transcript.

## Verification

- `pnpm check`: 72 tests, all type checks, fixture secret/PII scan, and production reader build.
- Browser journey: resumed a local inquiry, saved a cited interpretation, branched to a personal reflection, completed, reopened, exported, and navigated from both session context and the saved response to the exact highlighted source block.
- Browser diagnostics: no console errors; requests remained on loopback/local blob URLs.
- Agent API: create, idempotent replay, inspect, answer, edit, list, Markdown/JSON export, restart, staleness, source-tamper rejection, and deletion.
- `git diff --check`: clean.

# PR 4 blind test — cited audiobook production

## Gate result

All six profiles returned **MERGE YES** after three adversarial iterations. The first implementation pass was blocked on export rights, accessibility, privacy leakage, retry affordances, cache granularity, and evidence precision. A separate read-only Codex review then found nine additional reliability issues. The final six-profile pass found one last shared blocker—structurally invalid audio was rejected but not retryable—which was fixed and retested through both the package and agent HTTP API.

| Profile | Final verdict | Evidence used for the decision | Explicitly deferred |
| --- | --- | --- | --- |
| Maya — dyslexic graduate student | Merge | Keyboard-labeled planning controls, visible blockers, semantic per-part status, retry for failed QC, deliberate warning waiver, separate export affirmation | Playback/mastering of the completed package |
| Leo — ADHD commuter | Merge | No-key dry run, exact part/cost preview, pause/cancel/resume, one-part regeneration, prior good parts not repeated | Offline sync and compact commuter controls |
| Forge — autonomous Codex agent | Merge | Idempotent plan API, synchronous invalid-state errors, durable states, pre-claim reservation reuse, conservative post-claim accounting, source-drift stop, atomic export | OpenAPI/CLI/MCP discovery in PR 7 |
| Cipher — offline/BYOK enterprise agent | Merge | Fixed provider destinations, rights and export-purpose enforcement, no hostname/token leakage, bounded pronunciation, staged publication, no live provider calls in tests | Full offline execution policy and audit viewer |
| Priya — academic researcher | Merge | Full per-part `EvidenceAnchor` records, exact/section scope honesty, source ranges, extraction-quality approval receipt, prior invalid-artifact history | Fine-grained spatial boxes for adapted narration |
| Sam — independent publisher | Merge | Immutable plan/approval receipt, hard cost/request/character ceilings, pronunciation, structural audio QC, deliberate regeneration, checksummed portable parts | Concatenation, loudness mastering, MP4 and more providers |

## Iteration record

1. **Discovery review:** profiles required explicit export rights scope, semantic status rather than color alone, redacted local paths, desktop and agent retry, chunk-level cache reuse, and exact cited ranges.
2. **Implementation review:** those issues were fixed. Five profiles cleared; Priya blocked because the portable manifest included evidence IDs without the full anchors. Full anchors were added.
3. **Adversarial reliability review:** structural MP3/WAV validation, unique section IDs, canonical idempotency replay, terminal background failures, crash-boundary reservation accounting, extraction-quality provenance, bounded pronunciation expansion, staged exports, and `.gstack/` secret hygiene were added with regressions. The six profiles then exposed and verified the final corrupt-artifact regeneration path.

## Verification record

- `pnpm check`: 52 tests passed; all type checks, fixture secret/PII checks, and the production reader build passed.
- Planner tests: deterministic provider-sized chunks, full evidence slicing, duplicate-section rejection, bounded pronunciation expansion, rights/quality/request blockers, immutable plan identity, and changed-part-only cache invalidation passed.
- Production tests: pause after active call, resume without duplicate completed work, source-drift no-egress, failed-provider retry, corrupt-MP3 rejection and explicit regeneration, pre-claim crash reservation reuse, conservative ceilings, QC waiver, full-anchor/source-review manifests, checksum verification, and non-destructive failed re-export passed with fake providers.
- Agent HTTP tests: required idempotency key, same-key replay, invalid start rejection, unique sections, 202 polling, rights-gated export, source disappearance to stale without egress, per-part corrupt-audio retry, and no repeat call for completed parts passed.
- Browser QA: at 1440×900, a realistic two-column PDF imported; the audiobook panel exposed labeled scope/provider/rights/budget/pronunciation/quality controls; blockers prevented confirmation; an approved no-key plan showed one part, 185 characters, and a $0.0037 operator estimate; start failed visibly with the exact missing-key message and no provider call. The narrow inspector view remained readable. Automated responsive screenshots were inconclusive after the browser daemon disconnected and are not counted as a pass.
- No real OpenAI or ElevenLabs key was used and no paid provider request was made.

## Is this genuinely useful?

**Yes, within the PR 4 boundary.** A reader or agent can turn permitted, reviewed PDF sections into a frozen, cited production plan without a key or provider call; see exactly what may leave the device and the conservative ceiling; generate incrementally; stop and repair individual failures; review timing limitations; and export independently verifiable audio parts with complete source and rights provenance. It avoids the two most dangerous false-success modes: silently attaching audio to changed source text and checksumming corrupt bytes as a valid audiobook.

It is intentionally not a mastered retail audiobook. Additional voice providers, concatenation/loudness work, grounded Q&A, the knowledge graph/navigation skill, and MP4 remain separately reviewable PRs.

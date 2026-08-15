# ADR 0005: Freeze audiobook production before provider egress

- Status: accepted
- Date: 2026-08-15

## Context

A chapter or whole-book run can create hundreds of paid provider requests. A generic background queue does not tell a reader or agent exactly which source revision, evidence, destination, rights scope, pronunciation rules, and cost ceiling it approved. It also makes recovery dangerous: a blind retry can duplicate paid work, while source edits can silently attach old audio to new text.

Provider pricing is not uniform. OpenAI currently documents speech billing in text and audio token units, while ElevenLabs uses subscription/credit terms. A universal dollar estimate derived from characters would be false precision.

## Decision

Before egress, ScribeSkill persists an immutable, content-hashed production plan. Confirmation creates a receipt binding the plan to the provider host, sections, evidence IDs, rights attestation, characters, and conservative estimated cost. Dollar enforcement uses an explicitly user-supplied effective USD-per-million-characters planning rate and labels it as an assumption, not a live quote.

Production uses deterministic provider-sized chunks and the existing content-addressed audio cache. It reserves the approved estimate and request count before dispatch, never automatically retries an ambiguous incomplete request, and validates the current cited section script before every new call. These values are conservative commitments, not claims about a provider invoice: a crash before the audio queue atomically claims work reuses its reservation; after claim, an explicit retry consumes a new reservation because remote billing is unknowable. Restarted work pauses for inspection. Changed source creates a stale run; a replacement plan reuses only unchanged cache identities.

A run is not complete when synthesis ends. Each artifact receives MP3/WAV structure, integrity, timing, and disclosure checks and enters `needs-review`; warnings require a recorded human or agent waiver. Failed structure/QC remains retryable: regeneration invalidates the bad cache entry while retaining the prior artifact hash and failed QC as provenance. Export is allowed only after review, is staged before publication, and produces independent chapter parts, a versioned relative-path manifest, full evidence anchors, extraction-quality review, rights/approval/QC records, and SHA-256 checksums.

## Consequences

- A dry run works without an API key or provider call.
- Users and agents can stop before a ceiling and resume without regenerating completed parts.
- Provider timing limitations remain visible instead of being presented as synchronized highlighting.
- Exports are inspectable and portable but are not yet commercially mastered or concatenated.
- MP4, loudness normalization, merged formats, and additional providers remain separate reviewed changes.

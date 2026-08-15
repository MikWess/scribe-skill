# ADR 0004: Capability-aware, evidence-linked section audio

## Status

Accepted for PR 3.

## Context

Voice providers do not offer interchangeable behavior. Browser speech synthesis is free and local but cannot create a portable artifact and its boundary events vary by operating-system voice. OpenAI's speech endpoint creates audio but does not return word timestamps. ElevenLabs' timestamped endpoint returns character alignment, but only for a provider-generated artifact. Presenting all three as uniformly synchronized would break the product's inspectability promise.

## Decision

- A narration script is a versioned view over included section blocks. It carries the immutable extracted source, editable reading text, and every block's `EvidenceAnchor`.
- Device voice is a browser preview capability. It is never placed in the server artifact queue or described as a generated audiobook file.
- OpenAI uses `POST /v1/audio/speech` with `gpt-4o-mini-tts` as the default model. Its artifacts are labeled `none` for timing quality and include the required AI-voice disclosure.
- ElevenLabs uses `POST /v1/text-to-speech/:voice_id/with-timestamps`. Character timestamps are preserved as exact local ranges; a response without alignment is labeled `none`.
- Provider calls are idempotent by script content/revision, provider, voice, model, instructions, and format. Completed bytes are content-addressed and hash-verified on read.
- Queued/running jobs survive restarts, can be cancelled or deliberately retried, and never imply success when credentials or provider capabilities are missing.
- Desktop BYOK secrets are encrypted through Electron `safeStorage` and stored outside SQLite. The renderer can set, replace, or remove a key but cannot read it back. Browser development reads keys from the local service environment.
- Codex-session capability is reported separately for script assistance. It is not a TTS provider and is not a hidden API-key fallback.

The provider contracts follow the official [OpenAI text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech) and [ElevenLabs timestamp endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps).

## Consequences

Exact read-along highlighting is available for ElevenLabs artifacts and best-effort browser boundary events are visible for device preview. OpenAI artifacts remain playable but do not highlight text in sync. Whole-book budgeting, chunk manifests, rights attestation, regeneration policy, and quality-control workflows remain PR 4 work.

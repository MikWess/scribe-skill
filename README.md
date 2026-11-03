# ScribeSkill

A local PDF reader and evidence workspace. Inspect extracted text beside rendered pages, save cited notes, listen to section scripts, and build cited audio packages with your own provider keys.

## Three useful workflows

1. **Read a paper and keep traceable notes.** Import a digital PDF, inspect its page blocks and reading order, then save notes attached to source evidence. Export Markdown plus evidence JSON so you can return to the exact passage. Image-only pages are flagged `ocr-required`; OCR is not implemented.
2. **Listen to a section while following its text.** Select a section, open the narration studio, and preview with device voices without a key. Optional OpenAI/ElevenLabs synthesis uses your own credentials and requires approval before provider egress. Device speech and provider audio have different timing capabilities; OpenAI output has no synchronized word timestamps.
3. **Plan a cited audiobook before spending on synthesis.** Open **Cited audiobook**, select the current section or section guide, and dry-run the plan. Review extraction blockers, part counts, characters, rights, and your cost estimate. Confirm the immutable plan before production, review QC warnings, then export the audio parts and evidence/approval manifest. This produces a structured audio package, not a mastered commercial audiobook or captioned MP4.

There is no question-answering/chat UI or EPUB import yet. The evidence/navigation APIs can support an external agent, but those planned product experiences are not implemented here.

## Status

Early implementation. The evidence/navigation foundation, deterministic local PDF workspace, accessible reader, and narrated-section slice are merged. The current slice adds no-key audiobook dry runs, immutable rights/budget receipts, resumable cited chapter production, structural audio QC, and portable checksummed packages. Read the [PRD](docs/PRD.md), [70+ source market research](docs/market-research.md), and [PR 4 six-profile blind-test report](docs/reviews/pr4-blind-test.md).

## Developer quick start

Requires Node.js 22.13+ (native SQLite; verified on 22.22) and pnpm 11.

```sh
git clone https://github.com/MikWess/scribe-skill.git
cd scribe-skill
pnpm install --frozen-lockfile
pnpm check
pnpm fixtures:generate work/fixtures
pnpm pdf:inspect work/fixtures/digital-two-column.pdf work/dev-library
pnpm --filter @scribe-skill/reader dev:stack
```

The inspection command stores the source by hash, extracts blocks into SQLite, renders page 1 to PNG, reports page quality, and prints source text with evidence coordinates. Image-only PDFs are marked `ocr-required` rather than treated as searchable.

The reader command starts the loopback-only local service and browser UI at `http://127.0.0.1:5173`. In the reader, choose a PDF file or enter its absolute path to import it; the CLI inspection does not automatically select that document in the UI. Both examples use `work/dev-library` under the repository root. It uses an explicitly enabled development token; direct service use requires `SCRIBE_SKILL_TOKEN`. The Electron desktop host starts the same service itself on a random port with an ephemeral token, so `pnpm --filter @scribe-skill/reader desktop:dev` needs no separate server process. Build an unpacked desktop app for the current platform with `pnpm --filter @scribe-skill/reader desktop:build`.

Select a section in the reader to open its narration studio. Device voices need no API key and preview the current cited script with browser boundary highlighting. In the desktop app, OpenAI and ElevenLabs keys are encrypted with the operating system's secure storage and never written to SQLite. The browser development surface reads `OPENAI_API_KEY` or `ELEVENLABS_API_KEY` from the local service environment instead. OpenAI audio is deliberately labeled as having no synchronized timestamps; the ElevenLabs timestamp endpoint supplies exact character alignment when returned by the provider.

Open **Cited audiobook** below the narration studio to plan one section or the current section guide. Planning makes no provider request and works without a key. It shows extraction blockers, exact part count, characters, an operator-supplied conservative cost estimate, and the immutable hash that must be confirmed before BYOK egress. Production can pause after the active part or cancel it immediately. It cannot be exported until per-part QC warnings are reviewed; the resulting local package contains independent audio parts, `audiobook.json`, `qc.json`, a rights/approval receipt, and `SHA256SUMS`. It is deliberately not presented as a commercially mastered audiobook.

Agents use the same token-protected loopback API: `POST /api/audiobooks/plans` with an `Idempotency-Key`, then `/:id/confirm`, `/:id/start`, status polling, review, and export actions. Start/resume return `202`; poll `GET /api/audiobooks/:id` until a terminal or review state. On failure, inspect `chunks`, `POST /api/audiobooks/:id/chunks/:chunkId/retry` for each failed/cancelled/interrupted part, then `POST /api/audiobooks/:id/resume`; completed parts are not called again. Every run is persisted in SQLite, carries schema version `1`, and exposes machine-readable states and part-level failures. No live provider call is used in the test suite; fake providers verify the complete workflow.

## Local configuration and troubleshooting

- `SCRIBE_SKILL_WORKSPACE` changes the service's local library directory. Import, progress, notes, and jobs are stored there. Keep personal libraries out of Git.
- To avoid occupied ports: `SCRIBE_SKILL_PORT=4318 SCRIBE_SKILL_UI_PORT=5188 pnpm --filter @scribe-skill/reader dev:stack`. The service allowlist follows the chosen reader port; the UI stops if that port is busy rather than silently switching to an unapproved origin.
- `SCRIBE_SKILL_ALLOWED_ORIGINS` is an optional comma-separated override. Use exact local origins; an empty value permits none.
- A direct service launch needs `SCRIBE_SKILL_TOKEN`. `dev:stack` deliberately opts into a known development token and is for loopback use only.
- If a page or its image fails, the reader reports the error and preserves the previous successful page. Check the service terminal and retry navigation.
- Browser device voices depend on your operating system and browser. A successful build does not confirm live microphone, speech, OS key storage, or a provider account.

`pnpm check` runs type checks, offline tests with fake providers, fixture validation, and the reader build. It does not invoke a paid provider. For an actual PDF, use the bundled synthetic fixture first, then import a document you are entitled to process.

## Design principles

1. **Your keys, your files, your choice.** Secrets live in local secure storage; book content is not uploaded unless a chosen provider call requires it.
2. **Progressive work.** Begin listening after a section is ready; do not require transcription or audio generation for an entire book.
3. **Provider-neutral.** Keep a stable internal contract across text-to-speech and AI providers.
4. **Grounded inspection.** Notes and exports retain supporting book passages.
5. **Agent-native, not agent-only.** Every important capability is usable from the UI and a documented local API/CLI.

## License

MIT.

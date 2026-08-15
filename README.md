# ScribeSkill

Turn permitted PDFs into inspectable, cited skills for humans and AI agents. Read along with synchronized highlighting, create audio or a captioned MP4 companion incrementally, ask grounded questions through your own AI provider, and preserve optional insights locally in SQLite.

## Why it exists

Books are rich source material, but today their reading, listening, retrieval, and agent-use workflows are fragmented. ScribeSkill puts them in one inspectable local workspace:

- import PDFs (and later EPUB/text)
- navigate chapters or semantic sections
- synthesize and play narration while words highlight in sync
- connect the LLM and voice services you already pay for
- ask questions with page/section citations and save notes locally
- let agents build structured audio/video jobs or turn a book into a reusable, evidence-backed skill

The exported skill is a navigation guide, not a static summary. Given a task, it selects the most relevant chapter context, graph neighborhood, figures/tables, and exact passages within a bounded context budget. It also tells the agent how to use that context, when it is making an inference, and when the book does not support an answer.

## Status

Early implementation. The evidence/navigation foundation, deterministic local PDF workspace, accessible reader, and narrated-section slice are merged. The current slice adds no-key audiobook dry runs, immutable rights/budget receipts, resumable cited chapter production, structural audio QC, and portable checksummed packages. Read the [PRD](docs/PRD.md), [70+ source market research](docs/market-research.md), and [PR 4 six-profile blind-test report](docs/reviews/pr4-blind-test.md).

## Developer quick start

Requires Node.js 22+ and pnpm 11.

```sh
pnpm install
pnpm check
pnpm fixtures:generate work/fixtures
pnpm pdf:inspect work/fixtures/digital-two-column.pdf work/library
pnpm --filter @scribe-skill/reader dev:stack
```

The inspection command stores the source by hash, extracts blocks into SQLite, renders page 1 to PNG, reports page quality, and prints source text with evidence coordinates. Image-only PDFs are marked `ocr-required` rather than treated as searchable.

The reader command starts the loopback-only local service and browser UI at `http://localhost:5173`. It uses an explicitly enabled development token; direct service use requires `SCRIBE_SKILL_TOKEN`. The Electron desktop host starts the same service itself on a random port with an ephemeral token, so `pnpm --filter @scribe-skill/reader desktop:dev` needs no separate server process. Build an unpacked desktop app for the current platform with `pnpm --filter @scribe-skill/reader desktop:build`.

Select a section in the reader to open its narration studio. Device voices need no API key and preview the current cited script with browser boundary highlighting. In the desktop app, OpenAI and ElevenLabs keys are encrypted with the operating system's secure storage and never written to SQLite. The browser development surface reads `OPENAI_API_KEY` or `ELEVENLABS_API_KEY` from the local service environment instead. OpenAI audio is deliberately labeled as having no synchronized timestamps; the ElevenLabs timestamp endpoint supplies exact character alignment when returned by the provider.

Open **Cited audiobook** below the narration studio to plan one section or the current section guide. Planning makes no provider request and works without a key. It shows extraction blockers, exact part count, characters, an operator-supplied conservative cost estimate, and the immutable hash that must be confirmed before BYOK egress. Production can pause after the active part or cancel it immediately. It cannot be exported until per-part QC warnings are reviewed; the resulting local package contains independent audio parts, `audiobook.json`, `qc.json`, a rights/approval receipt, and `SHA256SUMS`. It is deliberately not presented as a commercially mastered audiobook.

Agents use the same token-protected loopback API: `POST /api/audiobooks/plans` with an `Idempotency-Key`, then `/:id/confirm`, `/:id/start`, status polling, review, and export actions. Start/resume return `202`; poll `GET /api/audiobooks/:id` until a terminal or review state. On failure, inspect `chunks`, `POST /api/audiobooks/:id/chunks/:chunkId/retry` for each failed/cancelled/interrupted part, then `POST /api/audiobooks/:id/resume`; completed parts are not called again. Every run is persisted in SQLite, carries schema version `1`, and exposes machine-readable states and part-level failures. No live provider call is used in the test suite; fake providers verify the complete workflow.

## Design principles

1. **Your keys, your files, your choice.** Secrets live in local secure storage; book content is not uploaded unless a chosen provider call requires it.
2. **Progressive work.** Begin listening after a section is ready; do not require transcription or audio generation for an entire book.
3. **Provider-neutral.** Keep a stable internal contract across text-to-speech and AI providers.
4. **Grounded inspection.** Answers show the supporting book passages.
5. **Agent-native, not agent-only.** Every important capability is usable from the UI and a documented local API/CLI.

## License

MIT.

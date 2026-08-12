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

Early implementation. The evidence/navigation foundation and deterministic local PDF workspace are merged; the accessible reader is the current pull-request slice. Read the [PRD](docs/PRD.md), [70+ source market research](docs/market-research.md), and [six-profile blind-test findings](docs/blind-test.md).

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

## Design principles

1. **Your keys, your files, your choice.** Secrets live in local secure storage; book content is not uploaded unless a chosen provider call requires it.
2. **Progressive work.** Begin listening after a section is ready; do not require transcription or audio generation for an entire book.
3. **Provider-neutral.** Keep a stable internal contract across text-to-speech and AI providers.
4. **Grounded inspection.** Answers show the supporting book passages.
5. **Agent-native, not agent-only.** Every important capability is usable from the UI and a documented local API/CLI.

## License

MIT.

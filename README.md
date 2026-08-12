# Scribe Sandbox

Local-first PDF and book inspection for humans and AI agents. Read along with synchronized highlighting, create audiobooks incrementally, ask grounded questions through your own AI provider, and optionally preserve insights in SQLite.

## Why it exists

Books are rich source material, but today their reading, listening, retrieval, and agent-use workflows are fragmented. Scribe Sandbox puts them in one inspectable local workspace:

- import PDFs (and later EPUB/text)
- navigate chapters or semantic sections
- synthesize and play narration while words highlight in sync
- connect the LLM and voice services you already pay for
- ask questions with page/section citations and save notes locally
- let agents build structured audiobook jobs or turn a book into a reusable skill

## Status

Product planning. The delivery sequence and full product requirements are in [docs/PRD.md](docs/PRD.md).

## Design principles

1. **Your keys, your files, your choice.** Secrets live in local secure storage; book content is not uploaded unless a chosen provider call requires it.
2. **Progressive work.** Begin listening after a section is ready; do not require transcription or audio generation for an entire book.
3. **Provider-neutral.** Keep a stable internal contract across text-to-speech and AI providers.
4. **Grounded inspection.** Answers show the supporting book passages.
5. **Agent-native, not agent-only.** Every important capability is usable from the UI and a documented local API/CLI.

## License

Apache-2.0 (planned for the first implementation PR).

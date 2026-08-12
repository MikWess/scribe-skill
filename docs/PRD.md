# Scribe Sandbox — Product Requirements Document

## 1. Product summary

Scribe Sandbox is a local-first desktop/web application and local agent service for inspecting books and PDFs. It aligns synthesized audio with displayed text, supports questions and saved insights using a user-selected AI provider, and can progressively produce chapter-based audiobook assets. Its API/CLI lets AI agents run the same ingest, narration, retrieval, and book-to-skill workflows autonomously.

## 2. Problem

Readers who want to move fluidly between page, audio, note-taking, and deep inquiry must stitch together several disconnected tools. AI agents have an additional gap: they can read extracted text but usually lack a structured, durable representation of a book, a citation discipline, and a portable output that users can reuse as context.

## 3. Users and jobs

| User | Job to be done |
| --- | --- |
| Reader/listener | Read a PDF while listening, resume at a meaningful location, and control pace/voice without waiting for a full audiobook. |
| Researcher/student | Ask evidence-backed questions, retain notes and claims locally, and return to their source passages. |
| Power user | Bring preferred OpenAI-compatible LLM and voice API keys; choose what leaves their device. |
| AI agent | Ingest a book, create sections/audio jobs, query cited context, construct a knowledge graph, and emit a reusable skill package. |

## 4. Goals

- Import PDF documents and reliably preserve page/paragraph source locations.
- Produce narration per section/chapter, with sentence- then word-level synchronization where provider timing is available or can be aligned locally.
- Support a pluggable set of voice providers: OpenAI, ElevenLabs, Azure Speech, Google Cloud TTS, Amazon Polly, and any compatible custom HTTP adapter.
- Support user-configured AI providers through OpenAI-compatible APIs first, then native adapters as needed.
- Offer optional local SQLite persistence for library metadata, settings references, jobs, chunks, embeddings, notes, Q&A, and graph data.
- Expose all core flows through a local authenticated API and CLI suitable for coding agents.
- Turn a book into a reusable “book skill”: concise purpose, coverage map, concepts/entities, relationships, retrieval rules, citations, and a generated SKILL.md package.

## 5. Non-goals for v1

- Circumventing DRM, copyright restrictions, or access controls.
- A marketplace for audiobooks, hosted social features, or collaborative editing.
- Claiming perfect OCR/layout recovery for arbitrary scanned PDFs.
- Sending whole books to a provider by default.
- Replacing full professional audiobook production tools.

## 6. Key product flows

### A. Read and listen

1. User imports a PDF; the app stores the original locally and extracts pages/blocks.
2. The parser proposes chapter/section boundaries, with editable results.
3. User selects a voice/provider and presses play on a section.
4. Text-to-speech is generated or streamed for only the needed section; playback highlights the active sentence/word and supports page following.
5. Generated audio and alignment are cached locally, so listening resumes offline where the provider format permits.

### B. Inspect and ask

1. User configures an LLM provider/key and chooses local-only indexing or provider-backed embeddings.
2. The app retrieves relevant chunks, answers with linked page/section citations, and offers “save insight.”
3. Saved insights, quotes, and chat runs are stored in SQLite if persistence is enabled.

### C. Create an audiobook

1. User or agent selects chapters/sections, voice, pronunciation rules, and output format.
2. A job queue produces audio and alignment incrementally with pause/retry/cost estimates.
3. The app exports chapter files, metadata, and optionally a merged audiobook manifest.

### D. Agent workflow / book-to-skill

1. An agent authenticates to the local service and imports or references a local document.
2. It requests structured sections, cited retrieval, narration jobs, or a knowledge-graph build.
3. The graph pipeline extracts entities, concepts, claims, and relationships, all traceable to chunks/pages.
4. It writes a portable skill directory containing `SKILL.md`, graph/context artifacts, source manifest, and citation policy.

## 7. Functional requirements

### Library and parsing

- PDF import with file hash/deduplication, metadata, page images/text, extraction quality indicator, and OCR handoff for scanned pages.
- Section model supports title, hierarchy, source page range, text range, parser confidence, and user edits.
- Chunk model has stable IDs and source anchors for citations and timing.

### Synchronized audio

- Playback controls: play/pause, seek, speed, volume, next/previous section, and resume position.
- Audio alignment contract supports word timestamps, sentence timestamps, or estimated sentence timing with an explicit quality label.
- Text view highlights actively spoken text and scrolls without taking control away from the reader.
- TTS task queue has provider-aware rate limits, cancellation, retries, usage/cost logs, caching, and idempotency.

### AI and insights

- Provider registry stores local configuration metadata; secrets use OS secure storage, never SQLite plaintext.
- OpenAI-compatible chat/embedding connector is the first LLM interface. Custom endpoints and models are supported.
- Answers display citations and distinguish book evidence from model synthesis.
- Users can create, search, export, and delete local notes/insights.

### Knowledge graph and skills

- Graph nodes: concept, entity, claim, event, person, place, and section; edges have type, confidence, and source citations.
- Graph construction runs progressively and can be reviewed/edited before export.
- A generated book skill contains: intent, source scope, key concepts, graph/index paths, a cited query workflow, and agent guidance against treating generated summaries as primary evidence.

### Agent interface

- Local HTTP API plus CLI; both provide schema/version discovery.
- Initial commands/endpoints: `books.import`, `books.sections`, `audio.create`, `audio.status`, `search.query`, `insights.save`, `graph.build`, and `skills.export`.
- Default binding is loopback only, with per-install auth token and explicit opt-in before non-local exposure.

## 8. Technical direction

Use a TypeScript monorepo: a React reader UI, a local service, shared domain/provider contracts, and a CLI. SQLite is the canonical local database; files/audio are stored in a content-addressed workspace. Keep provider adapters behind interfaces so vendor SDKs never leak into core domain logic. Use a job queue with persisted state. Use PDF.js for initial digital-PDF extraction/rendering and a separate OCR adapter boundary.

## 9. Privacy, security, and rights

- API keys use platform secure storage and are redacted from logs/export files.
- The app clearly discloses every provider request including selected text, estimated tokens/characters, and estimated cost where possible.
- The original book and derived data remain local by default.
- Export includes source attribution; users are responsible for rights to synthesize, redistribute, or publish audiobook output.

## 10. Success metrics

- A user can reach first narrated section within three minutes of importing a normal text PDF.
- At least 95% of successful narrated sections resume and retain a valid source anchor.
- Every answer shown in the app either has one or more inspectable citations or is explicitly labeled unsupported.
- An agent can complete ingest → section query → cited search → audio job using only local API docs and credentials.

## 11. Risks and decisions to validate

- PDF reading order and chapter detection vary heavily; retain editable source anchors and quality indicators.
- Word timing is not universal across providers; product language must expose alignment quality rather than pretend uniform precision.
- LLM/embedding costs and book rights require clear, up-front controls.
- “Skill” needs a portable contract; start with a self-contained directory and later add optional integrations (Codex/Claude) rather than hard-coding one vendor.

## 12. Delivery plan: proposed pull requests

| PR | Scope | Acceptance evidence |
| --- | --- | --- |
| 0 | Repository foundation: monorepo, license, CI, architecture decision records, threat model, fixtures policy | Fresh checkout installs, lints, tests, and starts an empty local app. |
| 1 | PDF library vertical slice: import, hashing, PDF.js extraction/rendering, page/block schema, local SQLite migrations | Import a digital PDF; view pages and extracted text with stable page/block anchors after restart. |
| 2 | Sectioning and reader: proposed/editable chapter tree, reader UI, persisted reading position | User edits a section boundary and sees it retained; navigation follows sections/pages. |
| 3 | Voice-provider foundation and narrated section: secret storage, provider interface, OpenAI TTS adapter, job queue/cache, audio playback | User configures a key, generates one selected section, pauses/resumes it, and sees sentence highlighting. |
| 4 | Alignment and audiobook jobs: timing adapters, quality labels, batch chapter queue, progress/retry/cancel, exports | Generate several chapters incrementally; export playable chapter audio with a manifest. |
| 5 | Multi-provider expansion: ElevenLabs, Azure, Google, Polly, custom HTTP adapter plus compatibility tests | Same selected section works through each configured adapter or reports actionable capability limits. |
| 6 | Grounded AI inspection: OpenAI-compatible LLM/embedding connector, local retrieval, cited Q&A, saved SQLite insights | Question returns clickable sources; saved insight survives restart and can be deleted/exported. |
| 7 | Local agent API/CLI: loopback auth, OpenAPI/schema discovery, documented ingest/section/audio/search/insight actions | Script completes an end-to-end book workflow without UI. |
| 8 | Knowledge graph and book-to-skill: cited graph pipeline, review UI, `SKILL.md` export package, agent examples | Agent builds a graph, reviews its evidence, and exports a usable portable book skill. |
| 9 | Hardening: OCR adapter, observability/redaction, backup/export/import, accessibility, performance and security review | Scanned-PDF handoff behaves clearly; keyboard/screen-reader flows and privacy controls are verified. |

## 13. Open decisions before implementation

1. Should v1 ship as a desktop app (recommended: Tauri) or a browser UI backed by a local service? Desktop simplifies secure storage, filesystem access, and offline playback.
2. Should the first released voice adapter be OpenAI or ElevenLabs? OpenAI makes an OpenAI-compatible provider story coherent; ElevenLabs has stronger narration-oriented controls.
3. What is the intended public repository name? Working recommendation: `scribe-sandbox`.

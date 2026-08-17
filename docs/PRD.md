# ScribeSkill — Product Requirements Document

## 1. Product summary

ScribeSkill is a local-first desktop application with an optional browser read-along/note surface and local agent service. It turns permitted books and PDFs into inspectable, cited skills; aligns synthesized audio with displayed text; supports questions and saved insights using a user-selected AI provider; and progressively produces chapter-based audio or captioned MP4 companion assets. Its API/CLI/MCP lets AI agents run the same ingest, narration, retrieval, and book-to-skill workflows autonomously.

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
- Provide MCP resources, prompts and tools over the same local workspace.
- Support Codex-session execution for testing/autonomous compilation where available, without silently substituting an API-key provider.
- Turn a book into a reusable “book skill”: concise purpose, coverage map, concepts/entities, relationships, retrieval rules, citations, and a generated SKILL.md package.
- Make the skill an operational navigation guide: it routes an agent's current task to bounded chapter, passage, figure/table, and graph context; explains how to apply that context; and requires source verification before answering.

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

1. User or agent selects chapters/sections, voice, pronunciation rules, output format, rights scope, and hard character/request/cost ceilings.
2. A no-key local dry run freezes cited source revisions, provider host, deterministic parts, quality blockers, a conservative user-supplied planning rate, and an immutable confirmation hash before egress.
3. A persisted queue produces audio and alignment incrementally with pause/cancel/explicit retry; content-addressed cache reuse prevents unchanged parts from being synthesized twice.
4. Synthesis enters review rather than claiming completion. The operator inspects per-part integrity/timing disclosures and records a reason for any warning waiver.
5. The app exports independent chapter parts, a versioned relative-path manifest, approval/rights/QC records, and checksums. Commercial mastering or merged formats are later opt-in stages.

### D. Agent workflow / book-to-skill

1. An agent authenticates to the local service and imports or references a local document.
2. It requests structured sections, cited retrieval, narration jobs, or a knowledge-graph build.
3. The graph pipeline extracts entities, concepts, claims, and relationships, all traceable to chunks/pages.
4. It writes a portable skill directory containing `SKILL.md`, graph/context artifacts, source manifest, and citation policy.

## 7. Functional requirements

### Library and parsing

- PDF import with file hash/deduplication, metadata, page images/text, extraction quality per page/block, and explicit local/external OCR handoff for scanned pages.
- Section model supports title, hierarchy, source page range, text range, parser confidence, and user edits.
- Chunk model has stable IDs and source anchors for citations and timing. The canonical `EvidenceAnchor` records document hash, page, bounding box, character span, extraction revision, and optional figure/table/caption ID.
- Users can repair reading order, text bounds and include/exclude status without losing the original extraction; figures/tables are page-region objects with caption/description state.

### Synchronized audio

- Playback controls: play/pause, seek, speed, volume, next/previous section, and resume position.
- Support selection-only playback, 10/30/60 second rewind, media-session controls, offline-ready state, bookmarks and a previewable/edited narration script.
- Audio alignment contract supports word timestamps, sentence timestamps, or estimated sentence timing with an explicit quality label.
- Text view highlights actively spoken text and scrolls without taking control away from the reader.
- TTS task queue has provider-aware rate limits, cancellation, retries, usage/cost logs, caching, and idempotency.

### AI and insights

- Provider registry stores local configuration metadata; secrets use OS secure storage, never SQLite plaintext.
- OpenAI-compatible chat/embedding connector is the first LLM interface. Custom endpoints and models are supported.
- Answers display citations and distinguish book evidence from model synthesis.
- Users can create, search, export, and delete local notes/insights.
- Annotations preserve exact source selections and export as Markdown plus structured evidence data; annotations distinguish source, model-derived, and user-authored content.

### Knowledge graph and skills

- Graph nodes: concept, entity, claim, event, person, place, and section; edges have type, confidence, and source citations.
- Graph construction runs progressively and can be reviewed/edited before export.
- A generated book skill contains: intent, source scope, key concepts, graph/index paths, a cited query workflow, and agent guidance against treating generated summaries as primary evidence.
- Navigation routes contain task/intent triggers, ranked context selectors, token budgets, evidence anchors, usage instructions, and an evidence-first fallback for unmatched questions.
- The package includes schema version, source hashes, citations/evidence index, quality report, and grounded evaluation cases; `skills.validate` verifies these before it is marked ready.

### Agent interface

- Local HTTP API, CLI, and MCP server; all provide schema/version and capability discovery.
- Initial commands/endpoints: `books.import`, `books.sections`, `audio.create`, `audio.status`, `search.query`, `insights.save`, `graph.build`, and `skills.export`.
- Default binding is loopback only, with per-install auth token and explicit opt-in before non-local exposure.
- `capabilities.get` distinguishes offline, local-model, Codex-session, BYOK, and unavailable paths. Runs expose bounded budget/scope, machine-readable progress, idempotent resume/cancel and redacted logs.

## 8. Technical direction

Use a TypeScript monorepo: a desktop host, React reader UI, optional browser UI, local service, shared domain/provider contracts, CLI and MCP server. SQLite is the canonical local database; files/audio are stored in a content-addressed workspace. Keep provider adapters behind interfaces so vendor SDKs never leak into core domain logic. Use a job queue with persisted state. Use PDF.js for initial digital-PDF extraction/rendering and a separate OCR adapter boundary. The first agent adapter is the Codex TypeScript SDK, strictly capability-gated; local OpenAI-compatible endpoints and BYOK remain equal execution modes.

## 9. Privacy, security, and rights

- API keys use platform secure storage and are redacted from logs/export files.
- The app clearly discloses every provider request including selected text, estimated tokens/characters, and estimated cost where possible.
- The original book and derived data remain local by default.
- Execution policy is explicit: **Offline** forbids egress, **BYOK** requires destination allowlist and per-operation approval, and managed operation is out of scope for v1. Egress receipts record selected chunks, host, purpose and approval.
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

This table records the original delivery decomposition. For the forward plan after the current PR #6 → PR #7 merge train, use the [next 10 PR roadmap](next-10-prs.md); it supersedes the ordering below while preserving this PRD's product requirements.

| PR | Scope | Acceptance evidence |
| --- | --- | --- |
| 0 | Foundation: monorepo, license, CI, ADRs, threat model, fixtures, execution policy, capability/run/evidence schemas | Fresh checkout installs, lints, tests, starts locally, and explains each unavailable execution capability. |
| 1 | Evidence-first PDF workspace: import, hashing, PDF.js extraction/rendering, SQLite migrations, page/block/span anchors, quality/repair model | Import a digital or scanned fixture; view stable anchors and correct/reject uncertain blocks after restart. |
| 2 | Accessible reader: editable section guide, provenance-labeled annotations, reader UI, persisted progress, device selection playback and media controls | Keyboard user repairs order, distinguishes source from reading-text repairs, resumes the exact block, and exports portable evidence payloads. |
| 3 | Narrated-section vertical slice: keychain, capability-aware providers, Codex test adapter, OpenAI/ElevenLabs TTS, scripts, queue/cache | One selected section previews/plays with disclosed timing quality; no-key Codex environment fails only where a capability is absent. |
| 4 | Audiobook production: immutable dry run, chapter queue, rights receipt, conservative cost ceiling, pause/cancel/explicit retry, source-drift stop, structural audio QC and versioned checksummed package | A fake-provider multi-chapter run makes no unapproved call, pauses/resumes without duplicates, rejects source drift and corrupt audio, regenerates only the failed part, and atomically exports only after review. A replacement plan reuses unchanged audio identities. |
| 5 | Provider breadth: Azure, Google, Polly, custom HTTP adapter and capability matrix | Each configured provider works or reports exact feature/limit differences before spend. |
| 6 | Grounded inspection: local/OpenAI-compatible retrieval, cited Q&A, insights, figure/table citations, privacy receipts | Answers open exact evidence and preserve OCR confidence; Offline mode makes zero network calls. |
| 7 | Agent integration: local CLI/API/MCP, loopback auth, Codex-session adapter, skills validation | An agent completes import → cited search → validated export without UI. |
| 8 | Incremental graph and portable skill: evidence-backed graph, review UI, `SKILL.md`/SQLite package, evals | Agent builds/reviews a graph and exports a validated, topic-addressable skill. |
| 9 | Captioned MP4 companion: chosen page/figure visuals, timed captions, source refs, rights warning, render QA | One chapter exports MP4 + VTT/SRT with every visual traceable to a source. |
| 10 | Hardening: OCR providers, backup/import, deletion, encryption strategy, accessibility/performance/security review | Scanned flow, purge-derived-data, screen reader, and privacy controls are verified. |

## 13. Decisions and remaining validation

1. **Desktop first with an optional browser UI** is selected. The desktop host owns secure storage, filesystem, local service and offline assets; the browser UI is an opt-in read-along/note surface.
2. **OpenAI and ElevenLabs are the initial voice adapters.** OpenAI validates the default SDK integration; ElevenLabs validates precise timestamp alignment. The UI reports the capability difference.
3. **ScribeSkill** is selected as the public name: “Turn permitted PDFs into inspectable, cited skills for humans and agents.”
4. **Electron is the current desktop host.** Its packaged Node runtime owns the loopback service, SQLite workspace and filesystem access; keep the renderer sandboxed and browser-compatible. Reconsider Tauri only if a production sidecar can preserve that standalone contract.
5. Validate export compatibility against current agent-skill host conventions. Keep the artifact portable and versioned rather than targeting a single vendor.

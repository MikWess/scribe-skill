# ADR 0007: Make cited retrieval local, revision-pinned, and source-first

- Status: accepted
- Date: 2026-08-17

## Context

ScribeSkill needs retrieval before it needs generated answers. A reader should be able to find where an author develops an idea and inspect the exact page region in one step. An agent needs the same operation with a bounded context budget, stable machine-readable evidence, and a clear refusal when the corpus cannot support the request.

Generic search APIs are not sufficient. Reading-copy repairs must not alter what is represented as source evidence; unreviewed chapter proposals must not silently enter trusted context; stale callers must not receive results from a different corpus revision; and prompt-injection-shaped book text must remain inert data.

## Decision

ScribeSkill provides a versioned `search.query` operation over the local semantic corpus:

- SQLite FTS5 indexes immutable source text for current passages. Reading-copy edits remain inspectable beside the source but do not change lexical retrieval.
- Accepted chapters are searched by default. Proposed boundaries enter a query only when the caller explicitly requests the `proposed` review state; excluded content is never current search evidence.
- Every request supplies the expected corpus revision and may additionally pin the document hash and extraction revision. Revision drift fails closed instead of silently mixing old intent with new evidence.
- Queries are normalized into bounded literal terms and compiled into a parameterized FTS expression. Callers cannot supply raw FTS operators or SQL, and indexed book text is always returned as untrusted source data.
- Results contain whole passages only. The context budget is measured in immutable source-text characters; oversized passages are omitted rather than silently truncated. The response distinguishes no match from budget exhaustion and reports the minimum required size when known.
- Each result carries its full evidence-anchor set plus a preferred anchor selected from the matching source block. The UI opens that exact PDF page and highlighted block. Ranking explanations and snippets are explicitly labeled derived navigation aids.
- Filters cover chapter, page range, extraction quality, review state, extraction revision, and visual evidence. Visual state is truthful and tri-state: known figure/table regions, any known visual region, or unknown when no region metadata exists.
- Search is deterministic for a frozen corpus. Ties resolve by section order, passage order, and stable identity; at most 200 candidates are considered before the caller's result and context limits are applied.
- Index maintenance is transactional and incremental when a section's passages change. Retrieval makes no network or model-provider request and needs no API key.

## Consequences

- Humans and agents can acquire bounded, inspectable evidence before any model is configured.
- Search favors auditability over semantic recall. Embeddings, query expansion, and generated answers may be added later behind the same source-first contract.
- A reading-copy correction may help narration without changing search vocabulary. Source repair requires an explicit extraction revision rather than rewriting evidence in place.
- Proposed structure is usable during review, but every returned section status remains visible and machine-readable.
- Figure/table filtering remains conservative until structured visual-region extraction exists; absence of metadata is reported as unknown, not as proof that a visual is absent.

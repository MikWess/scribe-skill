# ADR 0008: Persist inquiry before adding model-generated answers

- Status: accepted
- Date: 2026-08-18

## Context

Cited search finds relevant words, but a useful book skill must also guide a person or agent through an objective. A flat chat transcript does not express whether a statement came from the book or the reader, which evidence supports it, why the next question was chosen, or whether a later source edit invalidated the reasoning. Requiring an AI provider for this workflow would also make the local product less useful and make provider tests the only way to exercise inquiry state.

## Decision

ScribeSkill persists provider-independent guided inquiries in the PDF workspace:

- A session begins with one of four versioned routes: understand, challenge, apply, or reflect.
- Its objective is resolved through local cited retrieval over accepted passages with a bounded source-character budget. No match refuses session creation rather than starting an ungrounded workflow.
- The route asks one question at a time. After each response, the operator chooses an explicit next move: deepen, challenge, connect, apply, synthesize, or complete. Sessions stop at eight steps.
- Every response declares its authorship semantics. A grounded interpretation must cite at least one passage selected for the session. A personal reflection may remain uncited and is never presented as a claim made by the book.
- The selected passage metadata, evidence anchors, prompts, responses, branches, and route version are stored in SQLite. Creation is idempotent for agent retry safety.
- A corpus-revision or passage-content change marks the session stale and prevents further advancement. Existing writing remains inspectable and exportable without silently retargeting its citations.
- The browser UI and loopback HTTP API share the same create, list, inspect, answer, edit, export, and delete operations. Markdown and JSON exports retain provenance labels and source identities.

## Consequences

- Guided inquiry is useful without a model, API key, or network request.
- Bounded Codex, BYOK, and local-model execution can later propose answers or next moves into the same contract rather than owning persistence or provenance.
- The initial branch choice is operator-directed rather than model-adaptive. This is deliberate: the branch decision remains inspectable while the execution layer is still under construction.
- Inquiry is not yet the knowledge graph or portable book-skill compiler, but its routes and provenance distinctions become direct inputs to those later artifacts.

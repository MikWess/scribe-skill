# ADR 0006: Share one versioned semantic corpus across reading, audio, graph, and skills

- Status: accepted
- Date: 2026-08-17

## Context

The first reader represented every PDF page as a section. That was sufficient to prove evidence-linked reading and narration, but it made page boundaries stand in for book structure. Retrieval, knowledge-graph extraction, skill routing, and continuous audiobook playback need the same stable chapter and passage identities. If each subsystem chunks the book independently, citations drift and an edit can leave derived data attached to the wrong source.

PDF heading detection is also uncertain. Font size, capitalization, table-of-contents text, printed page numbers, and extraction order are signals rather than source truth. Image-only pages provide no text signal at all.

## Decision

ScribeSkill stores a versioned local corpus in SQLite:

- A section is a chapter or nested section with page/block bounds, hierarchy level, order, confidence, origin, review status, rationale, and structure revision.
- A passage is a bounded reading unit linked to one section. It preserves immutable source text, editable reading text, start/end blocks, exact evidence anchors, extraction quality, and both extraction and structure revisions.
- Deterministic detection uses heading form, relative text height, named book-section labels, and table-of-contents entries. It emits proposals with rationales; it never silently marks them user-reviewed.
- Clear two-column pages receive a deterministic left-column-then-right-column reading order. Uncertain pages retain a visible `review-needed` quality state.
- A reading-copy or structure edit increments the document corpus revision. Only passages whose bounded section content changed become stale; metadata-only review and unrelated chapter edits preserve passage IDs. Original blocks and their evidence anchors remain unchanged.
- Corpus-changing section and block mutations require the caller's expected corpus revision. Stale callers receive HTTP 409 plus the current summary instead of silently overwriting a newer human or agent review.
- Image-only pages remain `ocr-required` and produce no fabricated passages.
- Existing schema-4 page guides migrate in place. Untouched `Page N` placeholders are replaced with detected structure; edited legacy guides are preserved and receive passages.
- The existing section APIs remain compatible for narration and audiobook production. Corpus/open responses carry only the summary and chapter map; passages are loaded by section through a bounded, offset-paginated endpoint so book-sized PDFs do not repeatedly move megabytes of evidence JSON.
- Device narration may preview a proposed boundary, but paid provider audio and audiobook plans require explicitly accepted sections. Provider-sized audio parts remain distinct from retrieval passages and never cross an accepted section boundary.
- An audiobook approval records the corpus revision and reading-copy identity. Source tampering or any later boundary, status, order, title, or reading-copy change fails closed before provider egress and requires a new plan.

## Consequences

- Reader, audio, retrieval, graph, and skill work can refer to the same section and passage identities.
- Users must review uncertain proposals; deterministic heuristics will not recover every book hierarchy.
- Passage history costs additional local storage but makes source and structure drift inspectable.
- Splitting currently uses page boundaries. Same-page heading repair and provider-backed OCR remain later work.
- Lexical search, grounded Q&A, graph extraction, and skill compilation can build on this corpus without redefining citations.

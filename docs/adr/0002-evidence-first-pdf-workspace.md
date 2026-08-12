# ADR 0002: Evidence-first PDF workspace

**Status:** Accepted

PR 1 uses PDF.js for digital-PDF extraction and Node's local SQLite API for the first service implementation. The source PDF is copied into a content-addressed asset path; SQLite stores documents, page-level quality, immutable extracted blocks, user repairs, and audit history.

Evidence anchors bind a document hash, page, block, character span, extraction revision, content hash, and normalized bounding box. User-corrected text/order/status never overwrites the extracted source. Image-only pages are marked `ocr-required`; multi-column or otherwise suspicious pages are marked `review-needed` rather than presented as trustworthy.

The quality classifier is intentionally conservative and heuristic in this PR. OCR, visual-region parsing, and a richer layout model remain adapter boundaries for later PRs. The Tauri host decision must account for SQLite ownership; this package defines the data behavior, not the final desktop process boundary.

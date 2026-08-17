# Fixture policy

Fixtures must be authored for this project, clearly licensed for redistribution, or generated from public-domain material. Do not commit private, copyrighted, DRM-protected, or credential-bearing documents.

The planned matrix covers clean digital text, two-column layout, scanned pages, figures/tables, malformed input, interruption/resume, no-network operation, and deliberately unsupported questions. Generated fixtures must include their generator and expected anchors so extraction regressions are inspectable.

Run `pnpm fixtures:generate work/fixtures` to create the current local set: a two-column evidence fixture, an image-only OCR blocker, and a four-page semantic-chapter fixture with a table of contents. Generated PDFs under `work/` are intentionally untracked.

CI scans tracked fixture text for common secrets and PII. False positives require replacing the value with an explicit example-domain/dummy value; fixture exceptions are reviewed rather than silently allowlisted.

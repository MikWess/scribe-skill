# PR 7 blind-test report

Six established profiles independently reviewed the desktop home and workspace redesign in two passes. The first pass found four expectation and navigation failures. The UI was revised, rebuilt, and tested again. All six profiles returned **SHIP** on the second pass.

| Profile | Final verdict | What passed after revision |
| --- | --- | --- |
| Maya — reader with accessibility needs | Ship | Plain value proposition, visible no-key path, and focused Inspect/Listen/Produce workspaces |
| Leo — desktop audiobook producer | Ship | Scan-only PDFs are detected and explicitly held for OCR instead of being described as immediately narratable |
| Forge — autonomous Codex agent | Ship | Current local document/audiobook APIs are separated from roadmap skill export, and Produce links directly to provider-key setup |
| Cipher — offline/BYOK enterprise agent | Ship | Provider boundaries and present-versus-roadmap agent capabilities are stated without implying hidden egress or model support |
| Priya — provenance researcher | Ship | Original source, repaired reading copy, cited notes, and audiobook requirements remain distinct and inspectable |
| Sam — adjacent-product evaluator | Ship | The home screen communicates differentiation without claiming the future knowledge graph or portable skill is already shipped |

## Iteration record

The first pass blocked on four issues:

1. Image-only PDFs were described as listenable even though the current workspace correctly marks them `ocr-required`.
2. Knowledge-graph and cited-skill export were presented as available instead of roadmap work.
3. Produce named a provider key requirement but did not route the user to key setup.
4. The new tabs lacked the complete ARIA tab/panel relationships and expected arrow-key behavior.

The second pass verified explicit OCR disclosure, honest roadmap labeling, a direct Produce-to-Listen setup route, and keyboard-accessible tabs with roving focus plus ArrowLeft, ArrowRight, Home, and End support.

## Verification

- Live Electron dogfood at 1152×768: Home, Inspect, Listen, Produce, local-path import, setup routing, and keyboard tab navigation passed.
- `pnpm check`: all typechecks passed, 54 tests passed, 2 fixtures passed the secret/PII scan, and the production reader build completed.

## Is this genuinely useful?

Yes, within this PR's boundary. A first-time user can now tell what ScribeSkill does, start locally without a key, understand the role of each workspace, find provider setup before production, and distinguish current capabilities from the book-to-skill roadmap. The redesign does not claim OCR, knowledge-graph generation, grounded Q&A, or portable skill export are already available.

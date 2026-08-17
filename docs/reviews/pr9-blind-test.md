# PR #9 blind test: local cited retrieval

- Date: 2026-08-17
- Branch: `codex/local-cited-retrieval`
- Base: `codex/semantic-chapter-passages`
- Final verdict: **SHIP — six of six profiles**

## What was tested

- Provider-free SQLite FTS5 retrieval over immutable current source passages.
- Accepted-chapter default scope, explicit proposed-boundary opt-in, and excluded/stale evidence removal.
- Required corpus revision plus optional document-hash and extraction-revision pins.
- Deterministic ranking, chapter/page/quality/review/visual filters, whole-passage context budgets, and truthful no-match/budget-exhausted outcomes.
- Full evidence-anchor return, preferred matching anchor selection, source-versus-reading-copy inspection, and exact PDF page/block highlighting.
- Prompt-injection-shaped source text as inert untrusted data, parameterized bounded queries, source tamper rejection, and zero search egress.
- Keyboard workspace navigation, result focus, accessible labels, and provenance language in the desktop browser UI.

The user's 200-page *Good Strategy/Bad Strategy* PDF was found under its content-addressed filename in the desktop library and tested in an isolated workspace. No copyrighted source text or PDF asset is committed to the repository.

## Round one

| Profile | Lens | Verdict | Finding |
| --- | --- | --- | --- |
| Maya | Accessibility-first reader | Ship | Search, filters, result focus, states, source inspection, and anchor buttons are keyboard-native and labelled. |
| Cipher | Security and privacy agent | Ship | Source verification, revision pins, bounded literal FTS, current-only evidence, and offline/injection tests fail closed. |
| Leo | Research power user | Ship | The UI completes the useful find → inspect → exact source loop and refuses honestly when evidence is absent or over budget. |
| Sam | Local API integrator | Ship | The exported contract, example request, deterministic response, incremental index, and 409 drift behavior are sufficient for agent use. |
| Forge | Autonomous skill-building agent | Ship | Whole passages, exact anchors, hashes, revisions, review states, and budgets provide bounded context without a provider or key. |
| Priya | Book-club reader/researcher | Block | A result badge said “source evidence” directly above a blockquote that was actually a derived navigation snippet. |

## Iteration

Priya's finding was valid even though the page introduction and API schema already disclosed snippet provenance. Per-result language must stand on its own. The result now says **DERIVED SNIPPET FROM SOURCE** and **FULL SOURCE BELOW**, gives the blockquote an explicit derived-snippet accessible label, and tells the reader to open immutable source before quoting.

Priya re-tested the change and returned **SHIP**. All six profiles therefore pass the final gate.

## Real-book follow-up

The first private run returned matches for all 20 queries but failed the usefulness gate: contents and index passages outranked body evidence, chapter words above “ten” were not recognized, lowercase prose references beginning with “chapter” became false boundaries, and note subheadings fragmented the back matter.

The root causes were fixed rather than hidden in the evaluation. Plain undotted multi-page contents are now bounded by a repeated, larger body heading; word-numbered headings cover chapters eleven through eighteen; sentence-like lowercase references are rejected; Notes/Endnotes/Bibliography/References/Acknowledgments/Index remain terminal containers; and retrieval deterministically prefers body sections before contents, notes, and index navigation. A redistribution-safe seven-page regression reproduces all four failure modes.

The final isolated run produced 590 passages and a usable introduction, three parts, and eighteen-chapter body map. All 20 queries returned a passage in their hand-specified body-page range within the top five; 16 were rank one and the remaining four were rank two. Import took about 1.0 second and the 20 searches averaged 274 ms on the local machine.

All six profiles re-tested the real-book iteration. One profile caught a remaining punctuation-less lowercase `chapter eleven …` prose line that could become a false boundary; the detector now requires corroborating heading form, the exact case is covered by the synthetic regression, and all six returned **SHIP**.

## Is this genuinely useful?

**Yes for evidence acquisition.** A reader can type an idea, see which reviewed chapter contains it, understand what is source versus navigation metadata, and open the strongest matching sentence on the rendered page in one action. An agent can request a bounded set of whole, revision-pinned passages with complete citations and no API key, then refuse rather than invent context when nothing matches.

This PR deliberately does not generate answers or claim semantic recall. Bounded AI execution and grounded saved insights belong to the next slice.

## Verification

- `pnpm check`: type checks, 70 tests, fixture secret/PII scan, and production reader build.
- Frozen retrieval evaluation: 20 of 20 synthetic strategy queries returned the expected chapter in the top five; each preferred evidence anchor resolved to the expected page.
- Private real-book evaluation: 20 of 20 queries returned evidence from the expected body-page range in the top five, with no private source content committed.
- Offline/injection test: zero `fetch` calls; operator-shaped query text and hostile book instructions remained inert; reading-copy-only terms were not indexed.
- Browser journey: imported the strategy fixture, accepted a chapter, searched `underlying problem`, opened page 3 with the exact sentence highlighted, exercised keyboard tab navigation, and verified the honest no-match state.
- Browser diagnostics: no console errors; requests were limited to the loopback UI/service and local blob assets.
- `git diff --check`: clean.

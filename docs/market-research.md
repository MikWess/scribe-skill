# ScribeSkill — Market Research and Product Decisions

Research completed 2026-08-12. This document synthesizes **70+ distinct web sources**, including direct community feedback, product documentation, accessibility research, standards, and primary agent-platform sources. The source catalog deliberately separates user-reported experience from vendor claims.

## Executive conclusion

The product should be **ScribeSkill: turn permitted PDFs into inspectable, cited skills for people and agents.** Audiobook creation is a powerful review and accessibility surface, but it is not the primary differentiation. Existing work already converts books into agent skills; ScribeSkill wins only if it makes the conversion trustworthy and controllable: source-span provenance, local durable workspaces, visual review, progressive narration/rendering, and a standards-friendly local agent interface.

### What people consistently want

- Choose a passage or chapter and listen immediately; do not pay or wait to process a whole book.
- Exact, user-controlled read-along: durable resume, skip controls, editable reading order, highlight granularity, and clear extraction/alignment quality.
- Grounded answers that open the actual page and highlighted passage. Generic PDF chat and generated audio are now table stakes but frequently distrusted.
- Local/offline ownership with portable notes/annotations, no intrusive AI, no forced cloud library, and transparent provider spend.
- A useful “skill” is structure—not a giant summary: chapter/topic routing, concepts, decision rules, cited evidence, and outputs an agent can load on demand.

### What agents need

- Stable IDs from `document → page → block → character span → chunk`; retain them through OCR, parsing, retrieval, alignment, graph extraction, and export.
- Loopback-only MCP plus CLI/API, explicit capabilities, cancellation, idempotent jobs, inspectable artifacts, and permissions/consent.
- Retrieval before knowledge graph. Graph building is optional progressive enrichment, with evidence on every node and edge.
- Codex SDK as a first-party **test and autonomous compiler adapter**, never a dependency on a separate end-user key. Human BYOK and provider-neutral adapters remain first-class.

## Decisions adopted

| Decision | Why |
| --- | --- |
| Desktop-first, optional browser read-along/note UI | Secure storage, local files/audio, offline control, and user feedback about cloud/browser lock-in. |
| Name: `ScribeSkill` | Directly communicates the core outcome; `SkillScribe`, `AgentScribe`, and `ScribeAgent` are already used by unrelated products. |
| Two distinct audio modes | **Faithful Read Aloud** reads source text; **Generated Overview** is explicitly a fallible derivative with inspectable citations and editable script. |
| Provenance ledger as core data model | A graph, answer, audio highlight, and export must always trace back to page/block/span evidence. |
| Progressive queue | Parse and narrate selected sections first; full audiobook/MP4 is an explicit, cancellable batch job with cost estimate. |
| Retrieval-first graph | Deliver cited search and a portable skill before graph enrichment; create the graph incrementally and expose its evidence/confidence. |
| MCP and CLI alongside UI | Agents should use the same local workspace and provenance model as people, not a separate hidden pipeline. |
| Codex SDK in tests/adapter | Enables autonomous test scenarios where a local Codex environment is present; production still supports BYOK and other agent hosts. |

## Evidence-backed requirements

1. **Source-quality gate.** Detect text layer/OCR quality, headers/footers, reading order and table/figure complexity; give users block-level include/exclude/reorder before faithful narration or skill extraction.
2. **Citation inspector.** Citation click opens page preview, highlighted exact span, quote, extraction run/model, and confidence. Unsupported claims are visibly unsupported.
3. **Audio capability matrix.** Each provider declares exact/estimated/no timing, streaming, limits, cost metadata, cancellation and custom-voice ability. Never imply uniform word sync.
4. **Accessible reader.** Sentence highlight is default; word/off modes, speed, contrast, font, focus mask/ruler, keyboard navigation, bookmarks, and persistent resume are all user settings.
5. **Portable workspace.** SQLite plus a content-addressed asset directory; export Markdown, JSON/JSON-LD and audio manifest. Secrets stay in platform keychain only.
6. **Skill artifact.** `SKILL.md`, manifest with rights/source hash, cited chunks, chapter/topic guides, concepts and relationships, retrieval database, and generated evaluation questions.
7. **Human review points.** Require review before externally shareable audio/video export and allow review/acceptance status for graph statements. No auto-generated audio on import.

## Source catalog

### Direct user feedback and reviews

1. [Sentence highlighting and weak annotations](https://www.reddit.com/r/TextToSpeech/comments/1itkgg1)
2. [ADHD reader: choppy voices and bad PDF parsing](https://www.reddit.com/r/ADHD/comments/1u6xur1)
3. [ADHD reader: manual section selection](https://www.reddit.com/r/ADHD/comments/12qzww0)
4. [ADHD reader: durable resume/back controls](https://www.reddit.com/r/ADHD/comments/vqvgjg)
5. [ADHD reader: headers, footers, skipped text](https://www.reddit.com/r/ADHD/comments/1ierzti)
6. [ADHD reader: selection-first listening](https://www.reddit.com/r/ADHD/comments/1e4swvi)
7. [Zotero user: split view](https://www.reddit.com/r/zotero/comments/10wmqor)
8. [Zotero user: portable notes/highlights](https://www.reddit.com/r/zotero/comments/1asqkvw)
9. [Zotero user: dictionary need](https://www.reddit.com/r/zotero/comments/ti6y8z)
10. [Zotero user: reading ruler](https://www.reddit.com/r/zotero/comments/1oo1pxc)
11. [Full-page/focus-mask reader feedback](https://www.reddit.com/r/SideProject/comments/1q9hufe)
12. [TTS as educational accommodation](https://www.reddit.com/r/ADHD/comments/pv16hv)
13. [NotebookLM audio feedback: useful but hallucinates](https://www.reddit.com/r/notebooklm/comments/1g9j9er)
14. [NotebookLM audio auto-generation/cancellation feedback](https://www.reddit.com/r/notebooklm/comments/1rp5lfu/frustrations_with_notebooklms_automatic_audio/)
15. [NotebookLM length-control feedback](https://www.reddit.com/r/notebooklm/comments/1q8ikix/audio_overviews_length_problem/)
16. [NotebookLM G2 reviews](https://www.g2.com/products/google-notebooklm/reviews)
17. [Readwise local/offline PDF feedback](https://www.reddit.com/r/pdf/comments/1sytij0/looking_for_a_free_readwise_reader_style_pdf/)
18. [Readwise annotation feedback](https://www.reddit.com/r/readwise/comments/1r75vtt/concern_about_readwise_and_reader_becoming/)
19. [Adobe AI failure report](https://community.adobe.com/questions-9/bugs-in-adobe-acrobat-ai-assistant-1304876)
20. [Adobe scanned-PDF failure report](https://community.adobe.com/questions-9/ai-assistant-does-not-work-on-scanned-pdfs-1293151)
21. [Adobe intrusive AI UI feedback](https://community.adobe.com/questions-9/stop-with-the-ai-user-prompts-in-acrobat-it-s-getting-ridiculous-1300293)
22. [LiquidText export concern](https://www.reddit.com/r/LiquidText/comments/q3rsby)
23. [LiquidText workspace critique](https://www.reddit.com/r/LiquidText/comments/zaqo6r)
24. [Citation-centric local RAG feedback](https://www.reddit.com/r/LocalLLaMA/comments/1db98el)
25. [Inline-citation implementation feedback](https://www.reddit.com/r/LocalLLaMA/comments/1h6yu0u)
26. [Local document RAG architecture feedback](https://www.reddit.com/r/LocalLLaMA/comments/1uar970/help_with_a_local_document-rag-system-storage/)
27. [PDF hallucination feedback](https://www.reddit.com/r/ChatGPT/comments/1kj2gru)
28. [Researcher feedback on hallucinations](https://www.reddit.com/r/ChatGPT/comments/1m7oje7/i_love_chatgpt_but_the_hallucinations_have_gotten/)
29. [Scanned-PDF workflow feedback](https://www.reddit.com/r/ChatGPT/comments/1lbzxgs)
30. [Readwise Reader launch discussion](https://news.ycombinator.com/item?id=34006202)
31. [Synchronized audiobook product discussion](https://news.ycombinator.com/item?id=46854922)

### Reader, accessibility, and research evidence

32. [Text-to-speech and visible highlighting](https://www.understood.org/en/articles/text-to-speech-technology-what-it-is-and-how-it-works)
33. [Reading assistive technology](https://www.understood.org/en/articles/assistive-technology-reading-challenges)
34. [Assistive reading tools](https://www.understood.org/en/articles/assistive-technology-for-reading)
35. [Bookshare partner tool capabilities](https://www.bookshare.org/partner-tools)
36. [Bookshare reading intervention guidance](https://www.bookshare.org/campaigns/reading-intervention-for-dyslexic-students)
37. [Read-aloud/TTS meta-analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC5494021/)
38. [Synchronized highlighting and aphasia study](https://pmc.ncbi.nlm.nih.gov/articles/PMC7959096/)
39. [Highlighting/rate study](https://pmc.ncbi.nlm.nih.gov/articles/PMC9135027/)
40. [WCAG 3 draft](https://www.w3.org/TR/wcag-3.0/)
41. [W3C media descriptions guidance](https://www.w3.org/WAI/media/av/description/)
42. [ChatDOC structure-aware PDF parsing research](https://arxiv.org/abs/2401.12599)

### Product and provider documentation

43. [NotebookLM Audio Overviews announcement](https://blog.google/innovation-and-ai/products/notebooklm-audio-overviews/)
44. [NotebookLM background Q&A help](https://support.google.com/notebooklm/answer/16212820?hl=en-GB)
45. [NotebookLM independent review](https://www.techradar.com/pro/notebooklm-review)
46. [Readwise PDF documentation](https://docs.readwise.io/reader/docs/faqs/pdfs)
47. [Readwise Reader documentation](https://docs.readwise.io/reader)
48. [Adobe Acrobat AI document Q&A](https://helpx.adobe.com/acrobat/mobile/acrobat-ai/ask-questions.html)
49. [LiquidText features](https://www.liquidtext.net/features)
50. [LiquidText product overview](https://www.liquidtext.net/)
51. [PDF Expert Copilot](https://pdfexpert.com/pdf-copilot)
52. [NaturalReader help](https://help.naturalreaders.com/en/)
53. [NaturalReader voice limits](https://help.naturalreaders.com/en/articles/8977584-voices-languages-and-tts-limits-commercial-version)
54. [OpenAI audio API](https://platform.openai.com/docs/api-reference/audio/voice-consent-list?lang=curl)
55. [ElevenLabs timestamped TTS stream](https://elevenlabs.io/docs/api-reference/text-to-speech/stream-with-timestamps)
56. [ElevenLabs real-time TTS alignment](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts)
57. [ElevenLabs streaming](https://elevenlabs.io/docs/api-reference/streaming)

### Agent, graph, privacy, and local-workspace sources

58. [OpenAI data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
59. [Codex TypeScript SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
60. [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/)
61. [OpenAI Agents tools/MCP](https://openai.github.io/openai-agents-js/guides/tools/)
62. [OpenAI Agents custom model providers](https://openai.github.io/openai-agents-js/guides/models/)
63. [OpenAI Agents tracing/privacy](https://openai.github.io/openai-agents-js/guides/tracing/)
64. [MCP specification](https://modelcontextprotocol.io/specification/2025-06-18/index)
65. [MCP tools contract](https://modelcontextprotocol.io/specification/draft/server/tools)
66. [SQLite application file guidance](https://sqlite.org/appfileformat.html)
67. [SQLite application-file benefits](https://sqlite.org/aff_short.html)
68. [Microsoft GraphRAG local search](https://microsoft.github.io/graphrag/query/local_search/)
69. [Microsoft GraphRAG query modes](https://microsoft.github.io/graphrag/query/overview/)
70. [Microsoft GraphRAG getting started](https://microsoft.github.io/graphrag/get_started/)
71. [Neo4j unstructured-data graph pipeline](https://neo4j.com/developer/genai-ecosystem/importing-graph-from-unstructured-data/)
72. [Neo4j GraphRAG package](https://neo4j.com/developer/genai-ecosystem/graphrag-python/)

### Closest category signal

73. [book-to-skill project guide](https://booktoskill.is-a.dev/guide/) — validates structured, on-demand source use; it also reinforces that ScribeSkill must differentiate through inspectability, provenance, multimodal review, and local agent operations rather than duplicate simple conversion.

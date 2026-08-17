import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { NarrationPanel } from "./NarrationPanel.js";
import { AudiobookPanel } from "./AudiobookPanel.js";
import { HomeScreen } from "./HomeScreen.js";

declare global {
  interface Window {
    scribeRuntime?: {
      api?: string;
      token?: string;
      providerKeyStatus?: () => Promise<{ secureStorage: boolean; openai: boolean; elevenlabs: boolean }>;
      setProviderKey?: (provider: "openai" | "elevenlabs", key: string) => Promise<{ saved: boolean }>;
      deleteProviderKey?: (provider: "openai" | "elevenlabs") => Promise<{ deleted: boolean }>;
    };
  }
}

const API = window.scribeRuntime?.api ?? import.meta.env.VITE_SCRIBE_SKILL_API ?? "http://127.0.0.1:4317";
const TOKEN = window.scribeRuntime?.token ?? import.meta.env.VITE_SCRIBE_SKILL_TOKEN ?? "local-development-only";
const LAST_DOCUMENT_KEY = "scribe-skill:last-document";
type WorkspaceView = "inspect" | "listen" | "produce";
const WORKSPACE_VIEWS: WorkspaceView[] = ["inspect", "listen", "produce"];

interface DocumentRecord {
  id: string;
  originalName: string;
  documentHash: string;
  pageCount: number;
  corpusRevision: number;
}

interface Section {
  id: string;
  documentId: string;
  parentId?: string;
  title: string;
  kind: "chapter" | "section";
  level: number;
  startPage: number;
  endPage: number;
  order: number;
  confidence: number;
  origin: "detected" | "user";
  status: "proposed" | "accepted" | "excluded";
  rationale: string;
  structureRevision: number;
}

interface Passage {
  id: string;
  sectionId: string;
  sequence: number;
  sourceText: string;
  readingText: string;
  startPage: number;
  endPage: number;
  characterCount: number;
  contentHash: string;
  extractionRevision: number;
  structureRevision: number;
  quality: "good" | "review-needed" | "ocr-required";
  evidence: Array<{
    id: string;
    page: number;
    blockId: string;
    characterRange: { start: number; end: number };
    contentHash: string;
  }>;
}

interface CorpusSummary {
  structureRevision: number;
  sectionCount: number;
  passageCount: number;
  tocEntryCount: number;
  proposedSectionCount: number;
  acceptedSectionCount: number;
  excludedSectionCount: number;
  reviewRequiredPages: number[];
  ocrRequiredPages: number[];
  ready: boolean;
  blockers: string[];
}

interface Block {
  id: string;
  pageNumber: number;
  sourceText: string;
  currentText: string;
  currentOrder: number;
  status: "included" | "excluded" | "rejected";
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

interface Inspection {
  page: { pageNumber: number; quality: "good" | "review-needed" | "ocr-required"; confidence: number };
  blocks: Block[];
  renderUrl: string;
  renderHash: string;
}

interface Annotation {
  id: number;
  blockId: string;
  content: string;
  kind: "note" | "highlight";
  authorship: "user" | "source" | "model";
}

interface ImportResult {
  document: DocumentRecord;
  sections: Section[];
  summary: CorpusSummary;
}

interface PassagePage {
  items: Passage[];
  nextOffset?: number;
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-scribe-token": TOKEN, ...init?.headers },
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({ error: response.statusText }))) as { error: string };
    throw new ApiError(response.status, failure.error);
  }
  return (await response.json()) as T;
}

function qualityLabel(quality: Inspection["page"]["quality"]): string {
  if (quality === "ocr-required") return "OCR required";
  if (quality === "review-needed") return "Reading order review";
  return "Source ready";
}

export function App() {
  const [pdfPath, setPdfPath] = useState("");
  const [document, setDocument] = useState<DocumentRecord>();
  const [sections, setSections] = useState<Section[]>([]);
  const [passages, setPassages] = useState<Passage[]>([]);
  const [corpusSummary, setCorpusSummary] = useState<CorpusSummary>();
  const [selectedSectionId, setSelectedSectionId] = useState<string>();
  const [pageNumber, setPageNumber] = useState(1);
  const [inspection, setInspection] = useState<Inspection>();
  const [renderSource, setRenderSource] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("Local service ready");
  const [busy, setBusy] = useState(false);
  const [playback, setPlayback] = useState<"idle" | "playing" | "paused">("idle");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("inspect");
  const [splitPage, setSplitPage] = useState(2);
  const utteranceRef = useRef<SpeechSynthesisUtterance | undefined>(undefined);

  const selected = useMemo(
    () => inspection?.blocks.find(({ id }) => id === selectedId),
    [inspection, selectedId],
  );
  const selectedSection = sections.find(({ id }) => id === selectedSectionId);
  const activeSection = selectedSection && pageNumber >= selectedSection.startPage && pageNumber <= selectedSection.endPage
    ? selectedSection
    : sections.find(({ startPage }) => startPage === pageNumber) ??
      sections.find(({ startPage, endPage }) => pageNumber >= startPage && pageNumber <= endPage);
  const activeNarrationSection = activeSection?.status === "excluded" ? undefined : activeSection;
  const activeProductionSection = activeSection?.status === "accepted" ? activeSection : undefined;
  const activeSectionIndex = activeSection ? sections.findIndex(({ id }) => id === activeSection.id) : -1;
  const nextSection = activeSectionIndex >= 0 ? sections.slice(activeSectionIndex + 1).find(({ status }) => status !== "excluded") : undefined;
  const activePassages = activeSection ? passages.filter(({ sectionId }) => sectionId === activeSection.id) : [];

  const loadPage = useCallback(
    async (documentId: string, page: number, preferredBlock?: string) => {
      setBusy(true);
      try {
        const next = await request<Inspection>(`/api/documents/${documentId}/pages/${page}`);
        const imageResponse = await fetch(`${API}${next.renderUrl}`, { headers: { "x-scribe-token": TOKEN } });
        const imageBlob = await imageResponse.blob();
        const imageUrl = URL.createObjectURL(imageBlob);
        setRenderSource((current) => {
          if (current) URL.revokeObjectURL(current);
          return imageUrl;
        });
        setInspection(next);
        setPageNumber(page);
        setSelectedId(preferredBlock ?? next.blocks.find(({ status }) => status === "included")?.id);
        setMessage(qualityLabel(next.page.quality));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  async function openImported(result: ImportResult) {
      window.localStorage.setItem(LAST_DOCUMENT_KEY, result.document.id);
      setDocument(result.document);
      setSections(result.sections);
      setSelectedSectionId(result.sections.find(({ status }) => status !== "excluded")?.id ?? result.sections[0]?.id);
      setPassages([]);
      setCorpusSummary(result.summary);
      const [progress, notes] = await Promise.all([
        request<{ pageNumber: number; blockId?: string } | null>(`/api/documents/${result.document.id}/progress`),
        request<Annotation[]>(`/api/documents/${result.document.id}/annotations`),
      ]);
      setAnnotations(notes);
      await loadPage(result.document.id, progress?.pageNumber ?? 1, progress?.blockId);
  }

  async function refreshCorpus(documentId: string) {
    const corpus = await request<Omit<ImportResult, "document">>(`/api/documents/${documentId}/corpus`);
    setSections(corpus.sections);
    if (!corpus.sections.some(({ id }) => id === selectedSectionId)) {
      setSelectedSectionId(corpus.sections.find(({ status }) => status !== "excluded")?.id ?? corpus.sections[0]?.id);
    }
    setPassages([]);
    setCorpusSummary(corpus.summary);
  }

  async function reportMutationError(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.status === 409 && document) {
      await refreshCorpus(document.id);
      setMessage(`${error.message}. Refreshed the latest corpus; review and try again.`);
      return;
    }
    setMessage(error instanceof Error ? error.message : fallback);
  }

  useEffect(() => {
    const lastDocumentId = window.localStorage.getItem(LAST_DOCUMENT_KEY);
    if (!lastDocumentId) return;
    setBusy(true);
    void request<ImportResult>(`/api/documents/${lastDocumentId}`)
      .then(openImported)
      .catch(() => window.localStorage.removeItem(LAST_DOCUMENT_KEY))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    if (!document || !activeSection) {
      setPassages([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      const loaded: Passage[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const passagePage: PassagePage = await request<PassagePage>(
          `/api/documents/${document.id}/passages?sectionId=${encodeURIComponent(activeSection.id)}&limit=200&offset=${offset}`,
        );
        loaded.push(...passagePage.items);
        offset = passagePage.nextOffset;
      }
      if (!cancelled) setPassages(loaded);
    };
    setPassages([]);
    void load().catch((error) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : "Passages could not be loaded");
    });
    return () => { cancelled = true; };
  }, [document?.id, activeSection?.id, corpusSummary?.structureRevision]);

  async function importPdf() {
    if (!pdfPath.trim()) return;
    setBusy(true);
    try {
      const result = await request<ImportResult>("/api/import", {
        method: "POST",
        body: JSON.stringify({ path: pdfPath.trim() }),
      });
      await openImported(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    try {
      const response = await fetch(`${API}/api/import-file?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "content-type": "application/pdf", "x-scribe-token": TOKEN },
        body: file,
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({ error: response.statusText }))) as { error: string };
        throw new Error(failure.error);
      }
      await openImported((await response.json()) as ImportResult);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!document || !selected) return;
    void request(`/api/documents/${document.id}/progress`, {
      method: "PUT",
      body: JSON.stringify({ pageNumber, blockId: selected.id }),
    });
  }, [document, pageNumber, selected]);

  useEffect(() => {
    if (!activeSection) return;
    setSplitPage(Math.min(activeSection.endPage, activeSection.startPage + 1));
  }, [activeSection?.id, activeSection?.startPage, activeSection?.endPage]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !("speechSynthesis" in window)) return;
    navigator.mediaSession.setActionHandler("play", () => {
      window.speechSynthesis.resume();
      setPlayback("playing");
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      window.speechSynthesis.pause();
      setPlayback("paused");
    });
    navigator.mediaSession.setActionHandler("stop", () => {
      window.speechSynthesis.cancel();
      setPlayback("idle");
    });
    return () => {
      for (const action of ["play", "pause", "stop"] as MediaSessionAction[]) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, []);

  function speakSelection() {
    if (!selected) return;
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setMessage("This browser does not provide a device voice");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(selected.currentText);
    utteranceRef.current = utterance;
    utterance.rate = 1;
    utterance.onstart = () => setPlayback("playing");
    utterance.onend = () => setPlayback("idle");
    utterance.onerror = () => setPlayback("idle");
    if ("mediaSession" in navigator && "MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: selected.currentText.slice(0, 80),
        artist: document?.originalName ?? "ScribeSkill",
        album: `Page ${selected.pageNumber}`,
      });
    }
    window.speechSynthesis.speak(utterance);
  }

  function pauseOrResume() {
    if (playback === "playing") {
      window.speechSynthesis.pause();
      setPlayback("paused");
    } else if (playback === "paused") {
      window.speechSynthesis.resume();
      setPlayback("playing");
    }
  }

  function stopPlayback() {
    window.speechSynthesis.cancel();
    utteranceRef.current = undefined;
    setPlayback("idle");
  }

  async function updateBlock(patch: Partial<Pick<Block, "currentText" | "currentOrder" | "status">>) {
    if (!selected || !document) return;
    try {
      const updated = await request<Block>(`/api/blocks/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          text: patch.currentText,
          order: patch.currentOrder,
          status: patch.status,
          note: "Reader repair",
          expectedCorpusRevision: corpusSummary?.structureRevision ?? document.corpusRevision,
        }),
      });
      setInspection((current) =>
        current
          ? {
              ...current,
              blocks: current.blocks
                .map((block) => (block.id === updated.id ? updated : block))
                .sort((left, right) => left.currentOrder - right.currentOrder),
            }
          : current,
      );
      await refreshCorpus(document.id);
      setMessage("Repair saved locally");
    } catch (error) {
      await reportMutationError(error, "Repair failed");
    }
  }

  async function reorderSelected(direction: -1 | 1) {
    if (!selected || !document) return;
    try {
      const blocks = await request<Block[]>(`/api/blocks/${selected.id}/reorder`, {
        method: "POST",
        body: JSON.stringify({ direction, expectedCorpusRevision: corpusSummary?.structureRevision ?? document.corpusRevision }),
      });
      setInspection((current) => current ? { ...current, blocks } : current);
      await refreshCorpus(document.id);
      setMessage(direction < 0 ? "Moved earlier in reading order" : "Moved later in reading order");
    } catch (error) {
      await reportMutationError(error, "Reading order update failed");
    }
  }

  async function updateSection(patch: Partial<Section>) {
    if (!activeSection || !document) return;
    try {
      const updated = await request<Section>(`/api/sections/${activeSection.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...patch, expectedCorpusRevision: corpusSummary?.structureRevision ?? document.corpusRevision }),
      });
      setSections((current) => current.map((section) => (section.id === updated.id ? updated : section)));
      await refreshCorpus(document.id);
      setMessage("Section guide updated");
    } catch (error) {
      await reportMutationError(error, "Section update failed");
    }
  }

  async function splitActiveSection() {
    if (!activeSection || !document) return;
    try {
      const next = await request<Section[]>(`/api/sections/${activeSection.id}/split`, {
        method: "POST",
        body: JSON.stringify({
          atPage: splitPage,
          title: `${activeSection.title} — continued`,
          expectedCorpusRevision: corpusSummary?.structureRevision ?? document.corpusRevision,
        }),
      });
      setSections(next);
      await refreshCorpus(document.id);
      setMessage(`Split ${activeSection.title} at page ${splitPage}`);
    } catch (error) {
      await reportMutationError(error, "Section split failed");
    }
  }

  async function mergeActiveWithNext() {
    if (!activeSection || !nextSection || !document) return;
    try {
      const next = await request<Section[]>(`/api/sections/${activeSection.id}/merge`, {
        method: "POST",
        body: JSON.stringify({
          targetSectionId: nextSection.id,
          expectedCorpusRevision: corpusSummary?.structureRevision ?? document.corpusRevision,
        }),
      });
      setSections(next);
      await refreshCorpus(document.id);
      setMessage(`Merged ${activeSection.title} with the next section`);
    } catch (error) {
      await reportMutationError(error, "Section merge failed");
    }
  }

  async function reorderActiveSection(direction: -1 | 1) {
    if (!activeSection || !document) return;
    try {
      const next = await request<Section[]>(`/api/sections/${activeSection.id}/reorder`, {
        method: "POST",
        body: JSON.stringify({ direction, expectedCorpusRevision: corpusSummary?.structureRevision ?? document.corpusRevision }),
      });
      setSections(next);
      await refreshCorpus(document.id);
      setMessage(direction < 0 ? "Moved chapter earlier" : "Moved chapter later");
    } catch (error) {
      await reportMutationError(error, "Section reorder failed");
    }
  }

  async function saveNote() {
    if (!document || !selected || !note.trim()) return;
    try {
      const saved = await request<Annotation>(`/api/documents/${document.id}/annotations`, {
        method: "POST",
        body: JSON.stringify({ blockId: selected.id, kind: "note", authorship: "user", content: note }),
      });
      setAnnotations((current) => [...current, saved]);
      setNote("");
      setMessage("Cited note saved");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Note could not be saved");
    }
  }

  async function exportNotes() {
    if (!document) return;
    for (const [suffix, extension] of [["annotations.md", "notes.md"], ["annotations.evidence.json", "evidence.json"]]) {
      const response = await fetch(`${API}/api/documents/${document.id}/${suffix}`, {
        headers: { "x-scribe-token": TOKEN },
      });
      const url = URL.createObjectURL(await response.blob());
      const link = window.document.createElement("a");
      link.href = url;
      link.download = `${document.originalName}-${extension}`;
      window.document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
  }

  async function fetchAudioArtifact(jobId: string): Promise<string> {
    const response = await fetch(`${API}/api/audio/jobs/${jobId}/artifact`, { headers: { "x-scribe-token": TOKEN } });
    if (!response.ok) throw new Error("Audio artifact is not ready");
    return URL.createObjectURL(await response.blob());
  }

  function goHome() {
    stopPlayback();
    window.localStorage.removeItem(LAST_DOCUMENT_KEY);
    setDocument(undefined);
    setSections([]);
    setSelectedSectionId(undefined);
    setPassages([]);
    setCorpusSummary(undefined);
    setWorkspaceView("inspect");
    setMessage("Local service ready");
  }

  function handleWorkspaceTabKey(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % WORKSPACE_VIEWS.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + WORKSPACE_VIEWS.length) % WORKSPACE_VIEWS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = WORKSPACE_VIEWS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextView = WORKSPACE_VIEWS[nextIndex];
    setWorkspaceView(nextView);
    window.requestAnimationFrame(() => window.document.getElementById(`workspace-tab-${nextView}`)?.focus());
  }

  if (!document) {
    return (
      <HomeScreen
        busy={busy}
        message={message}
        pdfPath={pdfPath}
        onChooseFile={(file) => void importFile(file)}
        onOpenPath={() => void importPdf()}
        onPathChange={setPdfPath}
      />
    );
  }

  return (
    <main className="reader-shell">
      <header className="topbar">
        <button className="brand" onClick={goHome} aria-label="Return to ScribeSkill home">
          <div className="wordmark"><span aria-hidden="true">S/S</span> ScribeSkill</div>
          <div className="document-title">{document.originalName}</div>
        </button>
        <div className="source-status" data-quality={inspection?.page.quality} role="status" aria-live="polite" aria-atomic="true">
          <span aria-hidden="true">●</span> {message}
        </div>
        <div className="top-actions">
          <button onClick={() => void exportNotes()}>Export notes</button>
          <button onClick={goHome}>Home</button>
        </div>
      </header>

      <div className="reader-grid">
        <nav className="section-rail" aria-label="Book sections">
          <div className="rail-intro">
            <div className="rail-label">BOOK MAP · REV {corpusSummary?.structureRevision ?? 1}</div>
            <p>Detected chapters are proposals. Review them here; passages keep exact source evidence for later search, graph, and skill work.</p>
            <div className="corpus-meter" data-ready={corpusSummary?.ready ?? false}>
              <strong>{corpusSummary?.sectionCount ?? sections.length} sections</strong>
              <span>{corpusSummary?.passageCount ?? passages.length} cited passages</span>
              {!!corpusSummary?.tocEntryCount && <span>{corpusSummary.tocEntryCount} TOC entries found</span>}
              {!!corpusSummary?.ocrRequiredPages.length && <span>{corpusSummary.ocrRequiredPages.length} OCR blockers</span>}
              {!!corpusSummary?.reviewRequiredPages.length && <span>{corpusSummary.reviewRequiredPages.length} pages need review</span>}
            </div>
          </div>
          {sections.map((section) => (
            <button
              key={section.id}
              className={`${activeSection?.id === section.id ? "section active" : "section"} ${section.status}`}
              aria-current={activeSection?.id === section.id ? "location" : undefined}
              onClick={() => {
                setSelectedSectionId(section.id);
                void loadPage(document.id, section.startPage);
              }}
              style={{ paddingLeft: `${8 + Math.max(0, section.level - 1) * 12}px` }}
            >
              <span>{String(section.order + 1).padStart(2, "0")}</span>
              <strong>{section.title}</strong>
              <small>{section.kind} · pp. {section.startPage}–{section.endPage}</small>
              <small>{section.status} · {Math.round(section.confidence * 100)}% confidence</small>
            </button>
          ))}
          <div className="rail-footer">
            <span>{document.pageCount} pages</span>
            <span>{annotations.length} {annotations.length === 1 ? "note" : "notes"}</span>
          </div>
        </nav>

        <section className="page-stage" aria-label={`PDF page ${pageNumber}`} aria-busy={busy}>
          <div className="page-toolbar">
            <button
              disabled={pageNumber <= 1}
              onClick={() => void loadPage(document.id, pageNumber - 1)}
              aria-label="Previous page"
            >
              ←
            </button>
            <span>PAGE {pageNumber} / {document.pageCount}</span>
            <button
              disabled={pageNumber >= document.pageCount}
              onClick={() => void loadPage(document.id, pageNumber + 1)}
              aria-label="Next page"
            >
              →
            </button>
          </div>
          <div className="paper-wrap">
            {renderSource && <img className="paper" src={renderSource} alt={`Rendered source page ${pageNumber}`} />}
            <div className="evidence-overlay" aria-label="Selectable evidence regions">
              {inspection?.blocks.map((block) => (
                <button
                  key={block.id}
                  className={block.id === selectedId ? "evidence-box selected" : "evidence-box"}
                  style={{
                    left: `${block.boundingBox.x * 100}%`,
                    top: `${block.boundingBox.y * 100}%`,
                    width: `${block.boundingBox.width * 100}%`,
                    height: `${Math.max(block.boundingBox.height * 100, 1.4)}%`,
                  }}
                  onClick={() => setSelectedId(block.id)}
                  aria-pressed={block.id === selectedId}
                  aria-label={`Select source text (${block.status}): ${block.sourceText}`}
                />
              ))}
            </div>
          </div>
        </section>

        <aside className="inspector" aria-label="Evidence inspector">
          <div className="inspector-heading">
            <div><div className="rail-label">WORKSPACE</div><strong>{activeSection?.title ?? `Page ${pageNumber}`}</strong></div>
            <span>{inspection ? Math.round(inspection.page.confidence * 100) : 0}% extraction</span>
          </div>

          <div className="workspace-tabs" role="tablist" aria-label="Reading workflow">
            {([
              ["inspect", "01", "Inspect", "Select, repair, note"],
              ["listen", "02", "Listen", "Read along or cache"],
              ["produce", "03", "Produce", "Plan and export"],
            ] as const).map(([view, number, label, detail], index) => (
              <button
                key={view}
                id={`workspace-tab-${view}`}
                role="tab"
                aria-controls={`workspace-panel-${view}`}
                aria-selected={workspaceView === view}
                tabIndex={workspaceView === view ? 0 : -1}
                onClick={() => setWorkspaceView(view)}
                onKeyDown={(event) => handleWorkspaceTabKey(event, index)}
              ><span>{number}</span><strong>{label}</strong><small>{detail}</small></button>
            ))}
          </div>

          {workspaceView === "inspect" && <div id="workspace-panel-inspect" role="tabpanel" aria-labelledby="workspace-tab-inspect" className="workspace-panel">
            <div className="workspace-explainer"><span>NO KEY NEEDED</span><h2>Inspect the source.</h2><p>Choose a highlighted region on the page. Repair only the reading copy; every note still cites the immutable extraction.</p></div>
            {activeSection && <details className="section-editor">
              <summary>Review this {activeSection.kind} and its passages</summary>
              <div className="section-editor-body">
                <div className="section-proposal-meta">
                  <strong>{activeSection.origin === "detected" ? "DETECTED PROPOSAL" : "USER REVIEWED"}</strong>
                  <span>{Math.round(activeSection.confidence * 100)}% confidence · {activePassages.length} {activePassages.length === 1 ? "passage" : "passages"}</span>
                  <p>{activeSection.rationale}</p>
                </div>
                <label>Section title<input key={`${activeSection.id}-title-${activeSection.title}`} defaultValue={activeSection.title} onBlur={(event) => void updateSection({ title: event.target.value })} /></label>
                <label>Structure type<select value={activeSection.kind} onChange={(event) => void updateSection({ kind: event.target.value as Section["kind"], level: event.target.value === "chapter" ? 1 : 2 })}><option value="chapter">Chapter</option><option value="section">Section</option></select></label>
                <div className="range-fields">
                  <label>From page<input key={`${activeSection.id}-from-${activeSection.startPage}`} type="number" min="1" max={document.pageCount} defaultValue={activeSection.startPage} onBlur={(event) => void updateSection({ startPage: Number(event.target.value) })} /></label>
                  <label>To page<input key={`${activeSection.id}-to-${activeSection.endPage}`} type="number" min="1" max={document.pageCount} defaultValue={activeSection.endPage} onBlur={(event) => void updateSection({ endPage: Number(event.target.value) })} /></label>
                </div>
                <div className="section-review-actions">
                  <button className="accept" aria-pressed={activeSection.status === "accepted"} onClick={() => void updateSection({ status: "accepted" })}>Accept</button>
                  <button aria-pressed={activeSection.status === "proposed"} onClick={() => void updateSection({ status: "proposed" })}>Needs review</button>
                  <button className="exclude" aria-pressed={activeSection.status === "excluded"} onClick={() => void updateSection({ status: "excluded" })}>Exclude</button>
                </div>
                <div className="section-review-actions">
                  <button disabled={activeSectionIndex <= 0} onClick={() => void reorderActiveSection(-1)}>Move earlier</button>
                  <button disabled={activeSectionIndex < 0 || activeSectionIndex >= sections.length - 1} onClick={() => void reorderActiveSection(1)}>Move later</button>
                  <button disabled={!nextSection} onClick={() => void mergeActiveWithNext()}>Merge next</button>
                </div>
                <div className="section-split-row">
                  <label>Split before page<input type="number" min={activeSection.startPage + 1} max={activeSection.endPage} value={splitPage} disabled={activeSection.endPage <= activeSection.startPage} onChange={(event) => setSplitPage(Number(event.target.value))} /></label>
                  <button disabled={activeSection.endPage <= activeSection.startPage} onClick={() => void splitActiveSection()}>Split section</button>
                </div>
                <details className="passage-preview">
                  <summary>{activePassages.length} citation-ready passages</summary>
                  <p className="segmentation-note">Passages anchor search, graph, and skill context. Audio follows the reviewed section boundary, then splits it into provider-sized parts.</p>
                  {activePassages.length ? activePassages.map((passage) => <details className="passage-trace" key={passage.id}>
                    <summary>
                      <span>PASSAGE {passage.sequence + 1} · PP. {passage.startPage}–{passage.endPage} · {passage.quality}</span>
                      <small>{passage.evidence.length} anchors · {passage.characterCount} characters</small>
                    </summary>
                    <div className="passage-copy-compare">
                      <div><strong>Immutable source</strong><p>{passage.sourceText}</p></div>
                      <div><strong>Reading copy</strong><p>{passage.readingText}</p></div>
                    </div>
                    <div className="passage-integrity"><span>Content</span><code title={passage.contentHash}>{passage.contentHash}</code><span>Extraction r{passage.extractionRevision} · section r{passage.structureRevision}</span></div>
                    <div className="anchor-list" aria-label={`Evidence anchors for passage ${passage.sequence + 1}`}>
                      {passage.evidence.map((anchor) => <button
                        key={anchor.id}
                        onClick={() => void loadPage(document.id, anchor.page, anchor.blockId)}
                        title={`${anchor.contentHash} · characters ${anchor.characterRange.start}–${anchor.characterRange.end}`}
                      >
                        <strong>Page {anchor.page}</strong>
                        <span>{anchor.blockId}</span>
                        <small>chars {anchor.characterRange.start}–{anchor.characterRange.end} · open exact highlight →</small>
                      </button>)}
                    </div>
                  </details>) : <p>No passages are available until this range has readable, included text.</p>}
                </details>
              </div>
            </details>}
            <div className="block-list" aria-label="Extracted reading order">
              <div className="block-list-heading"><strong>Reading order</strong><span>{inspection?.blocks.length ?? 0} blocks</span></div>
              {inspection?.blocks.map((block, index) => (
                <button
                  key={block.id}
                  className={block.id === selectedId ? "block-row active" : `block-row ${block.status}`}
                  onClick={() => setSelectedId(block.id)}
                  aria-pressed={block.id === selectedId}
                  aria-label={`${block.currentText}; ${block.status}`}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span>{block.currentText}</span>
                </button>
              ))}
            </div>

            {selected ? <div className="selection-panel">
              <div className="selection-meta">PAGE {selected.pageNumber} · {selected.id.split("-").at(-1)?.toUpperCase()}</div>
              <div className="source-panel">
                <div>ORIGINAL SOURCE · NEVER OVERWRITTEN</div>
                <blockquote>{selected.sourceText}</blockquote>
                {selected.currentText !== selected.sourceText && <span role="status">Reading text has a local repair</span>}
              </div>
              <label className="repair-field">Reading copy<textarea
                aria-label="Repaired reading text"
                value={selected.currentText}
                onChange={(event) =>
                  setInspection((current) => current ? { ...current, blocks: current.blocks.map((block) => block.id === selected.id ? { ...block, currentText: event.target.value } : block) } : current)
                }
              /></label>
              <div className="button-row">
                {playback === "idle" ? <button className="listen" onClick={speakSelection}>Listen to reading text</button> : <button className="listen" onClick={pauseOrResume}>{playback === "playing" ? "Pause" : "Resume"}</button>}
                {playback !== "idle" && <button onClick={stopPlayback}>Stop</button>}
                <button onClick={() => void updateBlock({ currentText: selected.currentText })}>Save repair</button>
              </div>
              <div className="button-row compact">
                <button onClick={() => void reorderSelected(-1)}>Move earlier</button>
                <button onClick={() => void reorderSelected(1)}>Move later</button>
                <button aria-pressed={selected.status !== "included"} onClick={() => void updateBlock({ status: selected.status === "included" ? "excluded" : "included" })}>
                  {selected.status === "included" ? "Exclude" : "Include"}
                </button>
              </div>
              <label className="note-field">Cited note<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="What does this passage change or support?" /></label>
              <button className="save-note" onClick={() => void saveNote()} disabled={!note.trim()}>Save with evidence</button>
            </div> : <div className="empty-inspector">Select a highlighted source region on the page to inspect it.</div>}
          </div>}

          {workspaceView === "listen" && activeNarrationSection && <div id="workspace-panel-listen" role="tabpanel" aria-labelledby="workspace-tab-listen" className="workspace-panel">
            <div className="workspace-explainer"><span>DEVICE VOICE IS FREE</span><h2>Listen beside the page.</h2><p>Preview locally with no key. Reviewed section boundaries become tracks; reusable provider audio is split again only to fit provider limits.</p></div>
            <NarrationPanel section={activeNarrationSection} documentName={document.originalName} requestJson={request} fetchArtifact={fetchAudioArtifact} />
          </div>}
          {workspaceView === "listen" && !activeNarrationSection && <div id="workspace-panel-listen" role="tabpanel" aria-labelledby="workspace-tab-listen" className="empty-inspector">This section is excluded from derived passages and narration. Accept it or return it to review before listening.</div>}

          {workspaceView === "produce" && activeProductionSection && <div id="workspace-panel-produce" role="tabpanel" aria-labelledby="workspace-tab-produce" className="workspace-panel">
            <div className="workspace-explainer"><span>PLAN LOCALLY · SPEND DELIBERATELY</span><h2>Produce a cited package.</h2><p>Create a free dry run first. Each reviewed section is a track; the plan shows every provider-sized part before any paid call.</p></div>
            <button className="inline-route" onClick={() => setWorkspaceView("listen")}>Need a provider key? Configure it in Listen <span aria-hidden="true">→</span></button>
            <AudiobookPanel documentId={document.id} sections={sections.filter(({ status }) => status === "accepted")} activeSection={activeProductionSection} requestJson={request} />
          </div>}
          {workspaceView === "produce" && !activeProductionSection && <div id="workspace-panel-produce" role="tabpanel" aria-labelledby="workspace-tab-produce" className="empty-inspector">
            <strong>Review this boundary before paid production.</strong>
            <p>{activeSection?.status === "excluded" ? "Excluded sections cannot enter audiobook production." : "Detected chapters are proposals until you accept them. Device preview remains available in Listen."}</p>
            {activeSection && activeSection.status === "proposed" && <button className="accept-boundary" onClick={() => void updateSection({ status: "accepted" })}>Accept section boundary</button>}
          </div>}
        </aside>
      </div>
    </main>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NarrationPanel } from "./NarrationPanel.js";
import { AudiobookPanel } from "./AudiobookPanel.js";

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

interface DocumentRecord {
  id: string;
  originalName: string;
  documentHash: string;
  pageCount: number;
}

interface Section {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  order: number;
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
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-scribe-token": TOKEN, ...init?.headers },
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({ error: response.statusText }))) as { error: string };
    throw new Error(failure.error);
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
  const [pageNumber, setPageNumber] = useState(1);
  const [inspection, setInspection] = useState<Inspection>();
  const [renderSource, setRenderSource] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("Local service ready");
  const [busy, setBusy] = useState(false);
  const [playback, setPlayback] = useState<"idle" | "playing" | "paused">("idle");
  const utteranceRef = useRef<SpeechSynthesisUtterance | undefined>(undefined);

  const selected = useMemo(
    () => inspection?.blocks.find(({ id }) => id === selectedId),
    [inspection, selectedId],
  );
  const activeSection =
    sections.find(({ startPage }) => startPage === pageNumber) ??
    sections.find(({ startPage, endPage }) => pageNumber >= startPage && pageNumber <= endPage);

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
      const [progress, notes] = await Promise.all([
        request<{ pageNumber: number; blockId?: string } | null>(`/api/documents/${result.document.id}/progress`),
        request<Annotation[]>(`/api/documents/${result.document.id}/annotations`),
      ]);
      setAnnotations(notes);
      await loadPage(result.document.id, progress?.pageNumber ?? 1, progress?.blockId);
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
      setMessage("Repair saved locally");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Repair failed");
    }
  }

  async function reorderSelected(direction: -1 | 1) {
    if (!selected) return;
    try {
      const blocks = await request<Block[]>(`/api/blocks/${selected.id}/reorder`, {
        method: "POST",
        body: JSON.stringify({ direction }),
      });
      setInspection((current) => current ? { ...current, blocks } : current);
      setMessage(direction < 0 ? "Moved earlier in reading order" : "Moved later in reading order");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reading order update failed");
    }
  }

  async function updateSection(patch: Partial<Section>) {
    if (!activeSection) return;
    try {
      const updated = await request<Section>(`/api/sections/${activeSection.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setSections((current) => current.map((section) => (section.id === updated.id ? updated : section)));
      setMessage("Section guide updated");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Section update failed");
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

  if (!document) {
    return (
      <main className="welcome-shell">
        <section className="welcome-card" aria-labelledby="welcome-title">
          <div className="eyebrow">LOCAL READING INSTRUMENT · 001</div>
          <h1 id="welcome-title">Turn a book into navigable context.</h1>
          <p>
            Import a local PDF. ScribeSkill preserves the page, reveals uncertain extraction, and gives every
            insight an exact place to return to.
          </p>
          <label className="file-picker">
            <span>{busy ? "Inspecting source…" : "Choose a PDF"}</span>
            <input
              type="file"
              accept="application/pdf,.pdf"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
              }}
            />
          </label>
          <div className="or-rule"><span>or open by path</span></div>
          <label className="path-field">
            <span>PDF path</span>
            <input
              value={pdfPath}
              onChange={(event) => setPdfPath(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void importPdf()}
              placeholder="/Users/you/Books/example.pdf"
              autoFocus
            />
          </label>
          <button className="path-action" onClick={() => void importPdf()} disabled={busy || !pdfPath.trim()}>
            Open path
          </button>
          <div className="privacy-note"><span aria-hidden="true">●</span> Offline import · no model or provider call</div>
          <p className="status-line" role="status">{message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="reader-shell">
      <header className="topbar">
        <div className="brand">
          <div className="wordmark">ScribeSkill</div>
          <div className="document-title">{document.originalName}</div>
        </div>
        <div className="source-status" data-quality={inspection?.page.quality}>
          <span aria-hidden="true">●</span> {message}
        </div>
        <div className="top-actions">
          <button onClick={() => void exportNotes()}>Export cited notes</button>
          <button onClick={() => { window.localStorage.removeItem(LAST_DOCUMENT_KEY); setDocument(undefined); }}>Close</button>
        </div>
      </header>

      <div className="reader-grid">
        <nav className="section-rail" aria-label="Book sections">
          <div className="rail-label">CONTEXT MAP</div>
          {sections.map((section) => (
            <button
              key={section.id}
              className={activeSection?.id === section.id ? "section active" : "section"}
              aria-current={activeSection?.id === section.id ? "location" : undefined}
              onClick={() => void loadPage(document.id, section.startPage)}
            >
              <span>{String(section.order + 1).padStart(2, "0")}</span>
              <strong>{section.title}</strong>
              <small>pp. {section.startPage}–{section.endPage}</small>
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
            <div className="rail-label">EVIDENCE INSPECTOR</div>
            <span>{inspection ? Math.round(inspection.page.confidence * 100) : 0}% extraction</span>
          </div>

          {activeSection && (
            <><fieldset className="section-editor">
              <legend>Navigation guide</legend>
              <label>Section title<input key={`${activeSection.id}-title`} defaultValue={activeSection.title} onBlur={(event) => void updateSection({ title: event.target.value })} /></label>
              <div className="range-fields">
                <label>From<input key={`${activeSection.id}-from`} type="number" min="1" max={document.pageCount} defaultValue={activeSection.startPage} onBlur={(event) => void updateSection({ startPage: Number(event.target.value) })} /></label>
                <label>To<input key={`${activeSection.id}-to`} type="number" min="1" max={document.pageCount} defaultValue={activeSection.endPage} onBlur={(event) => void updateSection({ endPage: Number(event.target.value) })} /></label>
              </div>
            </fieldset>
            <NarrationPanel section={activeSection} documentName={document.originalName} requestJson={request} fetchArtifact={fetchAudioArtifact} />
            <AudiobookPanel documentId={document.id} sections={sections} activeSection={activeSection} requestJson={request} /></>
          )}

          <div className="block-list" aria-label="Extracted reading order">
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

          {selected ? (
            <div className="selection-panel">
              <div className="selection-meta">PAGE {selected.pageNumber} · {selected.id.split("-").at(-1)?.toUpperCase()}</div>
              <div className="source-panel">
                <div>IMMUTABLE EXTRACTED SOURCE · CITED BY NOTES</div>
                <blockquote>{selected.sourceText}</blockquote>
                {selected.currentText !== selected.sourceText && <span role="status">Reading text has a local repair</span>}
              </div>
              <textarea
                aria-label="Repaired reading text"
                value={selected.currentText}
                onChange={(event) =>
                  setInspection((current) => current ? { ...current, blocks: current.blocks.map((block) => block.id === selected.id ? { ...block, currentText: event.target.value } : block) } : current)
                }
              />
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
              <label className="note-field">Your note · cites immutable source<textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="How will you use this context?" /></label>
              <button className="save-note" onClick={() => void saveNote()} disabled={!note.trim()}>Save with evidence</button>
            </div>
          ) : (
            <div className="empty-inspector">Select a source region to inspect or annotate it.</div>
          )}
        </aside>
      </div>
    </main>
  );
}

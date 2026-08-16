import { useEffect, useMemo, useState } from "react";

interface Section {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
}

interface Blocker {
  code: string;
  message: string;
}

interface ProductionChunk {
  id: string;
  sectionTitle: string;
  state: string;
  estimatedCostUsd: number;
  reused: boolean;
  error?: string;
  qc: { state: string; checks: Array<{ severity: string; message: string }> };
}

interface AudiobookRun {
  id: string;
  planHash: string;
  state: "draft" | "approved" | "running" | "paused" | "needs-review" | "completed" | "failed" | "cancelled" | "budget-exhausted" | "stale";
  documentId: string;
  provider: "openai" | "elevenlabs";
  rights: { scope: "private-listening" | "redistribution" };
  totalCharacters: number;
  estimatedCostUsd: number;
  committedCostUsd: number;
  providerRequests: number;
  blockers: Blocker[];
  chunks: ProductionChunk[];
  receipt?: { id: string };
  export?: { path: string; manifestHash: string };
}

interface Props {
  documentId: string;
  sections: Section[];
  activeSection: Section;
  requestJson<T>(path: string, init?: RequestInit): Promise<T>;
}

function runStatus(run: AudiobookRun): string {
  const generated = run.chunks.filter(({ state }) => state === "generated").length;
  return `${run.state.replaceAll("-", " ")} · ${generated}/${run.chunks.length} parts · ${run.providerRequests} provider requests`;
}

export function AudiobookPanel({ documentId, sections, activeSection, requestJson }: Props) {
  const [scope, setScope] = useState<"section" | "book">("section");
  const [provider, setProvider] = useState<"openai" | "elevenlabs">("openai");
  const [voice, setVoice] = useState("coral");
  const [rate, setRate] = useState("20");
  const [costCeiling, setCostCeiling] = useState("10");
  const [characterCeiling, setCharacterCeiling] = useState("1000000");
  const [requestCeiling, setRequestCeiling] = useState("500");
  const [chunkSize, setChunkSize] = useState("4000");
  const [rightsAffirmed, setRightsAffirmed] = useState(false);
  const [rightsScope, setRightsScope] = useState<"private-listening" | "redistribution">("private-listening");
  const [exportAffirmed, setExportAffirmed] = useState(false);
  const [qualityApproved, setQualityApproved] = useState(false);
  const [pronunciationText, setPronunciationText] = useState("");
  const [reviewReason, setReviewReason] = useState("");
  const [run, setRun] = useState<AudiobookRun>();
  const [watch, setWatch] = useState(false);
  const [message, setMessage] = useState("Dry-run planning stays local and makes no provider call.");
  const [busy, setBusy] = useState(false);

  const selectedSections = useMemo(() => scope === "book" ? sections : [activeSection], [scope, sections, activeSection]);
  const pending = run?.state === "running" || watch;

  useEffect(() => {
    void requestJson<AudiobookRun[]>("/api/audiobooks").then((runs) => {
      const latest = runs.find((candidate) => candidate.documentId === documentId);
      if (latest) {
        setRun(latest);
        setRightsScope(latest.rights.scope);
      }
    }).catch(() => undefined);
  }, [documentId]);

  useEffect(() => {
    if (!run || !pending) return;
    let disposed = false;
    let reading = false;
    const timer = window.setInterval(() => {
      if (reading) return;
      reading = true;
      void requestJson<AudiobookRun>(`/api/audiobooks/${run.id}`).then((next) => {
        if (!disposed) {
          setRun(next);
          setMessage(runStatus(next));
          if (!["approved", "running", "paused"].includes(next.state)) setWatch(false);
        }
      }).catch((error) => {
        if (!disposed) setMessage(error instanceof Error ? error.message : "Production status unavailable");
      }).finally(() => { reading = false; });
    }, 700);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [run?.id, pending]);

  function pronunciationRules() {
    return pronunciationText.split("\n").map((line) => line.split("=>")).filter((parts) => parts.length === 2)
      .map(([source, spoken]) => ({ source: source!.trim(), spoken: spoken!.trim() }));
  }

  async function plan() {
    setBusy(true);
    try {
      const planned = await requestJson<AudiobookRun>("/api/audiobooks/plans", {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          documentId,
          sectionIds: selectedSections.map(({ id }) => id),
          qualityApprovedSectionIds: qualityApproved ? selectedSections.map(({ id }) => id) : [],
          provider,
          voice,
          format: "mp3",
          maxChunkCharacters: Number(chunkSize),
          usdPerMillionCharacters: Number(rate),
          maxCostUsd: Number(costCeiling),
          maxCharacters: Number(characterCeiling),
          maxProviderRequests: Number(requestCeiling),
          rightsAffirmed,
          rightsScope,
          attestor: "user",
          pronunciation: pronunciationRules(),
        }),
      });
      setRun(planned);
      setMessage(planned.blockers.length ? `${planned.blockers.length} blocker(s) must be resolved in a new plan.` : "Dry run ready. Review the immutable plan before confirming.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Plan could not be created");
    } finally {
      setBusy(false);
    }
  }

  async function action(name: "confirm" | "start" | "pause" | "resume" | "cancel" | "approve" | "export") {
    if (!run) return;
    setBusy(true);
    try {
      const payload = name === "confirm" ? { planHash: run.planHash }
        : name === "approve" ? { reviewer: "user", reason: reviewReason }
        : name === "export" ? { exportAffirmed, purpose: rightsScope === "redistribution" ? "redistribution" : "private-backup", attestor: "user" }
        : {};
      const next = await requestJson<AudiobookRun>(`/api/audiobooks/${run.id}/${name}`, { method: "POST", body: JSON.stringify(payload) });
      setRun(next);
      if (name === "start" || name === "resume") setWatch(true);
      if (name === "pause" || name === "cancel") setWatch(false);
      setMessage(name === "start" || name === "resume" ? "Production queued. You can pause after the active provider request or cancel it now."
        : name === "export" ? `Verified package exported locally to ${next.export?.path}`
        : runStatus(next));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Could not ${name} production`);
    } finally {
      setBusy(false);
    }
  }

  async function retryChunk(chunkId: string) {
    if (!run) return;
    setBusy(true);
    try {
      const next = await requestJson<AudiobookRun>(`/api/audiobooks/${run.id}/chunks/${chunkId}/retry`, { method: "POST", body: "{}" });
      setRun(next);
      setMessage("Part reset deliberately. Resume to make the next provider call; completed parts will be reused.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Part could not be retried");
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="audiobook-studio" open>
      <summary><span>CITED AUDIOBOOK</span><strong>Package sections for humans + agents</strong><small>Dry run → confirm → generate → review → export</small></summary>
      <div className="audiobook-body">
        <p className="component-purpose"><strong>What this does</strong> Turns the guide into independently retryable audio parts plus citations, QC records, rights receipts, and checksums.</p>
        <p className="audiobook-safety"><strong>What you need:</strong> planning is free and local. Production needs a provider key, a cost ceiling, and permission to synthesize the selected text.</p>
        <fieldset className="production-scope">
          <legend>Production scope</legend>
          <label><input type="radio" checked={scope === "section"} onChange={() => setScope("section")} /> This section · {activeSection.title}</label>
          <label><input type="radio" checked={scope === "book"} onChange={() => setScope("book")} /> Whole navigation guide · {sections.length} sections</label>
        </fieldset>
        <div className="production-grid">
          <label>Provider<select value={provider} onChange={(event) => {
            const next = event.target.value as typeof provider;
            setProvider(next);
            setVoice(next === "openai" ? "coral" : "");
            setChunkSize(next === "openai" ? "4000" : "10000");
          }}><option value="openai">OpenAI</option><option value="elevenlabs">ElevenLabs</option></select></label>
          <label>Rights scope<select value={rightsScope} onChange={(event) => {
            setRightsScope(event.target.value as typeof rightsScope);
            setRightsAffirmed(false);
            setExportAffirmed(false);
          }}><option value="private-listening">Private listening</option><option value="redistribution">Redistribution</option></select></label>
          <label>Voice ID<input value={voice} onChange={(event) => setVoice(event.target.value)} /></label>
          <label>Planning rate · USD / 1M chars<input type="number" min="0.000001" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} /></label>
          <label>Hard cost ceiling · USD<input type="number" min="0.01" step="0.01" value={costCeiling} onChange={(event) => setCostCeiling(event.target.value)} /></label>
          <label>Character ceiling<input type="number" min="1" value={characterCeiling} onChange={(event) => setCharacterCeiling(event.target.value)} /></label>
          <label>Request ceiling<input type="number" min="1" value={requestCeiling} onChange={(event) => setRequestCeiling(event.target.value)} /></label>
          <label>Characters per part<input type="number" min="32" max={provider === "openai" ? 4096 : undefined} value={chunkSize} onChange={(event) => setChunkSize(event.target.value)} /></label>
        </div>
        <p className="rate-warning">The rate is your conservative planning assumption—not a live quote. Verify the provider’s billing unit before approval.</p>
        <label className="pronunciation-field">Pronunciation rules · one “written =&gt; spoken” per line<textarea value={pronunciationText} onChange={(event) => setPronunciationText(event.target.value)} placeholder="Dr. Scribe => Doctor Scribe" /></label>
        <label className="approval-check"><input type="checkbox" checked={qualityApproved} onChange={(event) => setQualityApproved(event.target.checked)} /> I reviewed any pages marked “reading order review” in this scope.</label>
        <label className="approval-check"><input type="checkbox" checked={rightsAffirmed} onChange={(event) => setRightsAffirmed(event.target.checked)} /> I have permission to synthesize these sections for {rightsScope === "redistribution" ? "redistribution" : "private listening"}.</label>
        <button className="plan-button" onClick={() => void plan()} disabled={busy || !voice.trim()}>Create local dry-run plan</button>

        {run && <section className="run-card" aria-live="polite">
          <div className="run-state"><strong>{run.state.replaceAll("-", " ")}</strong><span>{run.chunks.length} parts · {run.totalCharacters.toLocaleString()} chars</span></div>
          <div className="cost-meter"><span>EST. ${run.estimatedCostUsd.toFixed(4)}</span><span>COMMITTED ${run.committedCostUsd.toFixed(4)}</span></div>
          <code title={run.planHash}>{run.planHash.slice(0, 24)}…</code>
          {run.blockers.length > 0 && <ul className="blockers">{run.blockers.map((blocker) => <li key={`${blocker.code}-${blocker.message}`}>{blocker.message}</li>)}</ul>}
          <ul className="chunk-list" aria-label="Production parts">
            {run.chunks.map((chunk, index) => <li key={chunk.id}>
              <span className="chunk-dot" data-state={chunk.state} aria-hidden="true" />
              <span>Part {index + 1}, {chunk.sectionTitle}: {chunk.state}{chunk.reused ? ", reused" : ""}. QC {chunk.qc.state}.{chunk.error ? ` ${chunk.error}` : ""}</span>
              {["failed", "cancelled", "interrupted"].includes(chunk.state) && <button onClick={() => void retryChunk(chunk.id)} disabled={busy}>Retry part</button>}
            </li>)}
          </ul>
          <div className="production-actions">
            {run.state === "draft" && <button onClick={() => void action("confirm")} disabled={busy || run.blockers.length > 0}>Confirm exact plan</button>}
            {run.state === "approved" && <button className="primary" onClick={() => void action("start")} disabled={busy}>Start provider calls</button>}
            {run.state === "running" && <><button onClick={() => void action("pause")} disabled={busy}>Pause after active part</button><button className="danger" onClick={() => void action("cancel")} disabled={busy}>Cancel active call</button></>}
            {run.state === "paused" && <button className="primary" onClick={() => void action("resume")} disabled={busy}>Resume remaining parts</button>}
          </div>
          {run.state === "needs-review" && <div className="review-box">
            <label>QC review / warning waiver reason<textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="What did you inspect or listen to?" /></label>
            <button onClick={() => void action("approve")} disabled={busy || !reviewReason.trim()}>Approve reviewed package</button>
          </div>}
          {run.state === "completed" && <>
            <label className="approval-check"><input type="checkbox" checked={exportAffirmed} onChange={(event) => setExportAffirmed(event.target.checked)} /> {rightsScope === "redistribution" ? "I affirm again that I may export these files for redistribution." : "I understand this export is for my private backup/listening and grants no redistribution rights."}</label>
            <button className="plan-button" onClick={() => void action("export")} disabled={busy || !exportAffirmed}>Export manifest + chapter parts + checksums</button>
          </>}
          {run.export && <div className="export-path">LOCAL PACKAGE<br />{run.export.path}</div>}
        </section>}
        <p className="production-message" role="status">{message}</p>
      </div>
    </details>
  );
}

import { useEffect, useMemo, useState } from "react";

type InquiryMove = "deepen" | "challenge" | "connect" | "apply" | "synthesize" | "complete";
type ResponseKind = "grounded-interpretation" | "personal-reflection";

interface InquiryRoute {
  id: "understand" | "challenge" | "apply" | "reflect";
  title: string;
  description: string;
  openingPrompt: string;
  suggestedMoves: Exclude<InquiryMove, "complete">[];
}

interface EvidenceAnchor {
  id: string;
  page: number;
  blockId: string;
}

interface InquiryEvidence {
  passageId: string;
  sectionId: string;
  sectionTitle: string;
  pages: [number, number];
  snippet: string;
  preferredEvidenceId: string;
  evidence: EvidenceAnchor[];
}

interface InquiryStep {
  id: string;
  sequence: number;
  prompt: string;
  purpose: string;
  status: "pending" | "answered";
  response?: string;
  responseKind?: ResponseKind;
  evidencePassageIds: string[];
  nextMove?: InquiryMove;
}

interface InquirySession {
  id: string;
  route: InquiryRoute;
  objective: string;
  title: string;
  status: "active" | "completed";
  stale: boolean;
  staleReason?: string;
  evidence: InquiryEvidence[];
  steps: InquiryStep[];
  currentStepId?: string;
  updatedAt: string;
}

interface Props {
  documentId: string;
  documentName: string;
  requestJson<T>(path: string, init?: RequestInit): Promise<T>;
  downloadArtifact(path: string, filename: string): Promise<void>;
  openEvidence(evidence: InquiryEvidence, anchor: EvidenceAnchor): Promise<void>;
}

function AnsweredStep({
  session,
  step,
  requestJson,
  openEvidence,
  onSaved,
}: {
  session: InquirySession;
  step: InquiryStep;
  requestJson: Props["requestJson"];
  openEvidence: Props["openEvidence"];
  onSaved(session: InquirySession): void;
}) {
  const [response, setResponse] = useState(step.response ?? "");
  const [responseKind, setResponseKind] = useState<ResponseKind>(step.responseKind ?? "personal-reflection");
  const [evidencePassageIds, setEvidencePassageIds] = useState(step.evidencePassageIds);
  const [editing, setEditing] = useState(false);

  async function save() {
    const updated = await requestJson<InquirySession>(`/api/inquiries/${session.id}/steps/${step.id}`, {
      method: "PATCH",
      body: JSON.stringify({ response, responseKind, evidencePassageIds }),
    });
    onSaved(updated);
    setEditing(false);
  }

  return <article className="inquiry-step answered">
    <div className="inquiry-step-index">{String(step.sequence).padStart(2, "0")}</div>
    <div className="inquiry-step-body">
      <span>{step.purpose}</span>
      <h3>{step.prompt}</h3>
      {editing ? <>
        <label className="inquiry-response-kind">Authorship
          <select value={responseKind} onChange={(event) => setResponseKind(event.target.value as ResponseKind)}>
            <option value="personal-reflection">Personal reflection</option>
            <option value="grounded-interpretation">Grounded interpretation</option>
          </select>
        </label>
        <textarea value={response} onChange={(event) => setResponse(event.target.value)} />
        {responseKind === "grounded-interpretation" && <div className="inquiry-citation-checks">
          {session.evidence.map((item) => <label key={item.passageId}><input
            type="checkbox"
            checked={evidencePassageIds.includes(item.passageId)}
            onChange={(event) => setEvidencePassageIds((current) => event.target.checked ? [...current, item.passageId] : current.filter((id) => id !== item.passageId))}
          /> {item.sectionTitle}</label>)}
        </div>}
        <div className="button-row compact"><button onClick={() => void save()} disabled={!response.trim() || (responseKind === "grounded-interpretation" && evidencePassageIds.length === 0)}>Save edit</button><button onClick={() => setEditing(false)}>Cancel</button></div>
      </> : <>
        <p>{step.response}</p>
        <div className="inquiry-authorship" data-kind={step.responseKind}>
          {step.responseKind === "grounded-interpretation" ? `Grounded interpretation · ${step.evidencePassageIds.length} citation${step.evidencePassageIds.length === 1 ? "" : "s"}` : "Personal reflection · not presented as a book claim"}
        </div>
        {step.responseKind === "grounded-interpretation" && <div className="inquiry-step-citations" aria-label={`Exact source citations for response ${step.sequence}`}>
          {step.evidencePassageIds.map((passageId) => {
            const evidence = session.evidence.find((item) => item.passageId === passageId);
            const anchor = evidence?.evidence.find(({ id }) => id === evidence.preferredEvidenceId) ?? evidence?.evidence[0];
            return evidence && anchor ? <button key={passageId} onClick={() => void openEvidence(evidence, anchor)}>
              Open cited block · {evidence.sectionTitle} · p. {anchor.page}
            </button> : null;
          })}
        </div>}
        <button className="inquiry-edit" onClick={() => setEditing(true)}>Edit response</button>
      </>}
    </div>
  </article>;
}

export function InquiryPanel({ documentId, documentName, requestJson, downloadArtifact, openEvidence }: Props) {
  const [routes, setRoutes] = useState<InquiryRoute[]>([]);
  const [sessions, setSessions] = useState<InquirySession[]>([]);
  const [session, setSession] = useState<InquirySession>();
  const [routeId, setRouteId] = useState<InquiryRoute["id"]>("understand");
  const [objective, setObjective] = useState("");
  const [response, setResponse] = useState("");
  const [responseKind, setResponseKind] = useState<ResponseKind>("grounded-interpretation");
  const [evidencePassageIds, setEvidencePassageIds] = useState<string[]>([]);
  const [nextMove, setNextMove] = useState<InquiryMove>("deepen");
  const [message, setMessage] = useState("Loading local inquiry routes…");
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const currentStep = session?.steps.find(({ id }) => id === session.currentStepId);
  const selectedRoute = routes.find(({ id }) => id === routeId);
  const availableMoves = useMemo(
    () => [...(session?.route.suggestedMoves ?? selectedRoute?.suggestedMoves ?? ["deepen", "challenge", "synthesize"]), "complete"] as InquiryMove[],
    [selectedRoute, session],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      requestJson<{ routes: InquiryRoute[] }>("/api/inquiry/routes"),
      requestJson<InquirySession[]>(`/api/documents/${documentId}/inquiries`),
    ]).then(([routeResult, sessionResult]) => {
      if (cancelled) return;
      setRoutes(routeResult.routes);
      setSessions(sessionResult);
      setSession(sessionResult[0]);
      setMessage(sessionResult.length ? "Resumed the most recent local inquiry." : "Choose a route and the idea you want to examine.");
    }).catch((error) => !cancelled && setMessage(error instanceof Error ? error.message : "Inquiry workspace could not load"));
    return () => { cancelled = true; };
  }, [documentId, requestJson]);

  useEffect(() => {
    if (!session) return;
    setEvidencePassageIds(session.evidence.map(({ passageId }) => passageId));
    setResponse("");
    setNextMove(session.route.suggestedMoves[0] ?? "synthesize");
    setDeleteArmed(false);
  }, [session?.id, session?.currentStepId]);

  async function startInquiry() {
    if (!objective.trim()) return;
    setBusy(true);
    try {
      const idempotencyKey = globalThis.crypto?.randomUUID?.() ?? `inquiry-${Date.now()}`;
      const created = await requestJson<InquirySession>("/api/inquiries", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey },
        body: JSON.stringify({ documentId, routeId, objective: objective.trim() }),
      });
      setSession(created);
      setSessions((current) => [created, ...current]);
      setObjective("");
      setMessage(`Started “${created.title}” with ${created.evidence.length} cited passages.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Inquiry could not start");
    } finally {
      setBusy(false);
    }
  }

  async function answerCurrent() {
    if (!session || !currentStep || !response.trim()) return;
    setBusy(true);
    try {
      const updated = await requestJson<InquirySession>(`/api/inquiries/${session.id}/steps/${currentStep.id}/answer`, {
        method: "POST",
        body: JSON.stringify({
          response,
          responseKind,
          evidencePassageIds: responseKind === "grounded-interpretation" ? evidencePassageIds : [],
          nextMove,
        }),
      });
      setSession(updated);
      setSessions((current) => [updated, ...current.filter(({ id }) => id !== updated.id)]);
      setMessage(updated.status === "completed" ? "Inquiry completed and saved locally." : `Saved. Next move: ${nextMove}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Response could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSession() {
    if (!session) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      setMessage("Press delete again to permanently remove this local inquiry.");
      return;
    }
    await requestJson(`/api/inquiries/${session.id}`, { method: "DELETE" });
    const remaining = sessions.filter(({ id }) => id !== session.id);
    setSessions(remaining);
    setSession(remaining[0]);
    setMessage("Inquiry deleted from local SQLite.");
  }

  async function download(path: string, filename: string) {
    try {
      await downloadArtifact(path, filename);
      setMessage(`Exported ${filename}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Inquiry export failed");
    }
  }

  function updateSession(updated: InquirySession) {
    setSession(updated);
    setSessions((current) => [updated, ...current.filter(({ id }) => id !== updated.id)]);
    setMessage("Response edit saved locally.");
  }

  if (!session) return <div className="inquiry-workspace">
    <section className="inquiry-start" aria-labelledby="inquiry-start-title">
      <span>START A LOCAL INQUIRY</span>
      <h3 id="inquiry-start-title">What do you want this book to help you examine?</h3>
      <label>Inquiry route<select value={routeId} onChange={(event) => setRouteId(event.target.value as InquiryRoute["id"])}>
        {routes.map((route) => <option value={route.id} key={route.id}>{route.title}</option>)}
      </select></label>
      <p>{selectedRoute?.description}</p>
      {selectedRoute && <div className="inquiry-route-preview"><strong>First question</strong><p>{selectedRoute.openingPrompt}</p><small>After each answer, you choose where the inquiry goes next.</small></div>}
      <label>Objective<textarea value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="e.g. What would a better diagnosis of this problem require?" /></label>
      <button onClick={() => void startInquiry()} disabled={busy || objective.trim().length < 3}>{busy ? "Finding evidence…" : "Find evidence and begin"}</button>
      <small>Uses accepted passages only · maximum 6,000 source characters · no model or API key</small>
    </section>
    {!!sessions.length && <div className="inquiry-history">{sessions.map((item) => <button key={item.id} onClick={() => setSession(item)}><strong>{item.title}</strong><span>{item.route.title} · {item.status}</span></button>)}</div>}
    <p className="inquiry-message" role="status">{message}</p>
  </div>;

  return <div className="inquiry-workspace">
    <div className="inquiry-session-head">
      <div className="inquiry-session-nav"><button onClick={() => setSession(undefined)}>← All inquiries</button><button onClick={() => { setSession(undefined); setMessage("Choose a route and the idea you want to examine."); }}>+ New inquiry</button></div>
      <div><span>{session.route.title} · {session.status}</span><h3>{session.title}</h3></div>
      <span>{session.steps.filter(({ status }) => status === "answered").length}/{session.steps.length} answered</span>
    </div>
    {session.stale && <div className="inquiry-stale" role="alert"><strong>Source review changed</strong><p>{session.staleReason} Export remains available, but continue only from a fresh inquiry.</p></div>}
    <section className="inquiry-evidence" aria-labelledby="inquiry-evidence-title">
      <div><span>BOOK CONTEXT · UNTRUSTED SOURCE</span><h3 id="inquiry-evidence-title">{session.evidence.length} passages selected locally</h3></div>
      {session.evidence.map((item, index) => {
        const anchor = item.evidence.find(({ id }) => id === item.preferredEvidenceId) ?? item.evidence[0];
        return <article key={item.passageId}>
          <span>{String(index + 1).padStart(2, "0")} · pp. {item.pages[0]}–{item.pages[1]}</span>
          <strong>{item.sectionTitle}</strong>
          <small>Derived retrieval snippet · verify against source</small>
          <p>{item.snippet}</p>
          <button disabled={!anchor} onClick={() => anchor && void openEvidence(item, anchor)}>Open exact source →</button>
        </article>;
      })}
    </section>

    <section className="inquiry-steps" aria-label="Inquiry steps">
      {session.steps.filter(({ status }) => status === "answered").map((step) => <AnsweredStep key={step.id} session={session} step={step} requestJson={requestJson} openEvidence={openEvidence} onSaved={updateSession} />)}
      {currentStep && !session.stale && <article className="inquiry-step current">
        <div className="inquiry-step-index">{String(currentStep.sequence).padStart(2, "0")}</div>
        <div className="inquiry-step-body">
          <span>{currentStep.purpose}</span>
          <h3>{currentStep.prompt}</h3>
          <label className="inquiry-response-kind">This response is
            <select value={responseKind} onChange={(event) => setResponseKind(event.target.value as ResponseKind)}>
              <option value="grounded-interpretation">A grounded interpretation of the book</option>
              <option value="personal-reflection">My own reflection or experience</option>
            </select>
          </label>
          {responseKind === "grounded-interpretation" ? <div className="inquiry-citation-checks" aria-label="Evidence citations">
            <strong>Cite the passages this interpretation relies on</strong>
            {session.evidence.map((item) => <label key={item.passageId}><input
              type="checkbox"
              checked={evidencePassageIds.includes(item.passageId)}
              onChange={(event) => setEvidencePassageIds((current) => event.target.checked ? [...current, item.passageId] : current.filter((id) => id !== item.passageId))}
            /> {item.sectionTitle} · pp. {item.pages[0]}–{item.pages[1]}</label>)}
          </div> : <p className="inquiry-personal-note">This will be labeled as your writing, not as a claim made by the book.</p>}
          <label>Your response<textarea value={response} onChange={(event) => setResponse(event.target.value)} placeholder="Write what you can support, then choose where to go next." /></label>
          <label className="inquiry-next-move">Next move<select value={nextMove} onChange={(event) => setNextMove(event.target.value as InquiryMove)}>
            {availableMoves.map((move) => <option key={move} value={move}>{move === "complete" ? "Complete and save" : move[0]!.toUpperCase() + move.slice(1)}</option>)}
          </select></label>
          <button className="inquiry-save" onClick={() => void answerCurrent()} disabled={busy || !response.trim() || (responseKind === "grounded-interpretation" && evidencePassageIds.length === 0)}>{busy ? "Saving…" : nextMove === "complete" ? "Save and complete" : "Save and continue"}</button>
        </div>
      </article>}
    </section>

    <div className="inquiry-actions">
      <button onClick={() => void download(`/api/inquiries/${session.id}/export.md`, `${documentName}-inquiry.md`)}>Export Markdown</button>
      <button onClick={() => void download(`/api/inquiries/${session.id}/export.json`, `${documentName}-inquiry.json`)}>Export evidence JSON</button>
      <button className="danger" onClick={() => void deleteSession()}>{deleteArmed ? "Confirm delete" : "Delete local inquiry"}</button>
    </div>
    <p className="inquiry-message" role="status">{message}</p>
  </div>;
}

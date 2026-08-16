interface Props {
  busy: boolean;
  message: string;
  pdfPath: string;
  onChooseFile(file: File): void;
  onOpenPath(): void;
  onPathChange(value: string): void;
}

const outcomes = [
  {
    number: "01",
    title: "Listen while you read",
    description: "Hear an extracted section and follow the spoken words in the cited reading script.",
    requirement: "No key",
    detail: "Uses a voice already installed on this device.",
  },
  {
    number: "02",
    title: "Inspect with evidence",
    description: "Select any passage, repair extraction order, and save notes that return to the exact page.",
    requirement: "Local only",
    detail: "Notes and reading progress stay in SQLite.",
  },
  {
    number: "03",
    title: "Produce cited audio",
    description: "Plan costs, freeze source-linked chunks, generate section audio, review it, and export a package.",
    requirement: "BYOK",
    detail: "Needs an OpenAI or ElevenLabs key and your rights confirmation.",
  },
  {
    number: "04",
    title: "Next: export a cited skill",
    description: "A later build will turn the reviewed source into task-routed context, a knowledge graph, and a portable skill.",
    requirement: "Roadmap",
    detail: "Today, agents can use the local document and audiobook APIs; skill export is not shipped yet.",
  },
];

export function HomeScreen({ busy, message, pdfPath, onChooseFile, onOpenPath, onPathChange }: Props) {
  return (
    <main className="home-shell">
      <header className="home-nav">
        <a className="home-brand" href="#top" aria-label="ScribeSkill home">
          <span className="brand-mark" aria-hidden="true">S/S</span>
          <span>ScribeSkill</span>
        </a>
        <div className="local-badge"><span aria-hidden="true" /> Files stay local until you choose a provider</div>
      </header>

      <section className="home-hero" id="top" aria-labelledby="home-title">
        <div className="hero-copy">
          <div className="eyebrow">PDF → VOICE → CITED CONTEXT</div>
          <h1 id="home-title">Give any PDF a voice.<br /><em>Keep the page attached.</em></h1>
          <p className="hero-deck">
            ScribeSkill is a local reading desk for people and agents: listen beside the source, capture evidence-linked
            notes, produce audio in parts, and turn the book into context that knows where it came from.
          </p>
          <div className="hero-proof" aria-label="Product principles">
            <span>Local-first</span><span>Evidence-linked</span><span>Human + agent</span>
          </div>
        </div>

        <section className="import-desk" aria-labelledby="import-title">
          <div className="desk-index" aria-hidden="true">START / 01</div>
          <div>
            <p className="desk-kicker">Your first move</p>
            <h2 id="import-title">Open a PDF</h2>
            <p>Extraction and page inspection happen on this machine. You do not need an API key to begin.</p>
          </div>
          <label className="file-picker">
            <span>{busy ? "Building the reading desk…" : "Choose a PDF"}</span>
            <small>{busy ? "Extracting pages and evidence" : "Text PDFs now · image-only scans are detected"}</small>
            <input
              type="file"
              accept="application/pdf,.pdf"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onChooseFile(file);
              }}
            />
          </label>
          <p className="scan-disclosure">Image-only pages are marked for OCR and cannot be narrated until readable text is added.</p>
          <details className="path-import">
            <summary>Open a local path instead</summary>
            <label className="path-field">
              <span>PDF path</span>
              <input
                value={pdfPath}
                onChange={(event) => onPathChange(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && onOpenPath()}
                placeholder="/Users/you/Books/example.pdf"
              />
            </label>
            <button className="path-action" onClick={onOpenPath} disabled={busy || !pdfPath.trim()}>Open path</button>
          </details>
          <p className="status-line" role="status"><span aria-hidden="true">●</span> {message}</p>
        </section>
      </section>

      <section className="outcome-section" aria-labelledby="outcome-title">
        <div className="section-heading">
          <div><span className="eyebrow">FOUR USES · ONE SOURCE</span><h2 id="outcome-title">Choose how far you want to go.</h2></div>
          <p>Start with free local reading. Add a voice provider only when you want reusable generated audio.</p>
        </div>
        <div className="outcome-grid">
          {outcomes.map((outcome) => (
            <article className="outcome-card" key={outcome.number}>
              <div className="outcome-number">{outcome.number}</div>
              <h3>{outcome.title}</h3>
              <p>{outcome.description}</p>
              <div className="requirement"><strong>{outcome.requirement}</strong><span>{outcome.detail}</span></div>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-section" aria-labelledby="workflow-title">
        <div className="workflow-title-wrap">
          <span className="eyebrow">THE WORKFLOW</span>
          <h2 id="workflow-title">A reading desk,<br />not a black box.</h2>
        </div>
        <ol className="workflow-list">
          <li><span>1</span><div><strong>Inspect</strong><p>See the rendered page and the extracted reading order together. Every editable passage retains its immutable source.</p></div></li>
          <li><span>2</span><div><strong>Listen</strong><p>Preview with a device voice for free, or connect a voice provider to cache higher-quality section audio.</p></div></li>
          <li><span>3</span><div><strong>Produce</strong><p>Plan before spending, confirm rights and limits, then export independently verifiable audio parts and citations.</p></div></li>
        </ol>
      </section>

      <footer className="home-footer">
        <span>ScribeSkill · local cited reading instrument</span>
        <span>PDF today · EPUB and visual knowledge maps next</span>
      </footer>
    </main>
  );
}

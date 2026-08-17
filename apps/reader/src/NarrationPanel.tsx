import { useEffect, useMemo, useRef, useState } from "react";

interface Section {
  id: string;
  title: string;
  status: "proposed" | "accepted" | "excluded";
}

interface VoiceCapability {
  provider: "device" | "openai" | "elevenlabs";
  available: boolean;
  requiresApiKey: boolean;
  timingQuality: "exact-character" | "exact-word" | "estimated-sentence" | "none";
  streaming: boolean;
  maxCharacters?: number;
  reason?: string;
}

interface CapabilityResponse {
  voices: VoiceCapability[];
  codex: { state: string; requiredAction?: string };
}

interface NarrationScript {
  id: string;
  revision: number;
  readingText: string;
  sourceText: string;
  evidence: unknown[];
}

interface TimingSpan {
  startSeconds: number;
  endSeconds: number;
  characterRange: { start: number; end: number };
}

interface AudioJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
  artifact?: {
    timingQuality: VoiceCapability["timingQuality"];
    timings: TimingSpan[];
    disclosure: string;
  };
}

interface Props {
  section: Section;
  documentName: string;
  requestJson<T>(path: string, init?: RequestInit): Promise<T>;
  fetchArtifact(jobId: string): Promise<string>;
}

function timingLabel(quality: VoiceCapability["timingQuality"]): string {
  if (quality === "exact-character") return "Exact character timing";
  if (quality === "exact-word") return "Exact word timing";
  if (quality === "estimated-sentence") return "Estimated browser boundary timing";
  return "Audio only · no synced highlighting";
}

function HighlightedScript({ text, range }: { text: string; range?: { start: number; end: number } }) {
  if (!range) return <>{text}</>;
  return <>{text.slice(0, range.start)}<mark>{text.slice(range.start, range.end)}</mark>{text.slice(range.end)}</>;
}

export function NarrationPanel({ section, documentName, requestJson, fetchArtifact }: Props) {
  const [capabilities, setCapabilities] = useState<CapabilityResponse>();
  const [script, setScript] = useState<NarrationScript>();
  const [readingText, setReadingText] = useState("");
  const [provider, setProvider] = useState<VoiceCapability["provider"]>("device");
  const [voice, setVoice] = useState("coral");
  const [instructions, setInstructions] = useState("Read clearly and preserve the author's tone.");
  const [deviceVoices, setDeviceVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [key, setKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<{ secureStorage: boolean; openai: boolean; elevenlabs: boolean }>();
  const [job, setJob] = useState<AudioJob>();
  const [audioSource, setAudioSource] = useState<string>();
  const [message, setMessage] = useState("Loading narration script…");
  const [playback, setPlayback] = useState<"idle" | "playing" | "paused">("idle");
  const [highlightRange, setHighlightRange] = useState<{ start: number; end: number }>();
  const utteranceRef = useRef<SpeechSynthesisUtterance | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement>(null);

  const currentCapability = useMemo(
    () => capabilities?.voices.find((candidate) => candidate.provider === provider),
    [capabilities, provider],
  );
  const revision = (script?.revision ?? 1) + (script && readingText !== script.readingText ? 1 : 0);
  const draftChanged = Boolean(script && readingText !== script.readingText);
  const savedInKeychain = provider === "device" ? false : Boolean(keyStatus?.[provider]);
  const providerGenerationAllowed = section.status === "accepted";

  async function refreshCapabilities() {
    const next = await requestJson<CapabilityResponse>("/api/capabilities");
    const deviceAvailable = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
    setCapabilities({
      ...next,
      voices: next.voices.map((capability) => capability.provider === "device"
        ? { ...capability, available: deviceAvailable, reason: deviceAvailable ? undefined : "No browser device voice is available" }
        : capability),
    });
  }

  useEffect(() => {
    utteranceRef.current = undefined;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setPlayback("idle");
    setScript(undefined);
    setReadingText("");
    setJob(undefined);
    setHighlightRange(undefined);
    setAudioSource((current) => {
      if (current) URL.revokeObjectURL(current);
      return undefined;
    });
    void Promise.all([
      requestJson<NarrationScript>(`/api/sections/${section.id}/narration-script`),
      refreshCapabilities(),
      window.scribeRuntime?.providerKeyStatus?.(),
    ]).then(([nextScript, , nextKeyStatus]) => {
      setScript(nextScript);
      setReadingText(nextScript.readingText);
      setKeyStatus(nextKeyStatus);
      setMessage(`${nextScript.evidence.length} cited source blocks ready`);
    }).catch((error) => setMessage(error instanceof Error ? error.message : "Narration setup failed"));
  }, [section.id]);

  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => setDeviceVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "cancelled") return;
    let polling = false;
    let disposed = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void requestJson<AudioJob>(`/api/audio/jobs/${job.id}`).then(async (next) => {
        if (disposed) return;
        setJob(next);
        setMessage(next.status === "running" ? "Generating section audio…" : `Audio job ${next.status}`);
        if (next.status === "completed") {
          setAudioSource((current) => {
            if (current) URL.revokeObjectURL(current);
            return undefined;
          });
          const source = await fetchArtifact(next.id);
          if (disposed) {
            URL.revokeObjectURL(source);
            return;
          }
          setAudioSource(source);
          setMessage(`${timingLabel(next.artifact?.timingQuality ?? "none")} · saved locally`);
        }
        if (next.status === "failed") setMessage(next.error ?? "Audio generation failed");
      }).catch((error) => {
        if (!disposed) setMessage(error instanceof Error ? error.message : "Audio job status could not be read");
      }).finally(() => { polling = false; });
    }, 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  useEffect(() => () => {
    if (audioSource) URL.revokeObjectURL(audioSource);
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, [audioSource]);

  function playDevice() {
    if (!readingText.trim() || !("speechSynthesis" in window)) return;
    utteranceRef.current = undefined;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(readingText);
    const selectedVoice = deviceVoices.find(({ voiceURI }) => voiceURI === voice);
    if (selectedVoice) utterance.voice = selectedVoice;
    utterance.onboundary = (event) => {
      const length = event.charLength || readingText.slice(event.charIndex).match(/^\S+/)?.[0].length || 1;
      setHighlightRange({ start: event.charIndex, end: event.charIndex + length });
    };
    utterance.onstart = () => { setPlayback("playing"); setMessage("Device preview · timing depends on this browser voice"); };
    utterance.onend = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = undefined;
      setPlayback("idle");
      setHighlightRange(undefined);
    };
    utterance.onerror = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = undefined;
      setPlayback("idle");
      setMessage("Device voice stopped before the section finished");
    };
    utteranceRef.current = utterance;
    navigator.mediaSession && (navigator.mediaSession.metadata = new MediaMetadata({
      title: section.title, artist: documentName, album: "ScribeSkill device preview",
    }));
    window.speechSynthesis.speak(utterance);
  }

  function pauseOrResumeDevice() {
    if (playback === "playing") {
      window.speechSynthesis.pause();
      setPlayback("paused");
    } else {
      window.speechSynthesis.resume();
      setPlayback("playing");
    }
  }

  function stopDevice() {
    utteranceRef.current = undefined;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setPlayback("idle");
    setHighlightRange(undefined);
  }

  async function generateAudio() {
    if (!script || provider === "device") return;
    try {
      const next = await requestJson<AudioJob>("/api/audio/jobs", {
        method: "POST",
        body: JSON.stringify({
          sectionId: section.id,
          readingText,
          revision,
          provider,
          voice,
          instructions: provider === "openai" ? instructions : undefined,
          format: "mp3",
        }),
      });
      setJob(next);
      setMessage(next.status === "completed" ? "Using cached local audio" : "Audio job queued locally");
      if (next.status === "completed") setAudioSource(await fetchArtifact(next.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not queue audio");
    }
  }

  async function saveScriptDraft() {
    if (!script || !draftChanged) return;
    try {
      const saved = await requestJson<NarrationScript>(`/api/sections/${section.id}/narration-script`, {
        method: "POST",
        body: JSON.stringify({ readingText, revision }),
      });
      setScript(saved);
      setReadingText(saved.readingText);
      setMessage(`Cited script revision ${saved.revision} saved locally`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Script draft could not be saved");
    }
  }

  async function saveKey() {
    if (provider === "device" || !window.scribeRuntime?.setProviderKey) return;
    try {
      await window.scribeRuntime.setProviderKey(provider, key);
      setKey("");
      setKeyStatus(await window.scribeRuntime.providerKeyStatus?.());
      await refreshCapabilities();
      setMessage(`${provider === "openai" ? "OpenAI" : "ElevenLabs"} key encrypted by the operating system`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Key could not be saved");
    }
  }

  async function deleteKey() {
    if (provider === "device" || !window.scribeRuntime?.deleteProviderKey) return;
    try {
      await window.scribeRuntime.deleteProviderKey(provider);
      setKeyStatus(await window.scribeRuntime.providerKeyStatus?.());
      await refreshCapabilities();
      setMessage("Saved provider key removed from this device");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Key could not be removed");
    }
  }

  async function cancelAudio() {
    if (!job) return;
    try {
      const cancelled = await requestJson<AudioJob>(`/api/audio/jobs/${job.id}/cancel`, { method: "POST" });
      setJob(cancelled);
      setMessage("Audio generation cancelled");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Audio job could not be cancelled");
    }
  }

  function providerName(value: VoiceCapability["provider"]): string {
    if (value === "openai") return "OpenAI";
    if (value === "elevenlabs") return "ElevenLabs";
    return "This device";
  }

  return (
    <details className="narration-studio" open>
      <summary><span>SECTION VOICE</span><strong>{section.title}</strong><small>Choose free preview or generated audio</small></summary>
      <div className="narration-body">
        <p className="component-purpose"><strong>What this does</strong> Keeps narration tied to the current section and its evidence anchors. Device preview is provisional; paid provider generation unlocks only after you accept the section boundary.</p>
        <div className="provider-tabs" role="group" aria-label="Voice provider">
          {(["device", "openai", "elevenlabs"] as const).map((candidate) => {
            const capability = capabilities?.voices.find(({ provider: id }) => id === candidate);
            return <button key={candidate} aria-pressed={provider === candidate} onClick={() => {
              setProvider(candidate);
              setVoice(candidate === "openai" ? "coral" : candidate === "elevenlabs" ? "" : deviceVoices[0]?.voiceURI ?? "");
              stopDevice();
              setMessage(capability?.available ? `${providerName(candidate)} is ready` : capability?.reason ?? `${providerName(candidate)} setup is required`);
            }}>{providerName(candidate)}<small>{capability?.available ? "READY" : "SETUP"}</small></button>;
          })}
        </div>

        <div className="capability-strip" data-available={currentCapability?.available}>
          <span>{timingLabel(currentCapability?.timingQuality ?? "none")}</span>
          <span>{provider === "device"
            ? `${section.status === "accepted" ? "Accepted section" : "Unreviewed proposal"} · no API key · preview only`
            : !providerGenerationAllowed
              ? "Accept this section boundary before paid generation"
              : currentCapability?.available ? `BYOK configured${currentCapability.maxCharacters ? ` · ≤ ${currentCapability.maxCharacters.toLocaleString()} chars` : ""}` : currentCapability?.reason}</span>
        </div>

        <label className="script-field">What the voice will read
          <textarea value={readingText} onChange={(event) => setReadingText(event.target.value)} />
        </label>
        <div className="script-preview" aria-live="polite">
          <HighlightedScript text={readingText} range={highlightRange} />
        </div>
        <div className="script-provenance">REV {revision} · {script?.evidence.length ?? 0} EVIDENCE ANCHORS · {draftChanged ? "UNSAVED DRAFT" : "SAVED LOCALLY"} · EDITS CHANGE CACHE ID</div>
        <button className="save-script" onClick={() => void saveScriptDraft()} disabled={!draftChanged}>Save cited script draft</button>

        {provider === "device" ? (
          <>
            <label className="voice-field">Voice installed on this device
              <select value={voice} onChange={(event) => setVoice(event.target.value)}>
                {deviceVoices.map((candidate) => <option key={candidate.voiceURI} value={candidate.voiceURI}>{candidate.name} · {candidate.lang}</option>)}
              </select>
            </label>
            <div className="narration-actions">
              {playback === "idle" ? <button className="primary" onClick={playDevice} disabled={!currentCapability?.available}>Preview section</button> : <button className="primary" onClick={pauseOrResumeDevice}>{playback === "playing" ? "Pause" : "Resume"}</button>}
              {playback !== "idle" && <button onClick={stopDevice}>Stop</button>}
            </div>
          </>
        ) : (
          <>
            <label className="voice-field">Voice ID<input value={voice} onChange={(event) => setVoice(event.target.value)} placeholder={provider === "openai" ? "coral" : "ElevenLabs voice ID"} /></label>
            {provider === "openai" && <label className="voice-field">Delivery instructions<input value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>}
            {window.scribeRuntime?.setProviderKey && (
              <details className="key-manager" open={!currentCapability?.available}>
                <summary>{savedInKeychain ? "Manage encrypted provider key" : "Add provider key to OS keychain"}</summary>
                <div className="key-field">
                  <label>API key · never stored in SQLite<input type="password" value={key} autoComplete="off" onChange={(event) => setKey(event.target.value)} /></label>
                  <button onClick={() => void saveKey()} disabled={!key.trim() || !keyStatus?.secureStorage}>{savedInKeychain ? "Replace" : "Save"}</button>
                </div>
                {savedInKeychain && <button className="remove-key" onClick={() => void deleteKey()}>Remove saved key</button>}
              </details>
            )}
            <div className="narration-actions">
              <button className="primary" onClick={() => void generateAudio()} disabled={!providerGenerationAllowed || !currentCapability?.available || !voice.trim() || job?.status === "running" || job?.status === "queued"}>Generate & cache section</button>
              {(job?.status === "queued" || job?.status === "running") && <button onClick={() => void cancelAudio()}>Cancel</button>}
            </div>
          </>
        )}

        {audioSource && <audio ref={audioRef} src={audioSource} controls onTimeUpdate={(event) => {
          const currentTime = event.currentTarget.currentTime;
          const span = job?.artifact?.timings.find(({ startSeconds, endSeconds }) => currentTime >= startSeconds && currentTime < endSeconds);
          setHighlightRange(span?.characterRange);
        }} />}
        {job?.artifact && <p className="disclosure">{job.artifact.disclosure}</p>}
        <p className="narration-status" role="status">{message}</p>
        <p className="codex-capability">Codex script assistance: {capabilities?.codex.state ?? "checking"}. Codex is never presented as a voice provider.</p>
      </div>
    </details>
  );
}

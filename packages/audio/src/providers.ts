import type { NarrationArtifact, NarrationRequest, VoiceCapability, VoiceProvider } from "./contracts.ts";

const disclosure = "This audio uses an AI-generated voice and is not a human recording.";

export class OpenAiVoiceProvider implements VoiceProvider {
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(apiKey = process.env.OPENAI_API_KEY, fetcher = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  capability(): VoiceCapability {
    return this.apiKey
      ? { provider: "openai", available: true, requiresApiKey: true, timingQuality: "none", streaming: true, maxCharacters: 4096 }
      : { provider: "openai", available: false, requiresApiKey: true, timingQuality: "none", streaming: true, maxCharacters: 4096, reason: "OpenAI API key is not configured" };
  }

  async synthesize(request: NarrationRequest, signal?: AbortSignal): Promise<NarrationArtifact> {
    if (!this.apiKey) throw new Error(this.capability().reason);
    if (request.script.readingText.length > 4096) throw new Error("OpenAI speech input exceeds the 4,096 character limit");
    const response = await this.fetcher("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      signal,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: request.model ?? "gpt-4o-mini-tts",
        voice: request.voice,
        input: request.script.readingText,
        instructions: request.instructions,
        response_format: request.format,
      }),
    });
    if (!response.ok) throw new Error(`OpenAI speech failed with status ${response.status}`);
    const mimeType = request.format === "wav" ? "audio/wav" : "audio/mpeg";
    const responseType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (responseType && responseType !== mimeType && responseType !== "application/octet-stream") {
      throw new Error(`OpenAI speech returned unexpected content type ${responseType}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error("OpenAI speech returned an empty audio artifact");
    return { mimeType, bytes, timingQuality: "none", timings: [], disclosure };
  }
}

interface ElevenLabsTimedResponse {
  audio_base64?: unknown;
  alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
}

function decodeBase64Audio(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.trim()) throw new Error("ElevenLabs speech returned no audio data");
  const compact = value.replace(/\s/g, "");
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("ElevenLabs speech returned invalid base64 audio data");
  }
  const bytes = Uint8Array.from(Buffer.from(compact, "base64"));
  if (bytes.byteLength === 0) throw new Error("ElevenLabs speech returned an empty audio artifact");
  return bytes;
}

function exactCharacterTimings(
  alignment: ElevenLabsTimedResponse["alignment"],
  readingText: string,
): NarrationArtifact["timings"] {
  if (!alignment || alignment.characters.join("") !== readingText) return [];
  if (
    alignment.characters.length !== alignment.character_start_times_seconds.length ||
    alignment.characters.length !== alignment.character_end_times_seconds.length
  ) return [];
  const timings: NarrationArtifact["timings"] = [];
  let characterOffset = 0;
  let previousStart = 0;
  for (const [index, text] of alignment.characters.entries()) {
    const startSeconds = alignment.character_start_times_seconds[index];
    const endSeconds = alignment.character_end_times_seconds[index];
    const start = characterOffset;
    characterOffset += text.length;
    if (
      typeof startSeconds !== "number" || !Number.isFinite(startSeconds) || startSeconds < 0 ||
      typeof endSeconds !== "number" || !Number.isFinite(endSeconds) || endSeconds < startSeconds ||
      startSeconds < previousStart
    ) return [];
    previousStart = startSeconds;
    timings.push({ text, startSeconds, endSeconds, characterRange: { start, end: characterOffset } });
  }
  return timings;
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(apiKey = process.env.ELEVENLABS_API_KEY, fetcher = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  capability(): VoiceCapability {
    return this.apiKey
      ? { provider: "elevenlabs", available: true, requiresApiKey: true, timingQuality: "exact-character", streaming: false }
      : { provider: "elevenlabs", available: false, requiresApiKey: true, timingQuality: "exact-character", streaming: false, reason: "ElevenLabs API key is not configured" };
  }

  async synthesize(request: NarrationRequest, signal?: AbortSignal): Promise<NarrationArtifact> {
    if (!this.apiKey) throw new Error(this.capability().reason);
    if (request.format !== "mp3") throw new Error("ElevenLabs timestamped narration currently supports MP3 output only");
    const response = await this.fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(request.voice)}/with-timestamps?output_format=mp3_44100_128`, {
      method: "POST",
      signal,
      headers: { "xi-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text: request.script.readingText, model_id: request.model ?? "eleven_multilingual_v2" }),
    });
    if (!response.ok) throw new Error(`ElevenLabs speech failed with status ${response.status}`);
    const payload = await response.json() as ElevenLabsTimedResponse;
    const bytes = decodeBase64Audio(payload.audio_base64);
    const timings = exactCharacterTimings(payload.alignment, request.script.readingText);
    return { mimeType: "audio/mpeg", bytes, timingQuality: timings.length ? "exact-character" : "none", timings, disclosure };
  }
}

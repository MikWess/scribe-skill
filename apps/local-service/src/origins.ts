/** Match the reader port without opening CORS to arbitrary sites. Explicit overrides win. */
export function readerOrigins(env: Record<string, string | undefined>): string[] {
  if (env.SCRIBE_SKILL_ALLOWED_ORIGINS !== undefined) {
    return env.SCRIBE_SKILL_ALLOWED_ORIGINS.split(",").map(value => value.trim()).filter(Boolean);
  }
  const port = Number(env.SCRIBE_SKILL_UI_PORT ?? 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SCRIBE_SKILL_UI_PORT must be a valid port");
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

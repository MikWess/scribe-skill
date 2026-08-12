# ADR 0003: Package the reader with its local service

## Status

Accepted for PR 2.

## Context

The reader must work as a desktop app without asking a user to install Node or start a developer service. The same React UI must remain usable in a browser for optional read-along and note workflows. PDF rendering currently depends on PDF.js, Node SQLite, and a native canvas module.

## Decision

Use Electron as the desktop host for the current implementation. The main process:

- creates a random 256-bit token on every launch;
- starts the HTTP service on loopback and an operating-system-assigned port;
- owns the SQLite/content-addressed library under application data;
- exposes only the service URL and ephemeral token through a sandboxed preload bridge;
- denies renderer permission requests, new windows, and external navigation;
- applies a CSP limited to the packaged UI, blobs, and loopback service; and
- closes the HTTP service and database before quitting.

The browser development surface starts the same service explicitly. Its predictable token is available only when `SCRIBE_SKILL_ALLOW_INSECURE_DEV_TOKEN=1` is set, and allowed browser origins are enumerated.

## Consequences

The desktop artifact is larger than a Tauri shell, but it is standalone and reuses the tested Node PDF/SQLite implementation. A thinner native host can replace Electron later only if it preserves the no-sidecar-install contract and the same local API. Release signing, installers, and per-platform build jobs remain hardening work.

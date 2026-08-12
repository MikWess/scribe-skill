# ADR 0001: Evidence and execution contracts come first

**Status:** Accepted

Every derived object starts with an `EvidenceAnchor`; a graph, audio highlight, answer, or exported skill may only be marked supported when it has one. Execution is explicit: Offline, BYOK, or Codex-session. The Codex-session adapter is capability-gated and never silently replaces itself with an API-key path.

This makes the safe, inspectable path testable before adding PDF, voice, graph, or UI implementations.

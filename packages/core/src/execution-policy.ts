import type { EgressRequest, ExecutionPolicy } from "./contracts.js";

export interface EgressDecision {
  allowed: boolean;
  reason: string;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/** Single enforcement boundary for provider and agent network adapters. */
export function authorizeEgress(policy: ExecutionPolicy, request: EgressRequest): EgressDecision {
  let url: URL;
  try {
    url = new URL(request.destination);
  } catch {
    return { allowed: false, reason: "Destination must be an absolute URL" };
  }

  if (isLoopback(url.hostname)) return { allowed: true, reason: "Loopback destination" };
  if (policy.mode === "offline") {
    return { allowed: false, reason: "Strict offline mode blocks non-loopback egress" };
  }
  if (!policy.allowedHosts.includes(url.hostname)) {
    return { allowed: false, reason: "Destination is not on the provider allowlist" };
  }
  if (!request.approvalReceiptId || !policy.approvedReceiptIds.includes(request.approvalReceiptId)) {
    return { allowed: false, reason: "Approved egress receipt is required" };
  }
  if (request.evidenceAnchorIds.length === 0) {
    return { allowed: false, reason: "Egress receipt must identify exact source evidence" };
  }
  return { allowed: true, reason: "Allowlisted BYOK request with an approved receipt" };
}

import type { EvidenceAnchor } from "@scribe-skill/core";

export type InquiryRouteId = "understand" | "challenge" | "apply" | "reflect";
export type InquiryMove = "deepen" | "challenge" | "connect" | "apply" | "synthesize" | "complete";
export type InquiryResponseKind = "grounded-interpretation" | "personal-reflection";
export type InquiryStatus = "active" | "completed";

export interface InquiryRoute {
  id: InquiryRouteId;
  version: 1;
  title: string;
  description: string;
  openingPrompt: string;
  suggestedMoves: Exclude<InquiryMove, "complete">[];
}

export interface InquiryEvidence {
  passageId: string;
  sectionId: string;
  sectionTitle: string;
  pages: [number, number];
  contentHash: string;
  preferredEvidenceId: string;
  evidence: EvidenceAnchor[];
  snippet: string;
}

export interface InquiryStep {
  id: string;
  sequence: number;
  prompt: string;
  purpose: string;
  status: "pending" | "answered";
  response?: string;
  responseKind?: InquiryResponseKind;
  evidencePassageIds: string[];
  nextMove?: InquiryMove;
  createdAt: string;
  answeredAt?: string;
  updatedAt?: string;
}

export interface InquirySession {
  schemaVersion: "1";
  id: string;
  documentId: string;
  documentHash: string;
  corpusRevision: number;
  route: InquiryRoute;
  objective: string;
  title: string;
  status: InquiryStatus;
  stale: boolean;
  staleReason?: string;
  evidence: InquiryEvidence[];
  steps: InquiryStep[];
  currentStepId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateInquiryInput {
  documentId: string;
  routeId: InquiryRouteId;
  objective: string;
  title?: string;
  maxEvidenceCharacters?: number;
}

export interface AnswerInquiryInput {
  response: string;
  responseKind: InquiryResponseKind;
  evidencePassageIds?: string[];
  nextMove: InquiryMove;
}

export const inquiryRoutes: InquiryRoute[] = [
  {
    id: "understand",
    version: 1,
    title: "Understand an idea",
    description: "Reconstruct what the author means, identify its support, and state its limits before summarizing it.",
    openingPrompt: "Using the cited passages, state the author's central claim about this objective in your own words. What in the source supports that reading?",
    suggestedMoves: ["deepen", "connect", "challenge", "synthesize"],
  },
  {
    id: "challenge",
    version: 1,
    title: "Challenge a claim",
    description: "Surface assumptions, look for counterevidence, and describe what should change your conclusion.",
    openingPrompt: "What is the strongest version of the author's claim relevant to this objective, and which cited passage makes that version strongest?",
    suggestedMoves: ["challenge", "deepen", "connect", "synthesize"],
  },
  {
    id: "apply",
    version: 1,
    title: "Apply a framework",
    description: "Translate a book idea into a concrete decision while preserving its assumptions and failure conditions.",
    openingPrompt: "Describe the real situation you want to change, then identify the cited idea that appears most useful. Keep your situation separate from what the author actually claims.",
    suggestedMoves: ["apply", "challenge", "deepen", "synthesize"],
  },
  {
    id: "reflect",
    version: 1,
    title: "Reflect through the book",
    description: "Use the source as a lens for experience without confusing personal memory with book evidence.",
    openingPrompt: "Reconstruct the situation or belief you want to examine. Which cited idea offers a useful lens, and which details come only from your own experience?",
    suggestedMoves: ["deepen", "connect", "challenge", "synthesize"],
  },
];

export function inquiryRoute(routeId: string): InquiryRoute | undefined {
  return inquiryRoutes.find(({ id }) => id === routeId);
}

export function nextInquiryPrompt(move: Exclude<InquiryMove, "complete">, objective: string): { prompt: string; purpose: string } {
  const prompts = {
    deepen: {
      prompt: `Which part of your last answer about “${objective}” is least precise? Return to the cited wording, distinguish observation from inference, and revise that part.`,
      purpose: "Make the interpretation more precise.",
    },
    challenge: {
      prompt: `What assumption or counterexample most threatens your current view of “${objective}”? Say what evidence would make you change your mind.`,
      purpose: "Test the conclusion instead of defending it.",
    },
    connect: {
      prompt: `How does your current answer about “${objective}” connect to another cited passage or chapter? Explain the relationship and where the connection becomes uncertain.`,
      purpose: "Connect ideas without hiding inference.",
    },
    apply: {
      prompt: `Apply the cited idea about “${objective}” to one concrete decision. What action follows, and what source limitation could make that application fail?`,
      purpose: "Turn context into a bounded application.",
    },
    synthesize: {
      prompt: `Write the strongest conclusion you can now support about “${objective}”. Separate the author's claim, your interpretation, your own experience, and what remains unresolved.`,
      purpose: "Produce a provenance-aware synthesis.",
    },
  } as const;
  return prompts[move];
}

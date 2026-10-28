import type { SourceRegistry } from "../agent/sources";
import type { TokenUsage } from "../llm/pricing";

export interface ClaimCheck {
  claim: string;
  sourceIds: string[];
  verdict: "supported" | "unsupported" | "uncited" | "bad_id" | "skipped";
  score?: number;
  why?: string;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
  checks: ClaimCheck[];
  usage?: TokenUsage;
  costUsd?: number;
}

/** Checks a drafted answer against the sources it cites. Stage 4 uses the structural one; stage 6 adds real support checks. */
export type Verifier = (answer: string, registry: SourceRegistry) => Promise<VerifyResult>;

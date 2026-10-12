import type { InterviewStatus } from "@cdf/contracts";

/** Badge tone per interview status. The status text is always shown too, so colour is never the only cue. */
export function interviewStatusTone(status: InterviewStatus) {
  if (status === "APPROVED") return "success" as const;
  if (status === "CANCELLED") return "neutral" as const;
  if (status === "PREPARED" || status === "REVIEWED") return "warning" as const;
  return "info" as const;
}

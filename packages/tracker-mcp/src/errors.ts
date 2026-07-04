/**
 * Typed Tracker errors translated into model-friendly messages.
 * The MCP tool layer converts these into actionable text for the LLM — never
 * raw HTTP bodies.
 */

export type TrackerErrorKind =
  | "no_credential"
  | "auth"
  | "not_found"
  | "rate_limited"
  | "validation"
  | "upstream"
  | "network"
  | "unknown"

export class TrackerError extends Error {
  readonly kind: TrackerErrorKind
  readonly status?: number
  constructor(kind: TrackerErrorKind, message: string, status?: number) {
    super(message)
    this.name = "TrackerError"
    this.kind = kind
    this.status = status
  }
}

export const NO_CREDENTIAL = new TrackerError(
  "no_credential",
  "No Tracker credential was presented. In stdio mode set TRACKER_TOKEN and TRACKER_ORG_ID; in HTTP mode send Authorization: OAuth <token> and X-Org-ID headers.",
)

/** Build a TrackerError from a fetch Response (body already consumed as text). */
export async function errorFromResponse(resp: Response, body: string): Promise<TrackerError> {
  const status = resp.status
  const hint = body ? ` Tracker replied: ${body.slice(0, 300)}` : ""
  if (status === 401) {
    return new TrackerError("auth", `Authorization failed (401). The token is invalid or expired — refresh it and retry.${hint}`, status)
  }
  if (status === 403) {
    return new TrackerError("auth", `Forbidden (403). The token lacks the required Tracker rights, or the org id / org header (X-Org-ID vs X-Cloud-Org-ID) is wrong.${hint}`, status)
  }
  if (status === 404) {
    return new TrackerError("not_found", `Not found (404). The issue, queue, or resource does not exist, or is outside this user's scope.${hint}`, status)
  }
  if (status === 422 || status === 400) {
    return new TrackerError("validation", `Tracker rejected the request (${status}). Check the fields and values.${hint}`, status)
  }
  if (status === 429) {
    return new TrackerError("rate_limited", `Rate limited (429). Pause and retry shortly; reduce call frequency.${hint}`, status)
  }
  if (status >= 500) {
    return new TrackerError("upstream", `Tracker is unavailable (${status}). Retry with backoff.${hint}`, status)
  }
  return new TrackerError("unknown", `Unexpected Tracker response (${status}).${hint}`, status)
}

export function networkError(cause: unknown): TrackerError {
  const msg = cause instanceof Error ? cause.message : String(cause)
  return new TrackerError("network", `Network error reaching Tracker: ${msg}`)
}

/** A human-readable line an LLM can act on, including the suggested next step. */
export function describeError(err: TrackerError): string {
  return err.message
}

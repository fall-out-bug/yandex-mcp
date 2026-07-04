/**
 * Per-user-credential resolution.
 *
 * The server holds NO token. A credential is resolved per tool call:
 *  - stdio transport: from process env (single-user mode for local clients).
 *  - HTTP transport:  from the request headers (Authorization + X-Org-ID),
 *                     via AsyncLocalStorage — one credential per request = the
 *                     calling user's own scope.
 *
 * This is the security core: the user's scope is the user's own credential,
 * never a shared org-wide token reversed out of a broad-access tool.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { TrackerError, NO_CREDENTIAL } from "./errors.js"

export const DEFAULT_BASE_URL = "https://api.tracker.yandex.net/v3"

export type TrackerCredential = {
  token: string
  orgId: string
  /** "X-Org-ID" for Yandex 360 orgs, "X-Cloud-Org-ID" for Yandex Cloud orgs. */
  orgHeader: "X-Org-ID" | "X-Cloud-Org-ID"
  baseUrl: string
  authScheme: "OAuth" | "Bearer"
}

const requestCredential = new AsyncLocalStorage<TrackerCredential>()

/** Read the single-user credential from process env. Returns null if unset. */
export function readEnvCredential(): TrackerCredential | null {
  const token = process.env.TRACKER_TOKEN?.trim()
  const orgId = process.env.TRACKER_ORG_ID?.trim()
  if (!token || !orgId) return null
  const header = process.env.TRACKER_ORG_HEADER?.trim()
  return {
    token,
    orgId,
    orgHeader: header === "X-Cloud-Org-ID" ? "X-Cloud-Org-ID" : "X-Org-ID",
    baseUrl: process.env.TRACKER_BASE_URL?.trim() || DEFAULT_BASE_URL,
    authScheme: process.env.TRACKER_AUTH_SCHEME?.trim() === "Bearer" ? "Bearer" : "OAuth",
  }
}

/** Resolve the active credential for the current call (HTTP request scope, else env). */
export function getCredential(): TrackerCredential {
  const fromRequest = requestCredential.getStore()
  if (fromRequest) return fromRequest
  const fromEnv = readEnvCredential()
  if (fromEnv) return fromEnv
  throw NO_CREDENTIAL
}

/** Build a credential from HTTP request headers (org/multi-user mode). */
export function credentialFromHeaders(headers: Headers): TrackerCredential | null {
  const auth = headers.get("authorization")
  if (!auth) return null
  // Accept "OAuth <token>" (Tracker convention) or "Bearer <token>" (IAM).
  const token = auth.replace(/^(OAuth|Bearer)\s+/i, "").trim()
  const orgId = headers.get("x-org-id")?.trim() || headers.get("x-cloud-org-id")?.trim() || ""
  if (!token || !orgId) return null
  return {
    token,
    orgId,
    orgHeader: headers.get("x-cloud-org-id") ? "X-Cloud-Org-ID" : "X-Org-ID",
    baseUrl: process.env.TRACKER_BASE_URL?.trim() || DEFAULT_BASE_URL,
    authScheme: /^Bearer/i.test(auth) ? "Bearer" : "OAuth",
  }
}

/**
 * Build a credential from a Yandex access token resolved server-side by the
 * OAuth gate (standalone profile). The org id / header still come from env
 * (`TRACKER_ORG_ID` / `TRACKER_ORG_HEADER`), since those are per-deployment.
 * The token uses the `OAuth` scheme (Yandex direct — no IAM exchange).
 */
export function credentialFromYandexToken(yandexAccessToken: string): TrackerCredential | null {
  if (!yandexAccessToken) return null
  const orgId = process.env.TRACKER_ORG_ID?.trim()
  if (!orgId) return null
  const header = process.env.TRACKER_ORG_HEADER?.trim()
  return {
    token: yandexAccessToken,
    orgId,
    orgHeader: header === "X-Cloud-Org-ID" ? "X-Cloud-Org-ID" : "X-Org-ID",
    baseUrl: process.env.TRACKER_BASE_URL?.trim() || DEFAULT_BASE_URL,
    authScheme: "OAuth",
  }
}

/** Run a handler with a request-scoped credential (used by the HTTP transport). */
export function withCredential<T>(cred: TrackerCredential, fn: () => Promise<T>): Promise<T> {
  return requestCredential.run(cred, fn)
}

export { TrackerError }

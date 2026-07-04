/**
 * Yandex OAuth (upstream) HTTP bridge.
 *
 * Our authorization server acts as a *confidential OAuth client* of Yandex.
 * All network calls to Yandex live here so the provider/callback/store stay
 * free of fetch details and are trivially mockable in tests.
 *
 * Verified Yandex facts:
 *  - Authorize: https://oauth.yandex.ru/authorize
 *  - Token:     https://oauth.yandex.ru/token   (application/x-www-form-urlencoded)
 *  - Scopes:    cloud:auth tracker:read tracker:write  (cloud:auth is the critical one)
 *  - grant_type=authorization_code: client_id+client_secret+redirect_uri+code
 *  - grant_type=refresh_token:    client_id+client_secret+refresh_token
 *  - Resulting token works DIRECTLY against Tracker (Authorization: OAuth <token>
 *    + X-Cloud-Org-Id / X-Org-Id). No IAM exchange.
 */
export const YANDEX_AUTHORIZE_URL = "https://oauth.yandex.ru/authorize"
export const YANDEX_TOKEN_URL = "https://oauth.yandex.ru/token"
export const YANDEX_SCOPES = ["cloud:auth", "tracker:read", "tracker:write"]

/** A Yandex access/refresh pair obtained from the token endpoint. */
export type YandexTokens = {
  accessToken: string
  refreshToken: string
  /** Seconds until the access token expires. */
  expiresIn: number
}

export type YandexClientCredentials = {
  clientId: string
  clientSecret: string
}

/** Build the Yandex authorize URL the user's browser is sent to (leg B start). */
export function buildYandexAuthorizeUrl(params: {
  clientId: string
  redirectUri: string
  state: string
  scopes?: string[]
  codeChallenge?: string
}): string {
  const url = new URL(YANDEX_AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", params.clientId)
  url.searchParams.set("redirect_uri", params.redirectUri)
  url.searchParams.set("state", params.state)
  url.searchParams.set("scope", (params.scopes ?? YANDEX_SCOPES).join(" "))
  // Defense-in-depth PKCE on the Yandex leg (optional for a confidential client).
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge)
    url.searchParams.set("code_challenge_method", "S256")
  }
  return url.href
}

async function parseYandexTokenResponse(resp: Response): Promise<YandexTokens> {
  const text = await resp.text()
  if (!resp.ok) {
    throw new Error(`Yandex token exchange failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  // Yandex returns JSON for the code/refresh flows.
  let body: Record<string, unknown>
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Some Yandex responses are form-encoded; tolerate that.
    body = Object.fromEntries(new URLSearchParams(text)) as Record<string, unknown>
  }
  const accessToken = body.access_token
  const refreshToken = body.refresh_token
  const expiresIn = body.expires_in
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new Error(`Yandex token response missing access_token/refresh_token: ${text.slice(0, 300)}`)
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: typeof expiresIn === "number" ? expiresIn : Number(expiresIn) || 3600,
  }
}

/** Exchange a Yandex authorization code for a Yandex access+refresh token (callback leg). */
export async function exchangeYandexAuthorizationCode(params: {
  code: string
  redirectUri: string
  client: YandexClientCredentials
  codeVerifier?: string
  fetch?: typeof fetch
}): Promise<YandexTokens> {
  const fetchFn = params.fetch ?? fetch
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: params.client.clientId,
    client_secret: params.client.clientSecret,
    redirect_uri: params.redirectUri,
  })
  if (params.codeVerifier) body.set("code_verifier", params.codeVerifier)
  const resp = await fetchFn(YANDEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  return parseYandexTokenResponse(resp)
}

/** Refresh a Yandex access token using a stored Yandex refresh token. */
export async function refreshYandexToken(params: {
  refreshToken: string
  client: YandexClientCredentials
  fetch?: typeof fetch
}): Promise<YandexTokens> {
  const fetchFn = params.fetch ?? fetch
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.client.clientId,
    client_secret: params.client.clientSecret,
  })
  const resp = await fetchFn(YANDEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  })
  return parseYandexTokenResponse(resp)
}

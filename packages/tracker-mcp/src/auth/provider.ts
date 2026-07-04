/**
 * Custom MCP OAuth authorization-server provider for tracker-mcp.
 *
 * This is NOT `ProxyOAuthServerProvider` (which would forward the upstream
 * token unchanged — forbidden here). We issue our OWN opaque MCP tokens and
 * keep the Yandex token server-side, mapped via the {@link AuthStore}.
 *
 * Flow:
 *   1. authorize()           — redirect the user's browser to Yandex, recording
 *                               the MCP client's PKCE challenge + redirect target.
 *   2. (callback.ts)         — Yandex redirects back; we exchange its code for a
 *                               Yandex token (stored) and redirect to the MCP
 *                               client with a one-time MCP authorization code.
 *   3. exchangeAuthorizationCode() — mint an opaque MCP access+refresh token,
 *                               bound to the stored Yandex token.
 *   4. exchangeRefreshToken()      — rotate the MCP refresh token.
 *   5. verifyAccessToken()         — resolve an MCP token to the user's Yandex
 *                               token (refreshing Yandex if near expiry). Called
 *                               by the /mcp resource-server gate, not the AS.
 */
import { randomBytes, createHash } from "node:crypto"
import type { Response } from "express"
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js"
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js"
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js"
import { AuthStore } from "./store.js"
import {
  buildYandexAuthorizeUrl,
  exchangeYandexAuthorizationCode,
  refreshYandexToken,
  YANDEX_SCOPES,
  type YandexClientCredentials,
} from "./yandex.js"

export type TrackerOAuthConfig = {
  /** The deployer's Yandex OAuth app credentials (external app). */
  yandex: YandexClientCredentials
  /** Public base URL of this server (must be reachable by Yandex for the callback). */
  publicUrl: URL
  /** Path at which the Yandex callback route is mounted. */
  callbackPath: string
  /** Scopes to request from Yandex. */
  scopes?: string[]
}

/** PKCE pair for the Yandex leg (defense-in-depth; confidential client). */
function yandexPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export class TrackerOAuthProvider implements OAuthServerProvider {
  readonly store: AuthStore
  private readonly config: TrackerOAuthConfig
  private readonly fetchImpl?: typeof fetch

  constructor(config: TrackerOAuthConfig, store?: AuthStore, fetchImpl?: typeof fetch) {
    this.config = config
    this.store = store ?? new AuthStore()
    this.fetchImpl = fetchImpl
  }

  private get callbackUrl(): string {
    return new URL(this.config.callbackPath, this.config.publicUrl).href
  }

  private get scopes(): string[] {
    return this.config.scopes ?? YANDEX_SCOPES
  }

  /** The resolved config (read-only). */
  get oauthConfig(): TrackerOAuthConfig {
    return this.config
  }

  /** Scopes advertised to MCP clients. */
  get scopesSupported(): string[] {
    return this.scopes
  }

  // The SDK reads this to look up / register DCR clients and to gate /register.
  get clientsStore() {
    return {
      getClient: (id: string) => this.store.getClient(id),
      registerClient: (client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) =>
        this.store.registerClient(client),
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Leg B PKCE (optional for a confidential client, used for defense-in-depth).
    const { verifier: yandexCodeVerifier, challenge: yandexChallenge } = yandexPkcePair()

    const loginState = this.store.createLoginState({
      mcpRedirectUri: params.redirectUri,
      mcpState: params.state,
      codeChallenge: params.codeChallenge,
      clientId: client.client_id,
      scopes: params.scopes?.length ? params.scopes : this.scopes,
      resource: params.resource,
      yandexCodeVerifier,
    })

    const yandexUrl = buildYandexAuthorizeUrl({
      clientId: this.config.yandex.clientId,
      redirectUri: this.callbackUrl,
      state: loginState,
      scopes: this.scopes,
      codeChallenge: yandexChallenge,
    })

    // Send the user's browser to Yandex. The MCP client's redirect happens later,
    // from the Yandex callback, once we hold a Yandex token.
    res.redirect(302, yandexUrl)
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const challenge = this.store.challengeForCode(authorizationCode)
    if (challenge === undefined) throw new InvalidGrantError("Unknown or consumed authorization code")
    return challenge
  }

  async exchangeAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const loginState = this.store.getLoginForCode(authorizationCode)
    if (!loginState) throw new InvalidGrantError("Unknown authorization code")
    const issued = this.store.issueMcpTokens(loginState)
    // Single-use regardless of success.
    this.store.consumeAuthCode(authorizationCode)
    if (!issued) {
      throw new InvalidGrantError("Authorization code has no captured Yandex token (callback did not complete)")
    }
    return {
      access_token: issued.accessToken,
      refresh_token: issued.refreshToken,
      token_type: "bearer",
      expires_in: Math.max(1, Math.floor((issued.entry.mcpExpiresAt - Date.now()) / 1000)),
      scope: issued.entry.scopes.join(" "),
    }
  }

  async exchangeRefreshToken(
    _client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    _resource?: URL,
  ): Promise<OAuthTokens> {
    const reissued = this.store.reissueFromRefresh(refreshToken)
    if (!reissued) throw new InvalidGrantError("Unknown or already-used refresh token")
    return {
      access_token: reissued.accessToken,
      refresh_token: reissued.refreshToken,
      token_type: "bearer",
      expires_in: Math.max(1, Math.floor((reissued.entry.mcpExpiresAt - Date.now()) / 1000)),
      scope: reissued.entry.scopes.join(" "),
    }
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.store.getEntry(token)
    if (!entry) throw new InvalidTokenError("Invalid MCP access token")

    // Refresh the Yandex token server-side if it is about to expire. The refreshed
    // token never leaves this method — it is stored back on the entry.
    if (this.store.needsYandexRefresh(entry)) {
      try {
        const fresh = await refreshYandexToken({
          refreshToken: entry.yandexRefreshToken,
          client: this.config.yandex,
          fetch: this.fetchImpl,
        })
        this.store.updateYandex(entry, fresh)
      } catch {
        throw new InvalidTokenError("Upstream Yandex token could not be refreshed")
      }
    }

    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: Math.floor(entry.mcpExpiresAt / 1000),
      resource: entry.resource,
      // Server-side only: consumed by the /mcp gate to build the TrackerCredential.
      // This is the ONLY path by which the Yandex token reaches a Tracker call.
      extra: { yandexAccessToken: entry.yandexAccessToken, loginState: entry.loginState },
    }
  }

  /** Exposed for the callback route to exchange a Yandex code server-side. */
  async exchangeYandexCode(code: string, loginState: string): Promise<void> {
    const ctx = this.store.getLoginState(loginState)
    if (!ctx) throw new ServerError("Unknown login state on Yandex callback")
    const tokens = await exchangeYandexAuthorizationCode({
      code,
      redirectUri: this.callbackUrl,
      client: this.config.yandex,
      codeVerifier: ctx.yandexCodeVerifier,
      fetch: this.fetchImpl,
    })
    this.store.setYandexForLogin(loginState, tokens)
  }
}

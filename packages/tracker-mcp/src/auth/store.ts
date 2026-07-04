/**
 * In-memory authorization state (v0.2).
 *
 * This is the security core of the standalone OAuth profile. It holds, entirely
 * server-side:
 *   - dynamically registered MCP OAuth clients (DCR);
 *   - in-flight login states (the bridge between the MCP authorize request and
 *     the Yandex callback);
 *   - one-time MCP authorization codes;
 *   - MCP access tokens  ->  { yandex access, yandex refresh, expiry, scopes }.
 *
 * The MCP access/refresh tokens issued here are opaque random strings minted by
 * THIS server. They are NOT Yandex tokens. The Yandex token is stored only here
 * and resolved server-side per tool call, so it never reaches the MCP client
 * (no token passthrough — MCP spec requirement).
 *
 * Persistence is intentionally out of scope for v0.2 (state is lost on restart).
 */
import { randomBytes } from "node:crypto"
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js"
import type { YandexTokens } from "./yandex.js"

/** Refresh a Yandex token when it has less than this long to live. */
export const YANDEX_REFRESH_SKEW_MS = 60_000

/** Lifetime of an MCP access token (seconds). Clients refresh before this. */
export const MCP_ACCESS_TTL_S = 3600

export type LoginContext = {
  /** The MCP client's redirect_uri (where we eventually send the MCP auth code). */
  mcpRedirectUri: string
  /** The MCP client's opaque `state` to echo back on the final redirect. */
  mcpState?: string
  /** PKCE code_challenge from the MCP client (leg A). */
  codeChallenge: string
  /** The registered MCP client that started this login. */
  clientId: string
  scopes: string[]
  resource?: URL
  /** PKCE verifier for the Yandex leg (leg B, defense-in-depth). */
  yandexCodeVerifier?: string
  /** Yandex tokens captured by the callback. Set once the user returns from Yandex. */
  yandex?: YandexTokens
}

export type TokenEntry = {
  /** The Yandex access token used for Tracker calls (server-side only). */
  yandexAccessToken: string
  yandexRefreshToken: string
  /** Epoch milliseconds when the Yandex access token expires. */
  yandexExpiresAt: number
  scopes: string[]
  clientId: string
  resource?: URL
  loginState: string
  /** Epoch milliseconds when this MCP access token expires. */
  mcpExpiresAt: number
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("hex")}`
}

export class AuthStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>()
  private readonly loginStates = new Map<string, LoginContext>()
  private readonly authCodes = new Map<string, string /* loginState */>()
  private readonly tokens = new Map<string, TokenEntry>()
  private readonly refreshTokens = new Map<string, string /* accessToken */>()

  // --- DCR clients ---------------------------------------------------------

  registerClient(meta: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const client: OAuthClientInformationFull = {
      ...meta,
      client_id: randomToken("mcp_client"),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }
    this.clients.set(client.client_id, client)
    return client
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId)
  }

  // --- login state (authorize -> callback) ---------------------------------

  /** Create a new login state capturing the MCP client's authorize params. */
  createLoginState(ctx: Omit<LoginContext, "yandex">): string {
    const id = randomToken("mcp_login")
    this.loginStates.set(id, ctx)
    return id
  }

  getLoginState(state: string): LoginContext | undefined {
    return this.loginStates.get(state)
  }

  /** Record the Yandex tokens obtained by the callback against a login state. */
  setYandexForLogin(state: string, yandex: YandexTokens): LoginContext | undefined {
    const ctx = this.loginStates.get(state)
    if (!ctx) return undefined
    ctx.yandex = yandex
    return ctx
  }

  // --- MCP authorization codes (issued after the Yandex callback) ----------

  /** Bind a one-time MCP authorization code to a login state. */
  issueAuthCode(loginState: string): string {
    const code = randomToken("mcp_code")
    this.authCodes.set(code, loginState)
    return code
  }

  getLoginForCode(code: string): string | undefined {
    return this.authCodes.get(code)
  }

  /** Look up the PKCE challenge for a code (SDK validates code_verifier against it). */
  challengeForCode(code: string): string | undefined {
    const loginState = this.authCodes.get(code)
    if (!loginState) return undefined
    return this.loginStates.get(loginState)?.codeChallenge
  }

  /** Delete a consumed authorization code (single use). */
  consumeAuthCode(code: string): void {
    this.authCodes.delete(code)
  }

  // --- MCP access / refresh tokens ----------------------------------------

  /**
   * Mint an opaque MCP access+refresh token pair bound to the Yandex tokens
   * captured under the given login state. The login state must already have
   * its `yandex` tokens set by the callback.
   */
  issueMcpTokens(loginState: string): { accessToken: string; refreshToken: string; entry: TokenEntry } | undefined {
    const ctx = this.loginStates.get(loginState)
    if (!ctx?.yandex) return undefined
    const accessToken = randomToken("mcp_at")
    const refreshToken = randomToken("mcp_rt")
    const entry: TokenEntry = {
      yandexAccessToken: ctx.yandex.accessToken,
      yandexRefreshToken: ctx.yandex.refreshToken,
      yandexExpiresAt: Date.now() + ctx.yandex.expiresIn * 1000,
      scopes: ctx.scopes,
      clientId: ctx.clientId,
      resource: ctx.resource,
      loginState,
      mcpExpiresAt: Date.now() + MCP_ACCESS_TTL_S * 1000,
    }
    this.tokens.set(accessToken, entry)
    this.refreshTokens.set(refreshToken, accessToken)
    return { accessToken, refreshToken, entry }
  }

  getEntry(accessToken: string): TokenEntry | undefined {
    return this.tokens.get(accessToken)
  }

  /** Resolve an MCP access token from a refresh token. */
  getEntryByRefresh(refreshToken: string): { accessToken: string; entry: TokenEntry } | undefined {
    const accessToken = this.refreshTokens.get(refreshToken)
    if (!accessToken) return undefined
    const entry = this.tokens.get(accessToken)
    if (!entry) return undefined
    return { accessToken, entry }
  }

  /** Replace the Yandex tokens on an entry (after a server-side Yandex refresh). */
  updateYandex(entry: TokenEntry, yandex: YandexTokens): void {
    entry.yandexAccessToken = yandex.accessToken
    entry.yandexRefreshToken = yandex.refreshToken
    entry.yandexExpiresAt = Date.now() + yandex.expiresIn * 1000
  }

  /**
   * Reissue a fresh MCP access+refresh token pair from a presented refresh token
   * (refresh-token rotation). The Yandex tokens are carried over unchanged; the
   * previous MCP access token is invalidated. Returns the new pair + entry.
   */
  reissueFromRefresh(refreshToken: string): { accessToken: string; refreshToken: string; entry: TokenEntry } | undefined {
    const oldAccess = this.refreshTokens.get(refreshToken)
    if (!oldAccess) return undefined
    const oldEntry = this.tokens.get(oldAccess)
    if (!oldEntry) return undefined
    // Rotate: invalidate old access + old refresh.
    this.tokens.delete(oldAccess)
    this.refreshTokens.delete(refreshToken)
    const accessToken = randomToken("mcp_at")
    const fresh = randomToken("mcp_rt")
    const entry: TokenEntry = { ...oldEntry, mcpExpiresAt: Date.now() + MCP_ACCESS_TTL_S * 1000 }
    this.tokens.set(accessToken, entry)
    this.refreshTokens.set(fresh, accessToken)
    return { accessToken, refreshToken: fresh, entry }
  }

  /** Rotate the MCP refresh token (old → new), keeping the access token bound. */
  rotateRefresh(oldRefresh: string): string | undefined {
    const accessToken = this.refreshTokens.get(oldRefresh)
    if (!accessToken) return undefined
    this.refreshTokens.delete(oldRefresh)
    const fresh = randomToken("mcp_rt")
    this.refreshTokens.set(fresh, accessToken)
    return fresh
  }

  /** True if the entry's Yandex token is within the refresh skew of expiry. */
  needsYandexRefresh(entry: TokenEntry, now = Date.now()): boolean {
    return entry.yandexExpiresAt - now <= YANDEX_REFRESH_SKEW_MS
  }
}

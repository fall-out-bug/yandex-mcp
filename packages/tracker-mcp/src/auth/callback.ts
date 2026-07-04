/**
 * Yandex OAuth callback route (GET /auth/yandex/callback).
 *
 * Yandex redirects the user's browser here with `code` + `state` after they
 * approve. We exchange the Yandex code for a Yandex access+refresh token
 * SERVER-SIDE (using the deployer's client_secret), store it against the login
 * state, then resume the MCP authorization by redirecting to the MCP client's
 * original redirect_uri with a one-time MCP authorization code.
 *
 * The Yandex token is obtained here and stays server-side. The MCP client only
 * ever receives the opaque MCP authorization code we mint.
 */
import type { RequestHandler } from "express"
import { TrackerOAuthProvider } from "./provider.js"

/** Build the Yandex callback express route handler bound to a provider. */
export function createYandexCallbackHandler(provider: TrackerOAuthProvider): RequestHandler {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    const code = typeof req.query.code === "string" ? req.query.code : undefined
    const state = typeof req.query.state === "string" ? req.query.state : undefined

    // If Yandex itself reported an error, surface it back to the MCP client.
    const errorCode = typeof req.query.error === "string" ? req.query.error : undefined

    const ctx = state ? provider.store.getLoginState(state) : undefined

    if (!code || !state || !ctx) {
      res.status(400).send("Invalid Yandex callback: missing code/state, or the login session expired.")
      return
    }

    // Propagate a Yandex-side error to the MCP client's redirect target.
    if (errorCode) {
      res.redirect(302, errorRedirect(ctx.mcpRedirectUri, errorCode, req.query.error_description, ctx.mcpState))
      return
    }

    try {
      await provider.exchangeYandexCode(code, state)
    } catch (err) {
      const desc = err instanceof Error ? err.message : "Yandex token exchange failed"
      res.redirect(302, errorRedirect(ctx.mcpRedirectUri, "server_error", desc, ctx.mcpState))
      return
    }

    const mcpCode = provider.store.issueAuthCode(state)
    const target = new URL(ctx.mcpRedirectUri)
    target.searchParams.set("code", mcpCode)
    if (ctx.mcpState) target.searchParams.set("state", ctx.mcpState)
    res.redirect(302, target.href)
  }
}

function errorRedirect(redirectUri: string, error: string, description: unknown, state?: string): string {
  const url = new URL(redirectUri)
  url.searchParams.set("error", error)
  if (typeof description === "string") url.searchParams.set("error_description", description)
  if (state) url.searchParams.set("state", state)
  return url.href
}

/**
 * OAuth route wiring for the standalone profile.
 *
 * Reads the OAuth env vars, builds the provider, mounts the SDK authorization
 * server (mcpAuthRouter: /authorize, /token, /register, /.well-known/...) plus
 * the Yandex callback, and provides the resource-server gate that protects
 * /mcp (401 + RFC 9728 WWW-Authenticate when no valid MCP token is presented).
 */
import type { Express, RequestHandler } from "express"
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js"
import { TrackerOAuthProvider, type TrackerOAuthConfig } from "./provider.js"
import { createYandexCallbackHandler } from "./callback.js"
import { YANDEX_SCOPES } from "./yandex.js"
import { credentialFromYandexToken, type TrackerCredential } from "../credential.js"

/** Path at which the Yandex callback route is mounted. */
export const OAUTH_CALLBACK_PATH = "/auth/yandex/callback"

/** Resource name advertised in protected-resource metadata. */
export const RESOURCE_NAME = "tracker-mcp"

/** Read the standalone-OAuth profile config from env. Returns null when disabled. */
export function readOAuthConfig(env: Record<string, string | undefined> = process.env): TrackerOAuthConfig | null {
  const clientId = env.TRACKER_OAUTH_CLIENT_ID?.trim()
  const clientSecret = env.TRACKER_OAUTH_CLIENT_SECRET?.trim()
  const publicUrlRaw = env.TRACKER_OAUTH_PUBLIC_URL?.trim()
  if (!clientId || !clientSecret || !publicUrlRaw) return null
  let publicUrl: URL
  try {
    publicUrl = new URL(publicUrlRaw)
  } catch {
    return null
  }
  return {
    yandex: { clientId, clientSecret },
    publicUrl,
    callbackPath: OAUTH_CALLBACK_PATH,
    scopes: YANDEX_SCOPES,
  }
}

/** Mount the authorization-server routes and the Yandex callback on an express app. */
export function mountAuthRoutes(app: Express, provider: TrackerOAuthProvider): void {
  const { publicUrl } = provider.oauthConfig
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: publicUrl,
      scopesSupported: provider.scopesSupported,
      resourceName: RESOURCE_NAME,
      // DCR + token + authorize rate limits default; tests disable them via env-free runs.
    }),
  )
  app.get(OAUTH_CALLBACK_PATH, createYandexCallbackHandler(provider))
}

/**
 * Resource-server gate for /mcp. Requires a valid MCP bearer token; on success
 * resolves it to the user's Yandex credential (server-side) and attaches it to
 * the request for the MCP handler to run under (via withCredential). The Yandex
 * token itself never crosses this boundary to the client.
 */
export function createTokenGate(provider: TrackerOAuthProvider): RequestHandler {
  const prmUrl = getOAuthProtectedResourceMetadataUrl(provider.oauthConfig.publicUrl)
  return async (req, res, next) => {
    const header = req.headers.authorization ?? ""
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match) {
      sendUnauthorized(res, prmUrl)
      return
    }
    try {
      const info = await provider.verifyAccessToken(match[1])
      const yandexToken = String(info.extra?.yandexAccessToken ?? "")
      const cred = credentialFromYandexToken(yandexToken)
      if (!cred) {
        sendUnauthorized(res, prmUrl)
        return
      }
      // Attach for the route handler; also set the standard `auth` field the SDK
      // transport reads.
      ;(req as unknown as { auth: typeof info }).auth = info
      ;(req as unknown as { trackerCredential: TrackerCredential }).trackerCredential = cred
      next()
    } catch {
      sendUnauthorized(res, prmUrl)
      return
    }
  }
}

function sendUnauthorized(res: import("express").Response, prmUrl: string): void {
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${prmUrl}"`)
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: "Unauthorized. Start the OAuth flow via the authorization server metadata.",
    },
    id: null,
  })
}

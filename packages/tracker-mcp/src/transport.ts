import http from "node:http"
import express, { type Express, type Request, type Response } from "express"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { credentialFromHeaders, withCredential, type TrackerCredential } from "./credential.js"
import { TrackerOAuthProvider } from "./auth/provider.js"
import { mountAuthRoutes, createTokenGate, readOAuthConfig } from "./auth/router.js"

/** stdio: single-user; the credential comes from env (see getCredential). */
export async function runStdio(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport)
}

function credFromExpressReq(req: Request): TrackerCredential | null {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v)
  }
  return credentialFromHeaders(headers)
}

function corsMiddleware(req: Request, res: Response, next: () => void): void {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, x-org-id, x-cloud-org-id, mcp-session-id",
  )
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
  if (req.method === "OPTIONS") {
    res.status(204).end()
    return
  }
  next()
}

/**
 * Build (but do not listen on) the HTTP express app. Shared by `runHttp` and the
 * in-process tests so both exercise identical wiring.
 *
 * - With an OAuth provider: /mcp is gated by a valid MCP bearer token (resolved
 *   server-side to the user's Yandex credential); the authorization server,
 *   metadata, DCR and Yandex callback routes are mounted.
 * - Without: v0.1 per-request-bearer mode (each request carries Authorization +
 *   X-Org-ID for one user's scope). Kept for the faust-deployed profile.
 */
export function buildHttpApp(serverFactory: () => McpServer, opts: { oauth?: TrackerOAuthProvider } = {}): Express {
  const app = express()
  app.use(corsMiddleware)

  if (opts.oauth) {
    mountAuthRoutes(app, opts.oauth)
    const gate = createTokenGate(opts.oauth)
    app.post("/mcp", express.json(), gate, mcpHandler(serverFactory, "oauth"))
  } else {
    app.post("/mcp", express.json(), mcpHandler(serverFactory, "bearer"))
  }

  app.use((_req, res) => {
    res.status(404).send("Not found. POST JSON-RPC to /mcp.")
  })
  return app
}

/**
 * Per-request MCP handler: build a fresh stateless server+transport and run the
 * request inside the resolved user-credential scope. In OAuth mode the credential
 * was resolved by the gate; in bearer mode it comes from the request headers.
 */
function mcpHandler(serverFactory: () => McpServer, mode: "oauth" | "bearer") {
  return async (req: Request, res: Response): Promise<void> => {
    const cred: TrackerCredential | null =
      mode === "oauth"
        ? (req as unknown as { trackerCredential?: TrackerCredential }).trackerCredential ?? null
        : credFromExpressReq(req)

    if (!cred) {
      // Bearer mode only: OAuth mode is gated upstream and always has a credential.
      res.setHeader("WWW-Authenticate", "Bearer")
      res.status(401).send("Missing credential. Send 'Authorization: OAuth <token>' (or Bearer) and 'X-Org-ID' headers.")
      return
    }

    const srv = serverFactory()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await srv.connect(transport)
      await withCredential(cred, () => transport.handleRequest(req, res, req.body))
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).send(`MCP handling error: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      await srv.close().catch(() => undefined)
    }
  }
}

/**
 * HTTP transport entrypoint. In OAuth mode the standalone profile is active
 * (own AS + per-user Yandex tokens kept server-side); otherwise v0.1 bearer mode.
 */
export async function runHttp(serverFactory: () => McpServer): Promise<void> {
  const port = Number(process.env.MCP_HTTP_PORT ?? "3009")
  const oauthEnv = readOAuthConfig()
  const oauth = oauthEnv ? new TrackerOAuthProvider(oauthEnv) : undefined

  const app = buildHttpApp(serverFactory, { oauth })
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(port, resolve))
  process.stderr.write(
    oauth
      ? `[tracker-mcp] HTTP (OAuth standalone) listening on http://127.0.0.1:${port}/mcp\n`
      : `[tracker-mcp] HTTP (multi-user bearer) listening on http://127.0.0.1:${port}/mcp\n`,
  )
}

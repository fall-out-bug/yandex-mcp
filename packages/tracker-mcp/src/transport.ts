import http from "node:http"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { credentialFromHeaders, withCredential, type TrackerCredential } from "./credential.js"

/** stdio: single-user; the credential comes from env (see getCredential). */
export async function runStdio(server: McpServer, transport: Transport): Promise<void> {
  await server.connect(transport)
}

function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers.set(key, value)
  }
  return headers
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => resolve(data))
    req.on("error", reject)
  })
}

/**
 * Stateless HTTP transport for ORG / multi-user use. Each request is isolated:
 * a fresh server+transport is built per request, and the credential is taken
 * from the request's Authorization + X-Org-ID headers — i.e. the calling user's
 * own scope. No token is stored.
 */
export async function runHttp(serverFactory: () => McpServer): Promise<void> {
  const port = Number(process.env.MCP_HTTP_PORT ?? "3009")
  const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-org-id, x-cloud-org-id, mcp-session-id")
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS")
    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(404)
      res.end("Not found. POST JSON-RPC to /mcp.")
      return
    }

    const cred: TrackerCredential | null = credentialFromHeaders(toHeaders(req.headers))
    if (!cred) {
      res.writeHead(401)
      res.end("Missing credential. Send 'Authorization: OAuth <token>' (or Bearer) and 'X-Org-ID' headers.")
      return
    }

    const body = await readBody(req)
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(body)
    } catch {
      res.writeHead(400)
      res.end("Invalid JSON body")
      return
    }

    const srv = serverFactory()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    try {
      await srv.connect(transport)
      // Run the whole request inside the user's credential scope.
      await withCredential(cred, () => transport.handleRequest(req, res, parsed))
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500)
        res.end(`MCP handling error: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      await srv.close().catch(() => undefined)
    }
  })

  await new Promise<void>((resolve) => httpServer.listen(port, resolve))
  process.stderr.write(`[tracker-mcp] HTTP (multi-user) listening on http://127.0.0.1:${port}/mcp\n`)
}

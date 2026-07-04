/**
 * End-to-end OAuth dance for the standalone profile, driven in-process.
 *
 * All Yandex and Tracker HTTP is MOCKED (no live network). The express app is
 * the same `buildHttpApp` used by `runHttp`. The test proves:
 *   - unauthenticated /mcp -> 401 + WWW-Authenticate;
 *   - DCR -> authorize -> Yandex redirect -> callback -> MCP token issued;
 *   - an authenticated /mcp tool call resolves the MCP token to the user's
 *     Yandex token SERVER-SIDE and calls Tracker with it;
 *   - the Yandex token NEVER reaches the MCP client (no passthrough).
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createHash, randomBytes } from "node:crypto"
import { buildHttpApp } from "../src/transport.js"
import { createServer } from "../src/server.js"
import { TrackerOAuthProvider } from "../src/auth/provider.js"
import { OAUTH_CALLBACK_PATH } from "../src/auth/router.js"

// --- Mocked upstream secrets. These must NEVER be visible to the MCP client. ---
const YANDEX_ACCESS = "ya-access-SECRET-123456"
const YANDEX_REFRESH = "ya-refresh-SECRET-7890"
const YANDEX_CODE = "yandex-auth-code-abc"
const ORG_ID = "bpfd8mfc069c147a91r9"

const originalFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

let server: Server | undefined
let base = ""
let capturedTrackerAuth: string | undefined
/** Everything the MCP client (this test, acting as the client) observes. */
const clientVisible: string[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeAll(() => {
  for (const k of ["TRACKER_ORG_ID", "TRACKER_ORG_HEADER", "TRACKER_BASE_URL", "TRACKER_TOKEN"]) {
    savedEnv[k] = process.env[k]
  }
  process.env.TRACKER_ORG_ID = ORG_ID
  process.env.TRACKER_ORG_HEADER = "X-Cloud-Org-Id"
  // Ensure the per-request env-token path can't accidentally satisfy a credential.
  delete process.env.TRACKER_TOKEN

  // Routing fetch mock: Yandex + Tracker are mocked; everything else (the
  // loopback express server) hits the real network.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith("https://oauth.yandex.ru/token")) {
      const body = String(init?.body ?? "")
      if (body.includes("grant_type=authorization_code")) {
        return json({ access_token: YANDEX_ACCESS, refresh_token: YANDEX_REFRESH, expires_in: 3600, token_type: "bearer" })
      }
      return json({ access_token: `${YANDEX_ACCESS}-refreshed`, refresh_token: `${YANDEX_REFRESH}-2`, expires_in: 3600, token_type: "bearer" })
    }
    if (url.includes("api.tracker.yandex.net")) {
      const h = init?.headers as Record<string, string> | undefined
      const auth = h?.Authorization ?? h?.authorization
      capturedTrackerAuth = Array.isArray(auth) ? auth[0] : auth
      return json({ uid: "u1", login: "alice", display: "Alice", email: "alice@example.com" })
    }
    return originalFetch(input as RequestInfo | URL, init)
  }) as typeof fetch

  // The publicUrl is only used to (a) advertise metadata and (b) build the
  // Yandex redirect_uri sent to MOCKED Yandex — its exact value is irrelevant
  // here; all endpoints are hit directly at the real loopback base.
  const provider = new TrackerOAuthProvider({
    yandex: { clientId: "ya-client-id", clientSecret: "ya-client-secret" },
    publicUrl: new URL("http://localhost:9999"),
    callbackPath: OAUTH_CALLBACK_PATH,
  })
  const app = buildHttpApp(createServer, { oauth: provider })
  server = app.listen(0) as unknown as Server
  const addr = server.address() as AddressInfo
  base = `http://localhost:${addr.port}`
})

afterAll(() => {
  globalThis.fetch = originalFetch
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  server?.close()
})

function remember(s: string | null | undefined): string {
  const v = s ?? ""
  clientVisible.push(v)
  return v
}

/** Extract the JSON-RPC message from a Streamable-HTTP SSE response body. */
function parseSseMessage(text: string): Record<string, unknown> {
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice(5).trim()) as Record<string, unknown>
    }
  }
  throw new Error(`No SSE data line found in response: ${text.slice(0, 200)}`)
}

test("unauthenticated /mcp is rejected with 401 + WWW-Authenticate", async () => {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
  })
  expect(res.status).toBe(401)
  expect(remember(res.headers.get("www-authenticate"))).toContain("Bearer")
  expect(remember(await res.text())).not.toContain(YANDEX_ACCESS)
})

test("authorization-server metadata is advertised", async () => {
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`)
  expect(res.status).toBe(200)
  const meta = await res.json()
  remember(JSON.stringify(meta))
  expect(meta.issuer).toBeDefined()
  expect(meta.authorization_endpoint).toContain("/authorize")
  expect(meta.token_endpoint).toContain("/token")
})

test("full OAuth dance issues an opaque MCP token (no Yandex token to client)", async () => {
  // 1. Dynamic client registration.
  const regRes = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["http://localhost:3000/cb"],
      token_endpoint_auth_method: "client_secret_post",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "test-mcp-client",
    }),
  })
  expect(regRes.status).toBe(201)
  const client = (await regRes.json()) as { client_id: string; client_secret: string }
  remember(JSON.stringify(client))
  expect(client.client_id).toBeTruthy()
  expect(client.client_secret).toBeTruthy()

  // 2. MCP-client PKCE pair (leg A: client <-> our AS).
  const verifier = randomBytes(40).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  const mcpState = "client-state-xyz"

  // 3. Authorize: our AS redirects the browser to Yandex.
  const authUrl = `${base}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://localhost:3000/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "cloud:auth tracker:read tracker:write",
    state: mcpState,
  })}`
  const authRes = await fetch(authUrl, { redirect: "manual" })
  expect(authRes.status).toBe(302)
  const location = remember(authRes.headers.get("location"))!
  expect(location).toContain("https://oauth.yandex.ru/authorize")
  const yandexRedirect = new URL(location)
  expect(yandexRedirect.searchParams.get("client_id")).toBe("ya-client-id")
  expect(yandexRedirect.searchParams.get("scope")).toContain("cloud:auth")
  const loginState = yandexRedirect.searchParams.get("state")!
  expect(loginState).toBeTruthy()

  // 4. Simulate the user returning from Yandex. Our callback exchanges the
  //    Yandex code SERVER-SIDE (mocked) and redirects to the MCP client with an
  //    opaque MCP authorization code.
  const cbRes = await fetch(`${base}${OAUTH_CALLBACK_PATH}?${new URLSearchParams({ code: YANDEX_CODE, state: loginState })}`, {
    redirect: "manual",
  })
  expect(cbRes.status).toBe(302)
  const cbLocation = remember(cbRes.headers.get("location"))!
  const cbUrl = new URL(cbLocation)
  expect(`${cbUrl.origin}${cbUrl.pathname}`).toBe("http://localhost:3000/cb")
  expect(cbUrl.searchParams.get("state")).toBe(mcpState)
  const mcpCode = cbUrl.searchParams.get("code")!
  expect(mcpCode).toMatch(/^mcp_code_/)

  // 5. Exchange the MCP code for an MCP access token. PKCE is validated by the SDK.
  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: mcpCode,
      code_verifier: verifier,
      redirect_uri: "http://localhost:3000/cb",
      client_id: client.client_id,
      client_secret: client.client_secret,
    }),
  })
  expect(tokenRes.status).toBe(200)
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; token_type: string }
  remember(JSON.stringify(tokens))
  const mcpAccessToken = tokens.access_token
  expect(mcpAccessToken).toMatch(/^mcp_at_/)
  expect(mcpAccessToken).not.toContain(YANDEX_ACCESS)
  expect(tokens.refresh_token).toMatch(/^mcp_rt_/)
  expect(tokens.token_type).toBe("bearer")

  // Stash for the next test (bun runs tests in order within a file).
  ;(globalThis as unknown as { __mcpAccessToken: string }).__mcpAccessToken = mcpAccessToken
})

test("authenticated /mcp tool call resolves to the user's Yandex token server-side", async () => {
  const mcpAccessToken = (globalThis as unknown as { __mcpAccessToken: string }).__mcpAccessToken
  expect(mcpAccessToken).toMatch(/^mcp_at_/)

  capturedTrackerAuth = undefined
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpAccessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_myself", arguments: {} } }),
  })
  expect(res.status).toBe(200)
  const raw = remember(await res.text())
  const body = parseSseMessage(raw) as { result?: { content?: Array<{ text?: string }> } }
  const text = body.result?.content?.[0]?.text ?? ""
  expect(text).toContain("Alice")

  // The server used the user's Yandex token to call Tracker (server-side only).
  expect(capturedTrackerAuth).toBe(`OAuth ${YANDEX_ACCESS}`)
  // ...and that token never crossed into the client-visible response.
  expect(text).not.toContain(YANDEX_ACCESS)
  expect(raw).not.toContain(YANDEX_ACCESS)
})

test("no Yandex token ever reached the MCP client (no passthrough)", () => {
  const everything = clientVisible.join("\n")
  expect(everything).not.toContain(YANDEX_ACCESS)
  expect(everything).not.toContain(YANDEX_REFRESH)
})

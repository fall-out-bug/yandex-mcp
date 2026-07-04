/**
 * One-off dev helper: run the Yandex OAuth authorization-code flow locally and
 * print an access token. Used to obtain a real per-user Tracker token for
 * testing (e.g. to resolve whether X-Org-ID is required).
 *
 * Usage:
 *   1. In your Yandex OAuth app, add this exact Redirect URI:
 *        http://localhost:8787/callback
 *   2. CLIENT_ID=... CLIENT_SECRET=... bun run scripts/fetch-token.ts
 *   3. Open the printed authorize URL in a browser, approve.
 *   4. The script prints the access_token (and refresh_token). Paste NEITHER
 *      into chat — use them locally.
 *
 * Env: CLIENT_ID, CLIENT_SECRET, PORT (default 8787),
 *      SCOPES (default "tracker:read tracker:write").
 */
import http from "node:http"

const CLIENT_ID = process.env.CLIENT_ID ?? ""
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? ""
const PORT = Number(process.env.PORT ?? 8787)
const SCOPES = process.env.SCOPES ?? "cloud:auth tracker:read tracker:write"
const REDIRECT_URI = `http://localhost:${PORT}/callback`

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set CLIENT_ID and CLIENT_SECRET env vars.")
  process.exit(1)
}

const authorizeUrl = new URL("https://oauth.yandex.ru/authorize")
authorizeUrl.searchParams.set("response_type", "code")
authorizeUrl.searchParams.set("client_id", CLIENT_ID)
authorizeUrl.searchParams.set("redirect_uri", REDIRECT_URI)
authorizeUrl.searchParams.set("scope", SCOPES)
authorizeUrl.searchParams.set("force_confirm", "yes")

console.log("\n1) Open this URL in your browser and approve:\n")
console.log(authorizeUrl.toString())
console.log("\n2) Waiting for the callback on " + REDIRECT_URI + " ...\n")

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)
  if (url.pathname !== "/callback") {
    res.writeHead(404)
    res.end("not found")
    return
  }
  const code = url.searchParams.get("code")
  const error = url.searchParams.get("error")
  if (error || !code) {
    res.writeHead(400)
    res.end("No code returned: " + (error ?? url.search))
    console.error("Failed:", error ?? url.search)
    server.close()
    return
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
  })
  const tokenResp = await fetch("https://oauth.yandex.ru/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })
  const text = await tokenResp.text()
  if (!tokenResp.ok) {
    res.writeHead(502)
    res.end("Token exchange failed: " + text)
    console.error("Token exchange failed:", tokenResp.status, text)
    server.close()
    return
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  res.end("<h1>OK — token printed to terminal. You can close this tab.</h1>")
  console.log("=== TOKEN RESPONSE (do NOT paste into chat) ===")
  console.log(text)
  console.log("=================================================")
  console.log("\naccess_token is the value to use locally as TRACKER_TOKEN / Authorization: OAuth <...>.")
  server.close()
})

server.listen(PORT)

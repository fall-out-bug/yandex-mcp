# @yandex-mcp/tracker-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
[Yandex Tracker](https://yandex.ru/support/tracker/en/api-ref/about-api) (v3 API)
that acts **within a single user's scope**. The credential presented per call
defines what the agent can see.

The server supports three credential modes (see below). In the **standalone
OAuth profile** it runs its own authorization server: each connecting user
authorizes via Yandex, and the server keeps their Yandex token server-side,
issuing its own opaque MCP tokens to the host. The Yandex token **never**
reaches the MCP client or the LLM (no token passthrough — an MCP-spec
requirement).

## Why

Other Yandex Tracker MCP servers take one org-wide token and expose everything
it can see. That works for one developer but is wrong for an organization: one
credential must not gate everyone's data. This server is a stateless resource
layer — your application obtains per-user tokens and hands them to the server
per call.

## Two modes

| Mode | Transport | Credential | Use case |
| --- | --- | --- | --- |
| single-user | `stdio` | `TRACKER_TOKEN` + `TRACKER_ORG_ID` env | local clients (Claude Desktop, Cursor) |
| **multi-user** | `http` | per-request `Authorization` + `X-Org-ID` headers | org / server runtime (each request = one user's scope) |
| **standalone OAuth** | `http` | server-issued MCP token → server-side Yandex token | "connect → authorize → use" for any MCP host (OpenCode, Claude Desktop, Cursor) |

## Get a Tracker token (once, per user)

1. Create an OAuth app at <https://oauth.yandex.ru/>. Required scopes:
   - **`cloud:auth`** — mandatory for **Cloud organizations** (without it Tracker
     returns `401 authorization-required` even with the tracker scopes; with it,
     direct OAuth works — no IAM exchange needed).
   - **`tracker:read`** and **`tracker:write`**.
   Note the Client ID.
2. Authorize in the browser (implicit flow):
   `https://oauth.yandex.com/authorize?response_type=token&client_id=YOUR_CLIENT_ID&scope=cloud:auth%20tracker:read%20tracker:write`
3. Copy the `access_token` from the redirect.
4. Find your org id and which header it needs. **Cloud orgs** use
   `X-Cloud-Org-Id`; **Yandex 360 orgs** use `X-Org-Id`. The id is the same
   value either way. Tip: open Tracker in a browser, DevTools → Network → look
   at the `X-Org-Id`/`X-Cloud-Org-Id` request header the UI sends.

> Note: for federated Cloud users, the OAuth→IAM token exchange is **not
> supported** by Yandex (tokens after 2026-06-01). Use direct OAuth (the
> `OAuth` scheme), not the IAM `Bearer` scheme. Set `TRACKER_ORG_HEADER` and
> `TRACKER_ORG_ID` accordingly.

## Install & run

```bash
cd packages/tracker-mcp
bun install        # or npm install
bun run build      # -> dist/
```

### stdio (single-user) — Claude Desktop / Cursor

`.env` (or pass via the host's `env`):

```
TRACKER_TOKEN=...
TRACKER_ORG_ID=...
```

Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tracker": {
      "command": "node",
      "args": ["/absolute/path/to/tracker-mcp/dist/index.js"],
      "env": { "TRACKER_TOKEN": "...", "TRACKER_ORG_ID": "..." }
    }
  }
}
```

### http (multi-user / server runtime)

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=3009 node dist/index.js
```

POST JSON-RPC to `http://127.0.0.1:3009/mcp` with:

```
Authorization: OAuth <user-token>
X-Org-ID: <org-id>            # or X-Cloud-Org-ID for Yandex Cloud orgs
Content-Type: application/json
```

Each request is isolated (stateless) and runs inside the calling user's scope.

## Standalone OAuth profile (connect → authorize → use)

This is the Vercel-style mode. tracker-mcp runs its **own MCP authorization
server** and acts as an OAuth client of Yandex. Each user authorizes once in
their browser; tracker-mcp obtains their Yandex token, keeps it **server-side**,
and issues its own opaque MCP tokens to the host. Tool calls resolve the MCP
token back to that user's Yandex token and call Tracker as them. **The Yandex
token never reaches the MCP client / LLM** (no passthrough).

### Why

MCP forbids token passthrough: the token used at the upstream API must be a
separate token, issued and held by the server. This profile implements that
correctly — per-user, actions attributed to the user's Yandex identity in
Tracker.

### Setup

1. Create a Yandex OAuth app at <https://oauth.yandex.ru/> (you only need the
   app's `client_id` / `client_secret`; tracker-mcp never creates one). Register
   the redirect URI:
   `https://<your-public-host>/auth/yandex/callback`
2. Run the server with the three OAuth env vars set (and still reachable at that
   public HTTPS URL — see *Local dev with a tunnel* below):

   ```bash
   MCP_TRANSPORT=http \
   TRACKER_OAUTH_PUBLIC_URL=https://your-public-host.example \
   TRACKER_OAUTH_CLIENT_ID=... \
   TRACKER_OAUTH_CLIENT_SECRET=... \
   TRACKER_ORG_ID=... TRACKER_ORG_HEADER=X-Cloud-Org-ID \
   node dist/index.js
   ```

3. In your MCP host, add the server's public URL (`https://your-host/mcp`) and
   run its OAuth/connect flow (e.g. `opencode mcp auth <server>`). The host
   discovers `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`,
   registers dynamically, and opens a browser for the user to approve with Yandex.

Scopes requested from Yandex: `cloud:auth tracker:read tracker:write`
(`cloud:auth` is the one that unblocks Cloud-org Tracker access — no IAM
exchange).

### Local dev with a tunnel

The OAuth flow needs tracker-mcp reachable at a **public HTTPS URL** so Yandex
can redirect back to `/auth/yandex/callback`. For local dev, expose it with a
tunnel and set `TRACKER_OAUTH_PUBLIC_URL` to the tunnel URL:

```bash
# terminal 1: tunnel :3009 to a public HTTPS URL
cloudflared tunnel --url http://localhost:3009   # or: ngrok http 3009
# terminal 2: run the server with the tunnel URL as the public URL
TRACKER_OAUTH_PUBLIC_URL=https://<tunnel-host> ... node dist/index.js
```

### Manual live-Yandex gate

The automated test suite (`bun run test`) drives the **entire** OAuth dance
in-process with Yandex and Tracker **mocked** — it proves the wiring, the token
mapping, and the no-passthrough guarantee, but not a real Yandex round-trip.
Once deployed, **run this once by hand** to verify against live Yandex:

1. Start the server with real `TRACKER_OAUTH_CLIENT_ID` / `_SECRET` and a public
   `TRACKER_OAUTH_PUBLIC_URL`.
2. Connect from an MCP host (e.g. `opencode mcp auth <server>`), approve in the
   browser as a real Yandex user.
3. Call the `get_myself` tool: it must return *that user's* Tracker identity.

### Notes & limitations (v0.2)

- The token store is **in-memory**: Yandex tokens are lost on restart, so users
  re-authorize after a restart. Persistent storage is a follow-up.
- MCP access tokens are short-lived and rotated via refresh tokens; Yandex
  tokens are refreshed server-side as needed.

## Tools

| Tool | Class | Description |
| --- | --- | --- |
| `get_myself` | read | Confirm the credential; see who you act as |
| `get_issue` | read | One issue by key |
| `search_issues` | read | Tracker query language; opaque cursor pagination |
| `create_issue` | write | Create (queue + summary required) |
| `add_comment` | write | Comment on an issue |
| `list_transitions` | read | Available status transitions for an issue |
| `execute_transition` | write | Apply a transition (close / reopen / …) |

Errors are translated into actionable messages (auth expired, rate limited,
wrong org header, not found, …) — never raw HTTP bodies.

## Safety boundary

This server is **not** a safety boundary. It executes Tracker operations inside
the presented user scope. Confirmation gates, product-level audit, and rate
budgets belong to the calling product.

## License

MIT.

# @yandex-mcp/tracker-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for
[Yandex Tracker](https://yandex.ru/support/tracker/en/api-ref/about-api) (v3 API)
that acts **within a single user's scope**. The credential presented per call
defines what the agent can see — the server stores no tokens and creates no
OAuth apps.

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

## Get a Tracker token (once, per user)

1. Create an OAuth app at <https://oauth.yandex.ru/> with scopes
   **`tracker:read`** and **`tracker:write`** (note the Client ID).
2. Authorize in the browser (implicit flow):
   `https://oauth.yandex.com/authorize?response_type=token&client_id=YOUR_CLIENT_ID`
3. Copy the `access_token` from the redirect.
4. Find your org id under Tracker → Administration → Organisations.

> In multi-user mode your application performs this flow per user and passes
> the resulting token per request. This server never runs it.

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
